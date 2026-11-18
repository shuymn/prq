import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { ClaimResponse } from "@prq/protocol";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { result, stderrLines } from "../test/cli.ts";
import { type FixtureRepo, liveProcesses, makeRepo, type Repo, slowFilter } from "../test/git.ts";
import { ask, push, retry, sha } from "../test/pr.ts";
import { useStack } from "../test/stack.ts";

const stack = useStack();
const pr = { owner: "acme", repo: "widgets", number: 7 };

// A filter a failing test left running.
afterEach(async () => {
  for (const pid of await liveProcesses(join(stack.dir(), "filter-pids"))) {
    process.kill(pid, "SIGKILL");
  }
});

const Claimed = v.object({ ...ClaimResponse.options[0].entries, dir: v.string(), answer: v.string() });
const CheckedOut = v.object({
  path: v.string(),
  sha: v.string(),
  base: v.nullable(v.string()),
  clone: v.string(),
  next: v.literal("answer"),
});

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

// The repository or worktree at a path in the fixture root, such as the worktree prq added.
function at(repo: Repo, path: string): FixtureRepo {
  return repo.fixture.repo(relative(repo.fixture.root, path));
}

// What a checkout must leave as it was in the host's clone: every ref with its commit (a submodule's too), HEAD,
// FETCH_HEAD, and the worktrees it registers.
async function hostState(repo: Repo) {
  const fetchHead = join(repo.clone.path, ".git", "FETCH_HEAD");
  const lib = repo.fixture.repo(join(repo.clone.name, "lib"));
  return {
    refs: await repo.clone.refs(),
    submoduleRefs: (await exists(lib.path)) ? await lib.refs() : null,
    head: await repo.clone.branch(),
    fetchHead: (await exists(fetchHead)) ? await readFile(fetchHead, "utf8") : null,
    worktrees: await repo.clone.worktrees(),
  };
}

// Every entry under dir with its type and content (a symlink's target): what a write anywhere in it would change.
async function digest(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const lines = await Promise.all(
    entries.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      if (entry.isSymbolicLink()) {
        return `${relative(dir, path)} -> ${await readlink(path)}`;
      }
      if (entry.isFile()) {
        return `${relative(dir, path)} ${createHash("sha256")
          .update(await readFile(path))
          .digest("hex")}`;
      }
      return `${relative(dir, path)}/`;
    }),
  );
  return lines.toSorted();
}

// A submodule in the host's clone, whose own remote then moves on: a fetch that recursed would update its refs.
async function addSubmodule(repo: Repo): Promise<void> {
  const lib = await repo.fixture.init("lib.git", { bare: true });
  const libSeed = await repo.fixture.init("lib-seed");
  await libSeed.commit("lib", { allowEmpty: true });
  await libSeed.push(lib, "HEAD:refs/heads/main");
  await repo.clone.submoduleAdd(lib, "lib");
  await repo.clone.commit("add lib");
  await libSeed.commit("lib moves on", { allowEmpty: true });
  await libSeed.push(lib, "HEAD:refs/heads/main");
}

// The agent is present first (its wait was a contact), so the pull request's session is local.
async function present(agentId: string): Promise<void> {
  expect((await stack.run(["wait", "--agent-id", agentId, "--timeout", "0"])).code).toBe(2);
}

async function claim(agentId: string, env: Record<string, string> = {}) {
  const exit = await stack.run(["claim", "--agent-id", agentId], env);
  expect(exit.code).toBe(0);
  return v.parse(Claimed, result(exit));
}

async function checkout(agentId: string, env: Record<string, string>, cwd?: string) {
  const exit = await stack.run(["checkout", "--agent-id", agentId], env, cwd);
  expect(exit.code).toBe(0);
  return { exit, out: v.parse(CheckedOut, result(exit)) };
}

