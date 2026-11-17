// The worktree a checkout adds, when git fails or does not finish in time: stopped, and removed by its exact path.
// Real git against fixture repositories (src/test/git.ts), the git under test given the fixtures' environment; a slow
// or a failing git is a script in git's place.

import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "./errors.ts";
import { Git, GitTimeout } from "./git.ts";
import { fixtureRoot, makeRepo, type Repo } from "./test/git.ts";
import { addWorktree, removeWorktree } from "./worktree.ts";

const pr = { owner: "acme", repo: "widgets", number: 7 };

let dir: string;
let repo: Repo;

beforeEach(async () => {
  dir = await fixtureRoot("prq-worktree-");
  repo = await makeRepo(dir, pr);
});

afterEach(async () => {
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
    refs: await repo.git(repo.clone, "for-each-ref", "--format=%(refname) %(objectname)"),
    worktrees: await repo.git(repo.clone, "worktree", "list", "--porcelain"),
  };
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
    await repo.git(repo.clone, "worktree", "add", "--quiet", "--detach", join(dir, "host-worktree"), repo.base);
    const before = await clone();
    const git = await fakeGit("slow-git", 'git "$@"; exec sleep 30');
    const path = join(dir, "job", "worktree");
    await mkdir(join(dir, "job"));

    await expect(addWorktree(git, repo.clone, path, repo.base, 1_000)).rejects.toEqual(
      new GitTimeout("worktree add", 1_000),
    );
    expect(await exists(path)).toBe(false);
    expect(await clone()).toEqual(before);
  });

  it("a worktree add that fails leaves nothing behind", async () => {
    const before = await clone();
    const git = await Git.create(join(dir, "hooks"), { env: repo.fixture.env });
    const path = join(dir, "job", "worktree");
    await mkdir(join(dir, "job"));

    const failed = addWorktree(git, repo.clone, path, "f".repeat(40));
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

    await expect(addWorktree(git, repo.clone, path, repo.base)).rejects.toThrow(/^git worktree add failed/);
    expect(await exists(path)).toBe(false);
    expect(await exists(join(dir, "job"))).toBe(true);
    expect(await clone()).toEqual(before);
  });
});

describe("removeWorktree", () => {
  it("removes a locked worktree by its exact path, and nothing else", async () => {
    const other = join(dir, "host-worktree");
    await repo.git(repo.clone, "worktree", "add", "--quiet", "--detach", other, repo.base);
    const path = join(dir, "job", "worktree");
    await repo.git(repo.clone, "worktree", "add", "--quiet", "--detach", path, repo.base);
    // A worktree add that was stopped leaves its worktree locked.
    await repo.git(repo.clone, "worktree", "lock", path);
    const refs = await repo.git(repo.clone, "for-each-ref", "--format=%(refname) %(objectname)");
    const git = await Git.create(join(dir, "hooks"), { env: repo.fixture.env });

    expect(await removeWorktree(git, repo.clone, path)).toBe(true);
    expect(await exists(path)).toBe(false);
    const listed = await repo.git(repo.clone, "worktree", "list", "--porcelain");
    expect(listed).not.toContain(path);
    expect(listed).toContain(`worktree ${other}`);
    expect(await exists(join(other, "README.md"))).toBe(true);
    expect(await repo.git(repo.clone, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refs);
  });
});
