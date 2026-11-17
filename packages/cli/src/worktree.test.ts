// The worktree a checkout adds, when git fails or does not finish in time: stopped, and removed by its exact path.
// Real git against fixture repositories (src/test/git.ts), the git under test given the fixtures' environment; a slow
// or a failing git is a script in git's place.

import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliError } from "./errors.ts";
import { Git, GitTimeout } from "./git.ts";
import { fixtureRoot, liveProcesses, makeRepo, type Repo, slowFilter } from "./test/git.ts";
import { addWorktree, removeWorktree } from "./worktree.ts";

const pr = { owner: "acme", repo: "widgets", number: 7 };

let dir: string;
let repo: Repo;

beforeEach(async () => {
  dir = await fixtureRoot("prq-worktree-");
  repo = await makeRepo(dir, pr);
});

afterEach(async () => {
  // A filter a failing test left running.
  for (const pid of await liveProcesses(join(dir, "filter-pids"))) {
    process.kill(pid, "SIGKILL");
  }
  await rm(dir, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

// What must stay in the clone: every ref, and its other worktrees.
async function clone() {
  return {
    refs: await repo.clone.refs(),
    worktrees: await repo.clone.worktreeList(),
  };
}

// A module of this package, as an import specifier a script elsewhere can use.
function source(name: string): string {
  return JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
}

// A script in git's place: body for a worktree add, real git for anything else.
async function fakeGit(name: string, body: string): Promise<Git> {
  const script = join(dir, name);
  await writeFile(script, `#!/bin/sh\ncase "$*" in\n*" worktree add "*) ${body} ;;\n*) exec git "$@" ;;\nesac\n`);
  await chmod(script, 0o755);
  return Git.create(join(dir, "hooks"), { binary: script, env: repo.fixture.env });
}

describe("addWorktree", () => {
  it("a worktree add that does not finish in time is stopped, and its worktree removed by its exact path", async () => {
    await repo.clone.worktreeAdd("host-worktree", repo.base);
    const before = await clone();
    const git = await fakeGit("slow-git", 'git "$@"; exec sleep 30');
    const path = join(dir, "job", "worktree");
    await mkdir(join(dir, "job"));

    await expect(addWorktree(git, repo.clone.path, path, repo.base, 1_000)).rejects.toEqual(
      new GitTimeout("worktree add", 1_000),
    );
    expect(await exists(path)).toBe(false);
    expect(await clone()).toEqual(before);
  });

  it("a worktree add stopped in time stops the filters git runs as well", async () => {
    const { files, pids } = await slowFilter(repo);
    const head = await repo.head("filtered", files);
    await repo.clone.fetchPull(pr.number);
    const before = await clone();
    const git = await Git.create(join(dir, "hooks"), { env: repo.fixture.env });
    const path = join(dir, "job", "worktree");
    await mkdir(join(dir, "job"));

    const started = Date.now();
    await expect(addWorktree(git, repo.clone.path, path, head, 1_500)).rejects.toEqual(
      new GitTimeout("worktree add", 1_500),
    );
    // Well before the filter's sleep ends, and without waiting for the grace before SIGKILL.
    expect(Date.now() - started).toBeLessThan(4_500);
    await vi.waitFor(async () => expect(await liveProcesses(pids)).toEqual([]), { timeout: 3_000 });
    expect(await exists(path)).toBe(false);
    expect(await clone()).toEqual(before);
  }, 60_000);

  it("the same under Bun, the runtime prq is compiled with", async () => {
    const { files, pids } = await slowFilter(repo);
    const head = await repo.head("filtered", files);
    await repo.clone.fetchPull(pr.number);
    const before = await clone();
    const path = join(dir, "job", "worktree");
    await mkdir(join(dir, "job"));
    const driver = join(dir, "driver.ts");
    await writeFile(
      driver,
      [
        `import { Git } from ${source("./git.ts")};`,
        `import { addWorktree } from ${source("./worktree.ts")};`,
        "const [hooks, clone, path, sha] = process.argv.slice(2);",
        "const git = await Git.create(hooks, { env: process.env });",
        "const started = Date.now();",
        "const error = await addWorktree(git, clone, path, sha, 1_500).then(() => null, (failure) => failure.message);",
        "console.log(JSON.stringify({ bun: typeof Bun !== 'undefined', elapsedMs: Date.now() - started, error }));",
        "",
      ].join("\n"),
    );

    const { stdout } = await promisify(execFile)("bun", [driver, join(dir, "hooks"), repo.clone.path, path, head], {
      cwd: dir,
      env: repo.fixture.env,
    });
    const outcome = v.parse(
      v.object({ bun: v.boolean(), elapsedMs: v.number(), error: v.nullable(v.string()) }),
      JSON.parse(stdout),
    );
    expect(outcome).toEqual({
      bun: true,
      elapsedMs: expect.any(Number),
      error: new GitTimeout("worktree add", 1_500).message,
    });
    expect(outcome.elapsedMs).toBeLessThan(4_500);
    await vi.waitFor(async () => expect(await liveProcesses(pids)).toEqual([]), { timeout: 3_000 });
    expect(await exists(path)).toBe(false);
    expect(await clone()).toEqual(before);
  }, 60_000);

  it("a worktree add that fails leaves nothing behind", async () => {
    const before = await clone();
    const git = await Git.create(join(dir, "hooks"), { env: repo.fixture.env });
    const path = join(dir, "job", "worktree");
    await mkdir(join(dir, "job"));

    const failed = addWorktree(git, repo.clone.path, path, "f".repeat(40));
    await expect(failed).rejects.toBeInstanceOf(CliError);
    await expect(failed).rejects.toThrow(/^git worktree add failed: fatal: /);
    expect(await exists(path)).toBe(false);
    expect(await clone()).toEqual(before);
  });

  it("a worktree add that fails after writing into its directory: the directory is removed", async () => {
    const before = await clone();
    const path = join(dir, "job", "worktree");
    await mkdir(join(dir, "job"));
    // A git ended before it cleaned up: the directory and a file in it, and no registration.
    const git = await fakeGit("partial-git", `mkdir -p '${path}' && touch '${path}/partial' && exit 128`);

    await expect(addWorktree(git, repo.clone.path, path, repo.base)).rejects.toThrow(/^git worktree add failed/);
    expect(await exists(path)).toBe(false);
    expect(await exists(join(dir, "job"))).toBe(true);
    expect(await clone()).toEqual(before);
  });
});

describe("removeWorktree", () => {
  it("removes a locked worktree by its exact path, and nothing else", async () => {
    const other = (await repo.clone.worktreeAdd("host-worktree", repo.base)).path;
    const path = (await repo.clone.worktreeAdd(join("job", "worktree"), repo.base)).path;
    // A worktree add that was stopped leaves its worktree locked.
    await repo.clone.worktreeLock(join("job", "worktree"));
    const refs = await repo.clone.refs();
    const git = await Git.create(join(dir, "hooks"), { env: repo.fixture.env });

    expect(await removeWorktree(git, repo.clone.path, path)).toBe(true);
    expect(await exists(path)).toBe(false);
    const listed = await repo.clone.worktreeList();
    expect(listed).not.toContain(path);
    expect(listed).toContain(`worktree ${other}`);
    expect(await exists(join(other, "README.md"))).toBe(true);
    expect(await repo.clone.refs()).toBe(refs);
  });
});