// A repository, the pull request pushed at a head holding the files, and the laptop's claim of its analysis.
async function analysisJob(files: Record<string, string> = {}, symlinks: Record<string, string> = {}) {
  const repo = await makeRepo(stack.dir(), pr);
  const head = await repo.head("h1", files, symlinks);
  await present("laptop");
  await push(stack.worker(), pr, head, repo.base);
  const claimed = await claim("laptop");
  return { repo, head, claimed };
}

describe("prq checkout", () => {
  it("fetches the pull ref without changing a ref of the clone, and adds a detached worktree at the job's commit", async () => {
    const { repo, head, claimed } = await analysisJob();
    // A host whose config makes a plain fetch change refs, each undone by one of the fetch's options:
    // pull refs fetched into remote-tracking refs (--refmap=), every tag fetched (--no-tags), refs and local tags the
    // remote lacks pruned (--no-prune), submodules fetched (--no-recurse-submodules), and automatic maintenance, in the
    // foreground, that prunes the host's worktree registrations whose directory is gone (--no-auto-maintenance).
    await repo.bare.tag("v1", head);
    const settings: [string, string][] = [
      ["remote.origin.fetch", "+refs/pull/*/head:refs/remotes/origin/pr/*"],
      ["remote.origin.tagOpt", "--tags"],
      ["fetch.prune", "true"],
      ["fetch.pruneTags", "true"],
      ["fetch.recurseSubmodules", "yes"],
      ["maintenance.autoDetach", "false"],
      ["maintenance.worktree-prune.enabled", "true"],
      ["maintenance.worktree-prune.auto", "-1"],
      ["gc.worktreePruneExpire", "now"],
    ];
    for (const [key, value] of settings) {
      await repo.clone.configSet(key, value, { add: true });
    }
    await repo.clone.updateRef("refs/remotes/origin/gone", repo.base);
    await repo.clone.tag("local-only", repo.base);
    await addSubmodule(repo);
    // After the last commit in the clone, whose own automatic maintenance would prune it already.
    const hostWorktree = (await repo.clone.worktreeAdd("host-worktree", repo.base)).path;
    await rm(hostWorktree, { recursive: true });
    const before = await hostState(repo);
    expect(before.worktrees).toContain(hostWorktree);

    const context = await stack.run(["context", "--agent-id", "laptop"], repo.env);
    expect(result(context)).toMatchObject({ next: "checkout" });
    const { exit, out } = await checkout("laptop", repo.env);

    const path = join(claimed.dir, "worktree");
    expect(out).toEqual({ path, sha: head, base: repo.base, clone: await realpath(repo.clone.path), next: "answer" });
    expect(exit.stderr).toBe("");
    expect(await at(repo, path).headCommit()).toBe(head);
    expect(await at(repo, path).branch()).toBeNull();
    expect(JSON.parse(await readFile(join(claimed.dir, "checkout.json"), "utf8"))).toEqual({
      clone: await realpath(repo.clone.path),
      sha: head,
    });
    const after = await hostState(repo);
    expect(after.refs).toBe(before.refs);
    expect(after.submoduleRefs).toBe(before.submoduleRefs);
    expect(after.head).toBe(before.head);
    expect(after.fetchHead).toBe(before.fetchHead);
    expect(after.worktrees).toEqual([...before.worktrees, await realpath(path)]);
  });

  it("runs none of the clone's hooks", async () => {
    const { repo } = await analysisJob();
    const marker = join(stack.dir(), "hook-ran");
    const hooks = join(repo.clone.path, ".git", "hooks");
    await writeFile(join(hooks, "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(join(hooks, "post-checkout"), 0o755);
    // The isolated global config turns hooks off for every git of the tests; the clone's own config names its hooks
    // again, as a host's would.
    await repo.clone.configSet("core.hooksPath", hooks);

    await checkout("laptop", repo.env);
    expect(await exists(marker)).toBe(false);
  });

  it("ignores the variables that name another repository, as a hook that runs prq has them: the decoy stays as it was", async () => {
    const { repo, head, claimed } = await analysisJob();
    // A decoy clone of the same repository: a git that followed the variables would find it as the clone, fetch into it
    // and register the worktree there.
    const decoy = join(stack.dir(), "decoy");
    await repo.fixture.clone(repo.bare, "decoy");
    const decoyGit = join(decoy, ".git");
    const before = await digest(decoy);
    const env = {
      ...repo.env,
      GIT_DIR: decoyGit,
      GIT_WORK_TREE: decoy,
      GIT_INDEX_FILE: join(decoyGit, "index"),
      GIT_OBJECT_DIRECTORY: join(decoyGit, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(decoyGit, "objects"),
      GIT_COMMON_DIR: decoyGit,
      GIT_NAMESPACE: "decoy",
    };

    const { out } = await checkout("laptop", env);
    expect(out).toMatchObject({
      path: join(claimed.dir, "worktree"),
      sha: head,
      clone: await realpath(repo.clone.path),
    });
    expect(await repo.clone.worktrees()).toContain(await realpath(out.path));
    expect(await digest(decoy)).toEqual(before);
  });

  it.each([
    ["a .prq symlink to a directory outside the tree", {}, { ".prq": "../outside" }],
    ["a .prq/.gitignore symlink to a file outside the tree", {}, { ".prq/.gitignore": "../../outside/file" }],
    ["a tracked .prq/.gitignore", { ".prq/.gitignore": "tracked\n" }, {}],
  ])("writes nothing inside the worktree: %s", async (_, files, symlinks) => {
    const { repo, claimed } = await analysisJob(files, symlinks);
    // What the symlinks point at, relative to the worktree: the job directory's outside/.
    const outside = join(claimed.dir, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "file"), "outside\n");
    const before = { entries: await readdir(outside), file: await stat(join(outside, "file")) };

    expect((await stack.run(["context", "--agent-id", "laptop"], repo.env)).code).toBe(0);
    const { out } = await checkout("laptop", repo.env);

    expect(await readdir(outside)).toEqual(before.entries);
    const file = await stat(join(outside, "file"));
    expect(await readFile(join(outside, "file"), "utf8")).toBe("outside\n");
    expect(file.mtimeMs).toBe(before.file.mtimeMs);
    // Tracked files as the commit has them, nothing added or ignored.
    expect(await at(repo, out.path).status()).toBe("");
  });

  it("finds the clone under a root whatever the case of its directory names", async () => {
    const { repo, head } = await analysisJob();
    const roots = repo.env["PRQ_CLONE_ROOTS"] ?? "";
    await rename(join(roots, "acme"), join(roots, "ACME"));
    await rename(join(roots, "ACME", "widgets"), join(roots, "ACME", "Widgets"));
    const { out } = await checkout("laptop", repo.env);
    expect(out).toMatchObject({ sha: head, clone: await realpath(join(roots, "ACME", "Widgets")) });
  });

  it("finds the clone from --clone, without roots", async () => {
    const { repo } = await analysisJob();
    const env = { ...repo.env, PRQ_CLONE_ROOTS: "" };
    const flagged = await stack.run(["checkout", "--agent-id", "laptop", "--clone", repo.clone.path], env);
    expect(flagged.code).toBe(0);
    expect(result(flagged)).toMatchObject({ clone: await realpath(repo.clone.path) });
  });

  it("finds the clone holding the working directory, without roots", async () => {
    const { repo } = await analysisJob();
    await mkdir(join(repo.clone.path, "sub"), { recursive: true });
    const { out } = await checkout("laptop", { ...repo.env, PRQ_CLONE_ROOTS: "" }, join(repo.clone.path, "sub"));
    expect(out.clone).toBe(await realpath(repo.clone.path));
  });

  it("finds a fork clone through its upstream remote", async () => {
    const { repo, head } = await analysisJob();
    await repo.clone.remoteRename("origin", "upstream");
    await repo.clone.remoteAdd("origin", "git@github.com:someone/widgets.git");
    const before = await hostState(repo);

    const { out } = await checkout("laptop", repo.env);
    expect(out).toMatchObject({ sha: head, clone: await realpath(repo.clone.path) });
    expect((await hostState(repo)).refs).toBe(before.refs);
  });

  it("no clone: exit 1 naming what was tried, nothing created", async () => {
    const { repo, claimed } = await analysisJob();
    const env = { ...repo.env, PRQ_CLONE_ROOTS: join(stack.dir(), "nowhere") };
    const exit = await stack.run(["checkout", "--agent-id", "laptop"], env);
    expect(exit.code).toBe(1);
    expect(exit.stdout).toBe("");
    const [line] = stderrLines(exit);
    expect(line).toMatch(/^prq: no clone of acme\/widgets found; tried the working directory \(/);
    expect(line).toContain(`${join(stack.dir(), "nowhere", "acme", "widgets")} (missing)`);
    expect(line).toContain(`${join(stack.dir(), "nowhere", "github.com", "acme", "widgets")} (missing)`);
    expect(line).toMatch(/Pass --clone <dir>, or set PRQ_CLONE_ROOTS/);
    expect(await exists(join(claimed.dir, "worktree"))).toBe(false);
    expect(await exists(join(claimed.dir, "checkout.json"))).toBe(false);
  });

  it("fetches the commit itself when pull/<n>/head moved on", async () => {
    const repo = await makeRepo(stack.dir(), pr);
    const first = await repo.head("h1");
    // h1 stays reachable from a branch while the pull ref is force-pushed past it.
    await repo.bare.updateRef("refs/heads/kept", first);
    await repo.head("h2");
    await present("laptop");
    await push(stack.worker(), pr, first, repo.base);
    await claim("laptop");
    const before = await hostState(repo);

    const { out } = await checkout("laptop", repo.env);
    expect(out.sha).toBe(first);
    expect(await at(repo, out.path).headCommit()).toBe(first);
    expect((await hostState(repo)).refs).toBe(before.refs);
  });

  it("a commit the remote does not have: exit 1 naming it, no worktree", async () => {
    const repo = await makeRepo(stack.dir(), pr);
    await present("laptop");
    await push(stack.worker(), pr, sha("nowhere"), repo.base);
    const claimed = await claim("laptop");
    const before = await hostState(repo);

    const exit = await stack.run(["checkout", "--agent-id", "laptop"], repo.env);
    expect(exit.code).toBe(1);
    expect(exit.stdout).toBe("");
    expect(stderrLines(exit).at(-1)).toMatch(
      new RegExp(`^prq: the commit ${sha("nowhere")} is not in .*, and fetching it from origin failed: .+`),
    );
    expect(await exists(join(claimed.dir, "worktree"))).toBe(false);
    expect(await hostState(repo)).toEqual(before);
  });

  it("a base that cannot be fetched: a notice and base null", async () => {
    const repo = await makeRepo(stack.dir(), pr);
    const head = await repo.head("h1");
    await present("laptop");
    await push(stack.worker(), pr, head, sha("gone-base"));
    await claim("laptop");
    const { exit, out } = await checkout("laptop", repo.env);
    expect(out).toMatchObject({ sha: head, base: null });
    expect(stderrLines(exit)).toEqual([
      `prq: the base ${sha("gone-base")} could not be fetched from origin; continuing without it`,
    ]);
  });

  it("no push yet: a null path and no git", async () => {
    await present("laptop");
    await ask(stack.worker(), pr, "q1", "what is this?");
    const claimed = await claim("laptop");
    expect(claimed.job.workspaceSha).toBeNull();
    // A git that records being run.
    const bin = join(stack.dir(), "bin");
    const marker = join(stack.dir(), "git-ran");
    await mkdir(bin);
    await writeFile(join(bin, "git"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(join(bin, "git"), 0o755);

    const exit = await stack.run(["checkout", "--agent-id", "laptop"], { PATH: `${bin}:${process.env["PATH"]}` });
    expect(exit.code).toBe(0);
    expect(result(exit)).toEqual({ path: null, sha: null, base: null, next: "answer" });
    expect(await exists(marker)).toBe(false);
  });

  it("reads the context first when context.json is missing; exit 4 when the claim no longer holds", async () => {
    const { repo, claimed } = await analysisJob();
    await retry(stack.worker(), pr, claimed.job.jobId);
    const exit = await stack.run(["checkout", "--agent-id", "laptop"], repo.env);
    expect(exit.code).toBe(4);
    expect(result(exit)).toEqual({ status: "stale_claim", next: "claim" });
    expect(await exists(join(claimed.dir, "worktree"))).toBe(false);
  });

  it("resume moves the workspace: a new directory and worktree at the new commit, reused by a rerun", async () => {
    const repo = await makeRepo(stack.dir(), pr);
    const h1 = await repo.head("h1");
    await present("laptop");
    await push(stack.worker(), pr, h1, repo.base);
    await ask(stack.worker(), pr, "q1", "what changed?");
    const question = await claim("laptop");
    expect(question.job).toMatchObject({ target: { kind: "answer", messageId: "q1" }, workspaceSha: h1 });
    const first = await checkout("laptop", repo.env);
    const firstPath = await realpath(first.out.path);

    // Another agent completes the analysis of a new head; the laptop's claim then resumes the question there.
    const h2 = await repo.head("h2");
    await push(stack.worker(), pr, h2, repo.base);
    const analysis = await claim("desk");
    await writeFile(analysis.answer, "the summary of h2\n");
    expect((await stack.run(["submit", "--agent-id", "desk"])).code).toBe(0);
    const resumed = await claim("laptop");
    expect(resumed).toMatchObject({ resumed: true, job: { jobId: question.job.jobId, workspaceSha: h2 } });
    expect(resumed.dir).not.toBe(question.dir);

    const second = await checkout("laptop", repo.env);
    expect(second.out).toMatchObject({ path: join(resumed.dir, "worktree"), sha: h2 });
    expect(await at(repo, second.out.path).headCommit()).toBe(h2);
    // The ended claim's directory and its worktree went with this checkout.
    expect(await exists(question.dir)).toBe(false);
    expect(await repo.clone.worktrees()).not.toContain(firstPath);

    await writeFile(join(second.out.path, "notes.txt"), "the AI's file\n");
    const rerun = await checkout("laptop", repo.env);
    expect(rerun.out.path).toBe(second.out.path);
    expect(await readFile(join(rerun.out.path, "notes.txt"), "utf8")).toBe("the AI's file\n");
  });

  it("a rerun after the worktree left the job's commit: exit 1 naming where it is, its files left alone", async () => {
    const { repo, head } = await analysisJob();
    const { out } = await checkout("laptop", repo.env);
    await writeFile(join(out.path, "notes.txt"), "the AI's file\n");

    const worktree = at(repo, out.path);
    await worktree.checkoutDetach(repo.base);
    const moved = await stack.run(["checkout", "--agent-id", "laptop"], repo.env);
    expect(moved.code).toBe(1);
    expect(moved.stdout).toBe("");
    expect(stderrLines(moved)).toEqual([
      `prq: the worktree ${out.path} is detached at ${repo.base}, not at the job's commit ${head}; its files are left as they are`,
    ]);
    expect(await worktree.headCommit()).toBe(repo.base);

    await worktree.switchCreate("work", head);
    const onBranch = await stack.run(["checkout", "--agent-id", "laptop"], repo.env);
    expect(onBranch.code).toBe(1);
    expect(stderrLines(onBranch)).toEqual([
      `prq: the worktree ${out.path} is at ${head} on refs/heads/work, not detached at the job's commit ${head}; its files are left as they are`,
    ]);
    expect(await worktree.branch()).toBe("refs/heads/work");
    expect(await readFile(join(out.path, "notes.txt"), "utf8")).toBe("the AI's file\n");
  });

  it.each([
    ["a symlink to a host worktree", "symlink"],
    ["another repository's worktree", "foreign"],
  ] as const)("a worktree path prq did not make, %s: exit 1, nothing removed", async (_, kind) => {
    const { repo, claimed } = await analysisJob();
    const path = join(claimed.dir, "worktree");
    await mkdir(claimed.dir, { recursive: true });
    let target: string;
    let owner: FixtureRepo;
    if (kind === "symlink") {
      owner = repo.clone;
      target = (await repo.clone.worktreeAdd("host-worktree", repo.base)).path;
      await symlink(target, path);
    } else {
      target = path;
      owner = await repo.fixture.init("other");
      await owner.commit("other", { allowEmpty: true });
      await owner.worktreeAdd(relative(stack.dir(), path));
    }
    await writeFile(join(target, "keep.txt"), "keep\n");
    const registrations = await owner.worktreeList();

    const exit = await stack.run(["checkout", "--agent-id", "laptop"], repo.env);
    expect(exit.code).toBe(1);
    expect(exit.stdout).toBe("");
    const reason =
      kind === "symlink"
        ? `${path} is a symlink, not followed`
        : `${path} is not a worktree of ${await realpath(repo.clone.path)}`;
    expect(stderrLines(exit)).toEqual([`prq: ${reason}; nothing was removed`]);
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("keep\n");
    expect(await owner.worktreeList()).toBe(registrations);
    expect(await exists(join(claimed.dir, "checkout.json"))).toBe(false);
  });

  it("a jobs directory that is a symlink: exit 1, no worktree added through it", async () => {
    const { repo, claimed } = await analysisJob();
    // The context written first, so checkout reads it rather than writing it.
    expect((await stack.run(["context", "--agent-id", "laptop"], repo.env)).code).toBe(0);
    // jobs/ moved elsewhere and a symlink left in its place.
    const elsewhere = join(stack.dir(), "elsewhere-jobs");
    const jobs = join(stack.home(), "jobs");
    await rename(jobs, elsewhere);
    await symlink(elsewhere, jobs);
    const registrations = await repo.clone.worktrees();

    const exit = await stack.run(["checkout", "--agent-id", "laptop"], repo.env);
    expect(exit.code).toBe(1);
    expect(exit.stdout).toBe("");
    expect(stderrLines(exit)).toEqual([
      `prq: ${jobs} is a symlink, not followed; nothing is written through it (set PRQ_HOME to keep prq's state elsewhere)`,
    ]);
    expect((await readdir(join(elsewhere, basename(claimed.dir)))).toSorted()).toEqual([
      "context.json",
      "instructions",
    ]);
    expect(await repo.clone.worktrees()).toEqual(registrations);
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "ended by %s while git runs: passes it on to git's group as it came, kills what ignores it after the grace, then ends by it",
    async (signal) => {
      const repo = await makeRepo(stack.dir(), pr);
      const { files, pids, signals } = await slowFilter(repo, { stubborn: true });
      const head = await repo.head("h1", files);
      await present("laptop");
      await push(stack.worker(), pr, head, repo.base);
      await claim("laptop");

      const running = stack.start(["checkout", "--agent-id", "laptop"], repo.env);
      await vi.waitFor(async () => expect(await liveProcesses(pids)).toHaveLength(2), {
        timeout: 20_000,
        interval: 50,
      });

      const exit = await running.kill(signal);
      expect(exit).toMatchObject({ code: null, signal, stdout: "" });
      expect(await readFile(signals, "utf8")).toBe(`${signal.slice("SIG".length)}\n`);
      await vi.waitFor(async () => expect(await liveProcesses(pids)).toEqual([]), { timeout: 1_000 });
    },
    60_000,
  );
});
