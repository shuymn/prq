import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { ClaimResponse } from "@prq/protocol";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { result, stderrLines } from "../test/cli.ts";
import { makeRepo, type Repo } from "../test/git.ts";
import { latch } from "../test/latch.ts";
import { ask, push, sha, storedMessages } from "../test/pr.ts";
import { useStack } from "../test/stack.ts";

const stack = useStack();
const pr = { owner: "acme", repo: "widgets", number: 7 };

const Claimed = v.object({
  ...ClaimResponse.options[0].entries,
  dir: v.string(),
  answer: v.string(),
  saved: v.boolean(),
});

function recordPath(agentId: string): string {
  return join(stack.home(), "agents", `${createHash("sha256").update(agentId).digest("hex")}.json`);
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

// The agent is present first (its wait was a contact), so the pull request's session is local.
async function present(agentId: string): Promise<void> {
  expect((await stack.run(["wait", "--agent-id", agentId, "--timeout", "0"])).code).toBe(2);
}

async function claim(agentId: string) {
  const exit = await stack.run(["claim", "--agent-id", agentId]);
  expect(exit.code).toBe(0);
  return v.parse(Claimed, result(exit));
}

// A job directory as prq makes one, for a job the session never had: its name, and a worktree of the commit
// registered in the clone with checkout.json naming it.
async function endedDir(repo: Repo | null, commit: string | null): Promise<string> {
  const dir = join(stack.home(), "jobs", `${randomUUID()}-r1-${commit ?? "none"}`);
  await mkdir(dir, { recursive: true });
  if (repo !== null && commit !== null) {
    await writeFile(
      join(dir, "checkout.json"),
      JSON.stringify({ clone: await realpath(repo.clone.path), sha: commit }),
    );
    await repo.clone.worktreeAdd(relative(stack.dir(), join(dir, "worktree")), commit);
  }
  return dir;
}

async function reconcile(agentId: string, env: Record<string, string> = {}, cwd?: string) {
  const exit = await stack.run(["reconcile", "--agent-id", agentId], env, cwd);
  expect(exit.code).toBe(0);
  return { exit, out: result(exit) };
}

// A job directory as prq leaves one whose worktree went: checkout.json naming the clone, no worktree at its path.
async function recordedDir(repo: Repo): Promise<{ dir: string; path: string }> {
  const dir = join(stack.home(), "jobs", `${randomUUID()}-r1-${repo.base}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "checkout.json"),
    JSON.stringify({ clone: await realpath(repo.clone.path), sha: repo.base }),
  );
  return { dir, path: join(dir, "worktree") };
}

describe("prq reconcile", () => {
  it("cleanup: removes the job directories no record names and their worktrees by exact path, nothing else", async () => {
    const repo = await makeRepo(stack.dir(), pr);
    const head = await repo.head("h1");
    await present("laptop");
    await push(stack.worker(), pr, head, repo.base);
    await ask(stack.worker(), pr, "q1", "what changed?");
    // Two agents with records: the laptop works on the question in a worktree, the desk on the analysis.
    const laptop = await claim("laptop");
    expect((await stack.run(["checkout", "--agent-id", "laptop"], repo.env)).code).toBe(0);
    const desk = await claim("desk");

    // Ended directories: one with its worktree, one whose worktree the host deleted (its registration stays), and one
    // holding the working directory.
    const ended = await endedDir(repo, head);
    const deleted = await endedDir(repo, head);
    const prqRegistrations = [join(await realpath(ended), "worktree"), join(await realpath(deleted), "worktree")];
    await rm(join(deleted, "worktree"), { recursive: true });
    const cwdDir = await endedDir(null, null);
    // Entries prq does not own: a symlink to a directory outside the state root, and a name that is not a job's.
    const outside = join(stack.dir(), "outside");
    await mkdir(outside);
    await writeFile(join(outside, "file"), "outside\n");
    const link = join(stack.home(), "jobs", "link");
    await symlink(outside, link);
    const odd = join(stack.home(), "jobs", "notes");
    await mkdir(odd);
    await writeFile(join(odd, "file"), "notes\n");
    // The host's own worktree whose directory is gone: registered, prunable.
    const hostWorktree = (await repo.clone.worktreeAdd("host-worktree", repo.base)).path;
    const hostRegistration = await realpath(hostWorktree);
    await rm(hostWorktree, { recursive: true });
    const refs = await repo.clone.refs();
    const before = await repo.clone.worktrees();
    expect(before).toEqual(expect.arrayContaining([...prqRegistrations, hostRegistration]));
    const outsideBefore = await stat(join(outside, "file"));

    const { exit, out } = await reconcile("laptop", repo.env, cwdDir);

    expect(out).toEqual({
      claim: { ...laptop, saved: false },
      removed: [ended, deleted, link].toSorted(),
      kept: [{ agentId: "desk", dir: desk.dir }],
      next: "context",
    });
    expect(exit.stderr).toBe("");
    expect(await exists(ended)).toBe(false);
    expect(await exists(deleted)).toBe(false);
    expect(await exists(link)).toBe(false);
    // Kept: the agents' directories, the working directory's, the odd entry, what the symlink pointed at.
    expect(await exists(join(laptop.dir, "worktree", "change.txt"))).toBe(true);
    expect(await exists(desk.dir)).toBe(true);
    expect(await exists(cwdDir)).toBe(true);
    expect(await readFile(join(odd, "file"), "utf8")).toBe("notes\n");
    expect(await readdir(outside)).toEqual(["file"]);
    expect((await stat(join(outside, "file"))).mtimeMs).toBe(outsideBefore.mtimeMs);
    // The clone: both prq registrations gone, the host's kept, every ref as it was.
    expect(await repo.clone.worktrees()).toEqual(before.filter((path) => !prqRegistrations.includes(path)));
    expect(await repo.clone.worktrees()).toContain(hostRegistration);
    expect(await repo.clone.refs()).toBe(refs);
  });

  it("cleanup: a job's worktree path that is a symlink to a host worktree: kept, and the host worktree with it", async () => {
    const repo = await makeRepo(stack.dir(), pr);
    const host = (await repo.clone.worktreeAdd("host-worktree", repo.base)).path;
    await writeFile(join(host, "host-file"), "the host's\n");
    const { dir, path } = await recordedDir(repo);
    await symlink(host, path);
    const registrations = await repo.clone.worktrees();
    const refs = await repo.clone.refs();

    const { exit, out } = await reconcile("laptop", repo.env);
    expect(out).toEqual({
      claim: null,
      removed: [],
      kept: [{ dir, reason: `${path} is a symlink, not followed` }],
      next: "wait",
    });
    expect(stderrLines(exit)).toEqual([`prq: ${path} is a symlink, not followed; its job directory is kept`]);
    expect(await readFile(join(host, "host-file"), "utf8")).toBe("the host's\n");
    expect(await readFile(join(host, "README.md"), "utf8")).toBe("a widget\n");
    expect(await repo.clone.worktrees()).toEqual(registrations);
    expect(await repo.clone.refs()).toBe(refs);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  it.each([
    ["another repository's worktree, prq's registration removed through git", "removed"],
    ["another repository's worktree, prq's registration left behind", "left"],
    ["a worktree of the clone moved there by hand", "moved"],
  ] as const)("cleanup: a job's worktree path holding %s: kept, its files and registrations too", async (_, kind) => {
    const repo = await makeRepo(stack.dir(), pr);
    const { dir, path } = await recordedDir(repo);
    const name = relative(stack.dir(), path);
    let owner = repo.clone;
    if (kind === "moved") {
      // Its .git leads to the clone, which registers it where it was.
      await rename((await repo.clone.worktreeAdd("elsewhere", repo.base)).path, path);
    } else {
      // The clone registers prq's worktree at the path, or no longer does; another repository's worktree is there now.
      const added = await repo.clone.worktreeAdd(name, repo.base);
      await (kind === "removed" ? repo.clone.worktreeRemove(added) : rm(path, { recursive: true }));
      owner = await repo.fixture.init("other");
      await owner.commit("other", { allowEmpty: true });
      await owner.worktreeAdd(name);
    }
    await writeFile(join(path, "important.txt"), "keep\n");
    const ownerRegistrations = await owner.worktreeList();
    const registrations = await repo.clone.worktrees();

    const { exit, out } = await reconcile("laptop", repo.env);
    const reason = `${path} is not a worktree of ${await realpath(repo.clone.path)}`;
    expect(out).toEqual({ claim: null, removed: [], kept: [{ dir, reason }], next: "wait" });
    expect(stderrLines(exit)).toEqual([`prq: ${reason}; its job directory is kept`]);
    expect(await readFile(join(path, "important.txt"), "utf8")).toBe("keep\n");
    expect(await owner.worktreeList()).toBe(ownerRegistrations);
    expect(await repo.clone.worktrees()).toEqual(registrations);
  });

  it("cleanup through a jobs directory that is a symlink to another state root's: nothing removed there, jobs kept with the reason", async () => {
    // The default state root: the desk's claim of the analysis, with its worktree and a saved answer.
    const repo = await makeRepo(stack.dir(), pr);
    const head = await repo.head("h1");
    await present("desk");
    await push(stack.worker(), pr, head, repo.base);
    const desk = await claim("desk");
    expect((await stack.run(["checkout", "--agent-id", "desk"], repo.env)).code).toBe(0);
    await writeFile(desk.answer, "the summary\n");
    // Another state root, without records, whose jobs/ leads to the first one's.
    const home = join(stack.dir(), "laptop-state");
    const jobs = join(home, "jobs");
    await mkdir(home);
    await symlink(join(stack.home(), "jobs"), jobs);
    const record = await readFile(recordPath("desk"), "utf8");
    const registrations = await repo.clone.worktrees();

    const { exit, out } = await reconcile("laptop", { ...repo.env, PRQ_HOME: home });
    const reason = `${jobs} is a symlink, not followed`;
    expect(out).toEqual({ claim: null, removed: [], kept: [{ dir: jobs, reason }], next: "wait" });
    expect(stderrLines(exit)).toEqual([
      `prq: ${reason}; no job directory is removed (set PRQ_HOME to keep prq's state elsewhere)`,
    ]);
    expect(await readFile(recordPath("desk"), "utf8")).toBe(record);
    expect(await readFile(desk.answer, "utf8")).toBe("the summary\n");
    expect(await readFile(join(desk.dir, "worktree", "change.txt"), "utf8")).toBe("h1\n");
    expect(await repo.clone.worktrees()).toEqual(registrations);
  });

  it("restart after a replaced claimId: keeps the record and the saved answer; the next claim resumes them", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    // The claim's first request lands after its resend took the job, and resumes it under another claimId.
    const release = latch();
    const answered = latch();
    stack.access().plan("/cli/claim", { kind: "defer", release, answered });
    const first = await claim("laptop");
    await writeFile(first.answer, "the summary\n");
    release.open();
    await answered.promise;
    const record = await readFile(recordPath("laptop"), "utf8");

    const { out } = await reconcile("laptop");
    expect(out).toEqual({ claim: { ...first, saved: true }, removed: [], kept: [], next: "claim" });
    expect(await readFile(recordPath("laptop"), "utf8")).toBe(record);
    expect(await readFile(first.answer, "utf8")).toBe("the summary\n");

    const resumed = await stack.run(["claim", "--agent-id", "laptop"]);
    expect(result(resumed)).toMatchObject({ resumed: true, dir: first.dir, saved: true, next: "answer" });
    const submitted = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(result(submitted)).toMatchObject({ status: "accepted" });
    const answers = (await storedMessages(stack.worker(), pr)).filter((message) => message.role === "assistant");
    expect(answers.map((message) => message.text)).toEqual(["the summary\n"]);
  });

  it("unknown job: removes the record and its directory, next wait", async () => {
    const job = {
      jobId: randomUUID(),
      pr,
      run: 1,
      target: { kind: "analysis", headSha: sha("h1") },
      workspaceSha: null,
    };
    const record = { agentId: "laptop", claim: { job, claimId: randomUUID(), resumed: false } };
    await mkdir(join(stack.home(), "agents"), { recursive: true });
    await writeFile(recordPath("laptop"), JSON.stringify({ ...record, savedAt: new Date().toISOString() }));
    const dir = join(stack.home(), "jobs", `${job.jobId}-r1-none`);
    await mkdir(dir, { recursive: true });

    const { out } = await reconcile("laptop");
    expect(out).toEqual({ claim: null, removed: [dir], kept: [], next: "wait" });
    expect(await exists(recordPath("laptop"))).toBe(false);
  });

  it("a claim that holds: next answer with a saved answer, else context", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    const claimed = await claim("laptop");
    expect((await reconcile("laptop")).out).toMatchObject({ claim: { claimId: claimed.claimId }, next: "context" });
    await writeFile(claimed.answer, "the summary\n");
    expect((await reconcile("laptop")).out).toMatchObject({ claim: { saved: true }, next: "answer" });
    expect(
      stack
        .access()
        .log.filter((entry) => entry.route === "/cli/context")
        .map((entry) => entry.status),
    ).toEqual([200, 200]);
  });

  it("no record: next wait, without a request", async () => {
    const { out } = await reconcile("laptop");
    expect(out).toEqual({ claim: null, removed: [], kept: [], next: "wait" });
    expect(stack.access().log).toEqual([]);
  });

  it("an unreadable record: next claim, and no directory is removed while it is there", async () => {
    await mkdir(join(stack.home(), "agents"), { recursive: true });
    await writeFile(recordPath("laptop"), "{not json");
    const ended = await endedDir(null, null);

    const { exit, out } = await reconcile("laptop");
    expect(out).toEqual({ claim: null, removed: [], kept: [], next: "claim" });
    expect(stderrLines(exit)).toEqual([
      `prq: the claim record ${recordPath("laptop")} is unreadable; run prq claim`,
      `prq: the claim record ${recordPath("laptop")} is unreadable; no job directory is removed until it is replaced`,
    ]);
    expect(await exists(ended)).toBe(true);
  });
});
