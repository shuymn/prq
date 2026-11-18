// The cloud workspace's git procedure (workspace-git.ts) with real git, through the CLI's git fixture: a file://
// remote in a fresh temporary directory stands in for github.com, and the checkout is a directory beside it. The fake
// container (workspace.test.ts) covers the Workspace's order of operations; this covers what git itself does with the
// leftovers of a prepare cut short.

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FixtureGit, type FixtureRepo, fixtureRoot, isCheckoutStep } from "../../cli/src/test/git.ts";
import { opArgv, prepareArgv, type ReadyRecord, type RecordStore, toolArgv } from "./workspace-git.ts";

type Commits = { base: string; b2: string; fork: string; h1: string; h2: string; head: string; next: string };

let root: string;
let fixture: FixtureGit;
let origin: FixtureRepo;
let commits: Commits;
let counter = 0;

// origin.git: main runs old1 … old6 → fork → b2 → base; the pull request's branch leaves main at fork and runs h1 → h2 →
// head → next. A shallow fetch of head and base needs two deepen rounds to reach their merge base (fork), one of h1 or
// h2 and b2 needs one, and the checkout stays shallow after them.
beforeAll(async () => {
  root = await fixtureRoot("prq-workspace-git-");
  fixture = await FixtureGit.create(root);
  origin = await fixture.init("origin.git", { bare: true });
  // What GitHub allows: a fetch of any commit reachable from a ref, by its SHA.
  await origin.configSet("uploadpack.allowReachableSHA1InWant", "true");
  const seed = await fixture.init("seed");
  const commit = async (file: string, content: string, message: string) => {
    await writeFile(join(seed.path, file), content);
    await seed.add(file);
    await seed.commit(message);
    return seed.headCommit();
  };
  for (let index = 1; index <= 6; index += 1) {
    await commit("README.md", `# rates ${index}\n`, `old${index}`);
  }
  const fork = await commit("README.md", "# rates, forked\n", "fork");
  const b2 = await commit("NOTES.md", "main moves on\n", "b2");
  const base = await commit("NOTES.md", "main moves on again\n", "base");
  await seed.push(origin, "HEAD:refs/heads/main");
  await seed.switchCreate("feature", fork);
  const h1 = await commit("rates.ts", "export const rate = 1;\n", "h1");
  const h2 = await commit("rates.ts", "export const rate = 2;\nexport const limit = 10;\n", "h2");
  const head = await commit("rates.ts", "export const rate = 3;\nexport const limit = 10;\n", "head");
  const next = await commit("rates.ts", "export const rate = 4;\nexport const limit = 10;\n", "next");
  await seed.push(origin, "HEAD:refs/heads/feature");
  commits = { base, b2, fork, h1, h2, head, next };
});

// The fresh directory fixtureRoot made for this file, and everything in it.
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// A ready record kept in memory, its writes noted in the checkout's log beside the commands.
function memoryStore(log: string[]): RecordStore & { record: ReadyRecord | null } {
  const store = {
    record: null as ReadyRecord | null,
    read: () => store.record,
    write: (record: ReadyRecord) => {
      log.push("record written");
      store.record = record;
    },
    clear: () => {
      log.push("record cleared");
      store.record = null;
    },
  };
  return store;
}

async function newCheckout() {
  counter += 1;
  const checkout = await fixture.workspaceCheckout(`checkout-${counter}`);
  return { checkout, store: memoryStore(checkout.log) };
}

describe("the workspace's git procedure with real git", () => {
  it("checks out the commit, deepened until the merge base answers, and the tools' reads work at it", async () => {
    const { checkout, store } = await newCheckout();

    const ready = await checkout.prepare(origin, { sha: commits.head, baseSha: commits.base }, store);

    expect(ready).toEqual({ sha: commits.head, mergeBase: commits.fork, plan: "rebuild", token: store.record?.token });
    expect(
      checkout.log.filter((entry) => entry.includes("--deepen=")).map((entry) => /--deepen=(\d+)/.exec(entry)?.[1]),
    ).toEqual(["2", "4"]);
    expect(checkout.log.at(-1)).toBe("record written");
    expect((await checkout.show(commits.head, "rates.ts")).stdout).toBe(
      "export const rate = 3;\nexport const limit = 10;\n",
    );
    expect((await checkout.grep(commits.head, "limit")).stdout).toBe(
      `${commits.head}:rates.ts:2:export const limit = 10;\n`,
    );
    expect((await checkout.diff(commits.fork, commits.head)).stdout).toBe("2\t0\trates.ts\n");
  });

  it("wipes and rebuilds what an interrupted deepen left, even with HEAD already at the commit", async () => {
    const { checkout, store } = await newCheckout();
    const target = { sha: commits.h2, baseSha: commits.b2 };
    await checkout.prepare(origin, target, store);
    // A later prepare cleared the record and was cut during its deepen: git's lock and a shallow file cut short.
    store.clear();
    await checkout.interruptDeepen();
    expect(await checkout.has(join(".git", "shallow.lock"))).toBe(true);
    const from = checkout.log.length;

    expect(await checkout.prepare(origin, target, store)).toEqual({
      sha: commits.h2,
      mergeBase: commits.fork,
      plan: "rebuild",
      token: store.record?.token,
    });

    expect(checkout.log.slice(from).slice(0, 4)).toEqual([
      "record cleared",
      "rm -f -- <dir>/.git/prq-ready",
      "rm -rf -- <dir>",
      "git init --quiet -- <dir>",
    ]);
    expect(await checkout.has(join(".git", "shallow.lock"))).toBe(false);
    expect((await checkout.grep(commits.h2, "limit")).exitCode).toBe(0);
    expect((await checkout.diff(commits.fork, commits.h2, "rates.ts")).stdout).toContain("+export const limit = 10;");
  });

  it("rebuilds a ready checkout whose token file is gone, as after a container stop", async () => {
    const { checkout, store } = await newCheckout();
    const target = { sha: commits.h1, baseSha: commits.b2 };
    await checkout.prepare(origin, target, store);
    await checkout.dropReadyToken();
    const from = checkout.log.length;

    expect((await checkout.prepare(origin, target, store)).plan).toBe("rebuild");
    expect(checkout.log.slice(from)).toContain("git init --quiet -- <dir>");
  });

  it("reuses a ready checkout of the commit, and updates one of another commit in place, its record cleared first", async () => {
    const { checkout, store } = await newCheckout();
    await checkout.prepare(origin, { sha: commits.h1, baseSha: commits.b2 }, store);
    let from = checkout.log.length;

    expect((await checkout.prepare(origin, { sha: commits.h1, baseSha: commits.b2 }, store)).plan).toBe("reuse");
    expect(checkout.log.slice(from)).toEqual(["cat -- <dir>/.git/prq-ready"]);

    from = checkout.log.length;
    expect(await checkout.prepare(origin, { sha: commits.h2, baseSha: commits.b2 }, store)).toEqual({
      sha: commits.h2,
      mergeBase: commits.fork,
      plan: "update",
      token: store.record?.token,
    });
    const steps = checkout.log.slice(from);
    expect(steps.slice(0, 3)).toEqual([
      "cat -- <dir>/.git/prq-ready",
      "record cleared",
      "rm -f -- <dir>/.git/prq-ready",
    ]);
    expect(steps[3]).toContain(" fetch --quiet --depth=1 ");
    expect(steps.filter((entry) => entry.startsWith("rm -rf ") || entry.startsWith("git init "))).toEqual([]);
    expect((await checkout.show(commits.h2, "rates.ts")).stdout).toContain("rate = 2");
  });

  it("removes the ready token before the first change of an update and of a rebuild, and writes the new one last", async () => {
    const { checkout, store } = await newCheckout();
    await checkout.prepare(origin, { sha: commits.h1, baseSha: commits.b2 }, store);
    const firstChange = (from: number, change: string) => {
      const steps = checkout.tokenBefore.slice(from);
      return steps[steps.findIndex((step) => step.command.includes(change))];
    };

    let from = checkout.tokenBefore.length;
    const updated = await checkout.prepare(origin, { sha: commits.h2, baseSha: commits.b2 }, store);
    expect(updated.plan).toBe("update");
    expect(firstChange(from, " fetch ")).toEqual({ command: expect.stringContaining(" fetch "), present: false });

    // A record whose token is not the directory's: the directory is rebuilt, its stale token file removed first.
    if (store.record !== null) {
      store.record = { ...store.record, token: "0".repeat(32) };
    }
    from = checkout.tokenBefore.length;
    const rebuilt = await checkout.prepare(origin, { sha: commits.h1, baseSha: commits.b2 }, store);
    expect(rebuilt.plan).toBe("rebuild");
    expect(firstChange(from, "rm -rf")).toEqual({ command: "rm -rf -- <dir>", present: false });
    expect(checkout.tokenBefore.slice(from).at(-1)?.command).toMatch(/^sh -c /);
    expect(await checkout.has(join(".git", "prq-ready"))).toBe(true);
    expect(rebuilt.token).toBe(store.record?.token);
  });

  it("fetches from the checked repository, never from a remote the target carries", async () => {
    const { checkout, store } = await newCheckout();
    // A target object with a remote of its own: the fixture builds the target from the checked repository.
    const target = { sha: commits.h1, baseSha: commits.b2, remote: "file:///nonexistent/elsewhere.git" };

    expect((await checkout.prepare(origin, target, store)).plan).toBe("rebuild");
    expect(store.record?.remote).toBe(`file://${origin.path}`);
  });
});

describe("the fixture's guard on the procedure's commands", () => {
  it("runs the procedure's own git commands, and refuses global options that move where git reads or writes", () => {
    const dir = join(root, "guarded");
    expect(isCheckoutStep(prepareArgv.fetch(dir, [commits.head, commits.base]), dir)).toBe(true);
    expect(isCheckoutStep(prepareArgv.checkout(dir, commits.head), dir)).toBe(true);
    expect(isCheckoutStep(opArgv(dir, toolArgv.readFile(commits.head, "rates.ts")), dir)).toBe(true);
    const escapes = [
      ["-c", "core.worktree=/"],
      ["-c", "http.lowSpeedLimit=1000", "-c", "include.path=/etc/gitconfig"],
      ["--git-dir=/tmp/elsewhere"],
      ["--git-dir", "/tmp/elsewhere"],
      ["--work-tree=/"],
      ["--exec-path=/tmp"],
      ["-C", "/"],
      ["--config-env=core.hooksPath=HOME"],
    ];
    const allowed = escapes.filter((options) => isCheckoutStep(["git", "-C", dir, ...options, "status"], dir));
    expect(allowed).toEqual([]);
  });
});
