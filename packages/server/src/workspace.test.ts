import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceCommand, WorkspaceTarget } from "./pr-session/workspace.ts";
import { captureLogs } from "./test/access.ts";
import { type FakeContainer, newWorkspace, untilHeld, useFakeContainers, workspaceSeams } from "./test/container.ts";
import { tracked, within } from "./test/session.ts";
import { BASE, sha } from "./test/webhook.ts";
import { toolArgv } from "./workspace-git.ts";
import {
  COMMAND_MS,
  IDLE_STOP_MS,
  OUTPUT_CAP_BYTES,
  PKILL_MS,
  PREPARE_MS,
  STOP_MS,
  type Workspace,
} from "./workspace.ts";

beforeEach(() => {
  useFakeContainers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DIR = "/workspace/repo";
const REMOTE = "https://github.com/octo/demo.git";
const SUPERSEDED = { ok: false, kind: "refused", reason: "superseded by a newer turn" };
const RELEASED = { ok: false, kind: "refused", reason: "the turn has ended" };

function target(seq: number, commit = "a"): WorkspaceTarget {
  return { fullName: "octo/demo", installationId: 7, sha: sha(commit), baseSha: BASE, seq };
}

// read_file's command for a path at the commit, as the tool asks for a page.
function readFile(path: string, startLine = 1, commit = "a"): WorkspaceCommand {
  return {
    argv: toolArgv.readFile(sha(commit), path),
    page: { start: { line: startLine, char: 0 }, capChars: 11_800, numbered: true, detectBinary: true },
  };
}

// The commands of a prepare from empty, after the container has started.
function rebuildLog(commit: string, token: string): string[] {
  return [
    `rm -rf -- ${DIR}`,
    `git init --quiet -- ${DIR}`,
    `git -C ${DIR} remote add -- origin ${REMOTE}`,
    `git -C ${DIR} -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 fetch --quiet --depth=1 --no-tags --end-of-options origin ${sha(commit)} ${BASE}`,
    `git -C ${DIR} -c advice.detachedHead=false checkout --quiet --detach --end-of-options ${sha(commit)}`,
    `git -C ${DIR} merge-base --end-of-options ${sha(commit)} ${BASE}`,
    `git -C ${DIR} rev-parse --verify HEAD`,
    `sh -c printf %s "$1" > "$2" sh ${token} ${DIR}/.git/prq-ready`,
  ];
}

const SETUP = ["intercept http", "intercept https *", `idle ${IDLE_STOP_MS}`];
const STARTED = ["start", ...SETUP];
// The cleanup after a reset.
const PKILL = "pkill -KILL -x git|git-.*|rm|cat|sh";

// The token the last prepare wrote.
function tokenOf(container: FakeContainer): string {
  return container.disk?.token ?? "";
}

async function readyRecord(stub: DurableObjectStub<Workspace>): Promise<unknown[]> {
  return runInDurableObject(stub, (_, state) => state.storage.sql.exec("SELECT * FROM prq_ready").toArray());
}

async function inFlight(stub: DurableObjectStub<Workspace>): Promise<unknown> {
  return runInDurableObject(stub, (instance) => workspaceSeams(instance).inFlight());
}

// A Workspace whose checkout of commit a is ready under turn 1.
async function prepared(label: string) {
  const workspace = newWorkspace(label);
  workspace.container.mergeBase = BASE;
  expect(await workspace.stub.prepare(target(1))).toEqual({ ok: true, value: { sha: sha("a"), mergeBase: BASE } });
  return workspace;
}

// Resets every object, and the Workspace's stub for its next instance.
async function reset(name: string): Promise<DurableObjectStub<Workspace>> {
  await abortAllDurableObjects();
  return env.Workspace.getByName(name);
}

// Advances the fake clock inside the Workspace, so the timers that fire do their work in its context.
async function advance(stub: DurableObjectStub<Workspace>, ms: number): Promise<void> {
  await runInDurableObject(stub, () => vi.advanceTimersByTimeAsync(ms));
}

// Waits on the real clock for a check that should hold at once.
async function settles(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) {
      return;
    }
    await scheduler.wait(20);
  }
  throw new Error(`${what}: not within 1 s`);
}

function isFetch(argv: string[]): boolean {
  return argv.includes("fetch");
}

describe("prepare", () => {
  it("starts the container with no internet and every request to the egress, checks out the commit, and writes the ready record last", async () => {
    captureLogs();
    const { stub, container } = newWorkspace("prepare");
    container.mergeBase = BASE;
    const token = container.holdNext((argv) => argv[0] === "sh");

    const reply = tracked(stub.prepare(target(1)));
    await untilHeld(token);
    // Everything else is done, and no record yet.
    expect(await readyRecord(stub)).toEqual([]);
    await runInDurableObject(stub, () => token.open());

    expect(await reply.promise).toEqual({ ok: true, value: { sha: sha("a"), mergeBase: BASE } });
    expect(container.log).toEqual([...STARTED, ...rebuildLog("a", tokenOf(container))]);
    expect(container.starts).toEqual([{ enableInternet: false }]);
    expect(container.egress).toHaveLength(2);
    for (const exec of container.execs) {
      expect(exec.env).toEqual({
        GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: "/root",
      });
    }
    expect(await readyRecord(stub)).toEqual([
      { id: 1, remote: REMOTE, sha: sha("a"), base_sha: BASE, merge_base: BASE, token: tokenOf(container) },
    ]);
  });

  it("deepens the history, doubling, until the merge base answers, at most 8 rounds", async () => {
    captureLogs();
    const { stub, container } = newWorkspace("deepen");
    container.mergeBase = BASE;
    container.deepenNeeded = 3;
    expect(await stub.prepare(target(1))).toEqual({ ok: true, value: { sha: sha("a"), mergeBase: BASE } });
    expect(container.commands("--deepen=2")).toHaveLength(1);
    expect(container.commands("--deepen=4")).toHaveLength(1);
    expect(container.commands("--deepen=8")).toHaveLength(1);

    const never = newWorkspace("deepen");
    expect(await never.stub.prepare(target(1))).toEqual({ ok: true, value: { sha: sha("a"), mergeBase: null } });
    const rounds = never.container.log.filter((entry) => entry.includes("--deepen="));
    expect(rounds.map((entry) => /--deepen=(\d+)/.exec(entry)?.[1])).toEqual([
      "2",
      "4",
      "8",
      "16",
      "32",
      "64",
      "128",
      "256",
    ]);
  });

  it("refuses a checkout whose HEAD is not the commit, and marks nothing ready", async () => {
    captureLogs();
    const { stub, container } = newWorkspace("head");
    container.mergeBase = BASE;
    container.on = (argv) => (argv.includes("rev-parse") ? { stdout: `${sha("z")}\n` } : undefined);

    expect(await stub.prepare(target(1))).toEqual({
      ok: false,
      kind: "failed",
      reason: `HEAD is ${sha("z")}, not the commit ${sha("a")}`,
    });
    expect(container.commands("sh")).toEqual([]);
    expect(await readyRecord(stub)).toEqual([]);
  });

  it("reuses a ready checkout of the commit as it is", async () => {
    captureLogs();
    const { stub, container } = await prepared("reuse");
    const from = container.log.length;

    expect(await stub.prepare(target(1))).toEqual({ ok: true, value: { sha: sha("a"), mergeBase: BASE } });
    expect(container.log.slice(from)).toEqual([`cat -- ${DIR}/.git/prq-ready`]);
  });

  it("ends a prepare at 30 minutes as a whole, and not a tick sooner, killing the step it waits on", async () => {
    captureLogs();
    const { stub, container } = newWorkspace("prepare-bound");
    const fetch = container.holdNext((argv) => argv.includes("--depth=1"));
    container.on = (argv) => (argv.some((arg) => arg.startsWith("--deepen=")) ? { never: true } : undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const reply = tracked(stub.prepare(target(1)));
    // On the real clock: vi.waitFor would advance the fake one.
    await settles(() => fetch.reached(), "the fetch");
    // The fetch takes 20 minutes, then the deepen never answers: the bound is the prepare's, not a step's.
    await advance(stub, 20 * 60_000);
    await runInDurableObject(stub, () => fetch.open());
    await settles(() => container.commands("--deepen=2").length === 1, "the deepen");
    await advance(stub, PREPARE_MS - 20 * 60_000 - 1);
    expect(reply.settled()).toBe(false);
    await advance(stub, 1);

    expect(await reply.promise).toEqual({ ok: false, kind: "failed", reason: "the checkout took over 30 minutes" });
    expect(container.execs.at(-1)?.kills).toEqual([9]);
    expect(await inFlight(stub)).toBeNull();
  });

  it("ends a prepare whose container setup never answers at 30 minutes", async () => {
    captureLogs();
    const { stub, container } = newWorkspace("setup-bound");
    container.setupReply = (call) => (call === "idle" ? new Promise<void>(() => undefined) : Promise.resolve());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const reply = tracked(stub.prepare(target(1)));
    await settles(() => container.log.includes(`idle ${IDLE_STOP_MS}`), "the setup");
    await advance(stub, PREPARE_MS - 1);
    expect(reply.settled()).toBe(false);
    await advance(stub, 1);

    expect(await reply.promise).toEqual({ ok: false, kind: "failed", reason: "the checkout took over 30 minutes" });
    expect(container.execs).toEqual([]);
  });

  it("sets a running container up again when its setup failed, before the next prepare's first command", async () => {
    captureLogs();
    const { stub, container } = newWorkspace("setup-failed");
    container.mergeBase = BASE;
    let refused = false;
    container.setupReply = async (call) => {
      if (call === "intercept http" && !refused) {
        refused = true;
        throw new Error("the interception failed");
      }
    };
    expect(await stub.prepare(target(1))).toEqual({ ok: false, kind: "failed", reason: "the interception failed" });
    expect(container.running).toBe(true);
    const from = container.log.length;

    expect(await stub.prepare(target(2, "b"))).toEqual({ ok: true, value: { sha: sha("b"), mergeBase: BASE } });
    expect(container.log.slice(from)).toEqual([...SETUP, ...rebuildLog("b", tokenOf(container))]);
  });

  it("sets a running container up again after a reset cut its setup short, before the first command", async () => {
    captureLogs();
    const { name, stub: before, container } = newWorkspace("setup-reset");
    container.mergeBase = BASE;
    container.setupReply = (call) =>
      call === "intercept https" ? new Promise<void>(() => undefined) : Promise.resolve();
    void before.prepare(target(1)).catch(() => undefined);
    await vi.waitFor(() => expect(container.log).toContain("intercept https *"), { timeout: 3000, interval: 5 });
    const stub = await reset(name);
    container.setupReply = async () => undefined;
    const from = container.log.length;

    expect(await stub.prepare(target(2, "b"))).toEqual({ ok: true, value: { sha: sha("b"), mergeBase: BASE } });
    expect(container.log.slice(from)).toEqual([PKILL, ...SETUP, ...rebuildLog("b", tokenOf(container))]);
  });

  it("fails without an installation, touching no container", async () => {
    captureLogs();
    const { stub, container } = newWorkspace("installation");
    expect(await stub.prepare({ ...target(1), installationId: null })).toEqual({
      ok: false,
      kind: "failed",
      reason: "no GitHub App installation is known for this pull request",
    });
    expect(container.log).toEqual([]);
  });
});

describe("commands", () => {
  it("returns a page and git's exit, with the start of its stderr", async () => {
    captureLogs();
    const { stub, container } = await prepared("command");
    container.on = (argv) =>
      argv.includes("show") ? { exitCode: 128, stderr: "fatal: path 'nope' does not exist\n" } : undefined;
    const reply = await stub.run(target(1), readFile("nope"));
    expect(reply).toMatchObject({ ok: true, value: { exitCode: 128, stderr: "fatal: path 'nope' does not exist\n" } });
    expect(container.log.at(-1)).toBe(`git -C ${DIR} show --end-of-options ${sha("a")}:nope`);
  });

  it("collects at most the cap of a command's output, however large a page it is asked for, then kills it", async () => {
    captureLogs();
    const { stub, container } = await prepared("cap");
    const size = 1_000_000;
    container.on = (argv) => (argv.includes("show") ? { stdout: "x".repeat(size) } : undefined);
    const command = readFile("min.js");

    const reply = await stub.run(target(1), { ...command, page: { ...command.page, capChars: size } });

    expect(reply.ok).toBe(true);
    const value = reply.ok ? reply.value : null;
    expect(value?.page.lines[0]?.length).toBeLessThanOrEqual(OUTPUT_CAP_BYTES / 4);
    expect(value?.page.next).toEqual({ line: 1, char: value?.page.lines[0]?.length });
    // Cut by the page, not by git.
    expect(value?.exitCode).toBe(0);
    const show = container.execs.at(-1);
    expect(show?.kills).toEqual([9]);
    expect(show?.emitted).toBeLessThan(size);
  });

  it("reaches a page that starts beyond the byte cap of output, collecting at most the cap", async () => {
    captureLogs();
    const { stub, container } = await prepared("late");
    const lines = Array.from({ length: 200_000 }, (_, index) => `line ${String(index + 1).padStart(6, "0")}\n`);
    container.on = (argv) => (argv.includes("show") ? { stdout: lines.join(""), chunkBytes: 4096 } : undefined);

    const reply = await stub.run(target(1), readFile("big.txt", 150_000));

    expect(reply.ok).toBe(true);
    const page = reply.ok ? reply.value.page : null;
    expect(page?.lines[0]).toBe("line 150000");
    expect(page?.lines.length).toBeGreaterThan(100);
    expect(page?.lines.join("\n").length).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
    // The process is killed once the page is complete, long before its output ends.
    const show = container.execs.at(-1);
    expect(show?.kills).toEqual([9]);
    expect(show?.emitted).toBeLessThan(lines.join("").length);
  });

  it("ends a command at 60 s, and not a tick sooner", async () => {
    captureLogs();
    const { stub, container } = await prepared("timeout");
    container.on = (argv) => (argv.includes("show") ? { never: true } : undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const reply = tracked(stub.run(target(1), readFile("hang.txt")));
    await settles(() => container.commands("show").length === 1, "the command");
    await advance(stub, COMMAND_MS - 1);
    expect(reply.settled()).toBe(false);
    await advance(stub, 1);

    expect(await reply.promise).toEqual({ ok: false, kind: "command", reason: "the command took over 60 s" });
    expect(container.execs.at(-1)?.kills).toEqual([9]);
  });
});

describe("lost mid-turn", () => {
  it("prepares the same commit again when the container stopped between two commands", async () => {
    captureLogs();
    const { stub, container } = await prepared("lost");
    container.on = (argv) => (argv.includes("show") ? { stdout: "hello\n" } : undefined);
    await runInDurableObject(stub, () => container.stop());
    const from = container.log.length;

    const reply = await stub.run(target(1), readFile("README.md"));

    expect(reply).toMatchObject({ ok: true, value: { exitCode: 0, page: { lines: ["hello"] } } });
    expect(container.log.slice(from)).toEqual([
      ...STARTED,
      ...rebuildLog("a", tokenOf(container)),
      `git -C ${DIR} show --end-of-options ${sha("a")}:README.md`,
    ]);
  });

  it("fails the command as lost when the rebuild fails, running nothing in the empty directory", async () => {
    captureLogs();
    const { stub, container } = await prepared("lost-fails");
    await runInDurableObject(stub, () => container.stop());
    container.on = (argv) =>
      isFetch(argv) ? { exitCode: 128, stderr: "fatal: unable to access 'https://github.com/': 502\n" } : undefined;

    expect(await stub.run(target(1), readFile("README.md"))).toEqual({
      ok: false,
      kind: "failed",
      reason: "fetching the commits failed: fatal: unable to access 'https://github.com/': 502",
    });
    expect(container.commands("show")).toEqual([]);
  });
});

describe("rebuild ownership", () => {
  it("shares one rebuild between two commands of a turn after a stop", async () => {
    captureLogs();
    const { stub, container } = await prepared("single-flight");
    await runInDurableObject(stub, () => container.stop());
    container.on = (argv) => (argv.includes("show") ? { stdout: "hello\n" } : undefined);
    const fetch = container.holdNext(isFetch);
    const from = container.log.length;

    const one = stub.run(target(1), readFile("README.md"));
    const two = stub.run(target(1), readFile("README.md"));
    await untilHeld(fetch);
    await runInDurableObject(stub, () => fetch.open());

    for (const reply of await Promise.all([one, two])) {
      expect(reply).toMatchObject({ ok: true, value: { page: { lines: ["hello"] } } });
    }
    expect(container.commands("start", from)).toHaveLength(1);
    expect(container.commands("rm", from)).toHaveLength(1);
    expect(container.commands("init", from)).toHaveLength(1);
    expect(container.commands("fetch", from)).toHaveLength(1);
  });

  it("stops a turn's rebuild on its release, and clears it", async () => {
    captureLogs();
    const { stub, container } = newWorkspace("release");
    const fetch = container.holdNext(isFetch);

    const reply = stub.prepare(target(1));
    await untilHeld(fetch);
    await stub.release(1);

    expect(await within(Promise.resolve(reply), 1000)).toEqual(RELEASED);
    const held = container.execs.find((exec) => isFetch(exec.argv));
    expect(held?.signal?.aborted).toBe(true);
    expect(held?.kills).toEqual([9]);
    expect(await inFlight(stub)).toBeNull();
  });

  it("aborts an older turn's rebuild for a newer turn, which prepares its own commit at once", async () => {
    captureLogs();
    const { stub, container } = newWorkspace("supersede");
    container.mergeBase = BASE;
    const fetch = container.holdNext(isFetch);

    const old = tracked(stub.prepare(target(1, "a")));
    await untilHeld(fetch);
    // No clock advances: the newer turn does not wait out the older rebuild's bounds.
    expect(await within(Promise.resolve(stub.prepare(target(2, "b"))), 1000)).toEqual({
      ok: true,
      value: { sha: sha("b"), mergeBase: BASE },
    });
    expect(await old.promise).toEqual(SUPERSEDED);
    const held = container.execs.find((exec) => isFetch(exec.argv));
    expect(held?.signal?.aborted).toBe(true);
    expect(held?.kills).toEqual([9]);

    // A late call of the older turn changes nothing.
    const from = container.log.length;
    expect(await stub.run(target(1, "a"), readFile("README.md", 1, "a"))).toEqual(SUPERSEDED);
    expect(container.log.slice(from)).toEqual([]);
  });

  it("refuses a command whose turn is released during its ready check, starting no rebuild", async () => {
    captureLogs();
    const { stub, container } = await prepared("release-ready");
    // The token file is gone, so the ready check would lead to a rebuild.
    await runInDurableObject(stub, () => {
      if (container.disk !== null) {
        container.disk.token = null;
      }
    });
    const read = container.holdNext((argv) => argv[0] === "cat");

    const reply = tracked(stub.run(target(1), readFile("README.md")));
    await untilHeld(read);
    await stub.release(1);
    const from = container.log.length;
    await runInDurableObject(stub, () => read.open());

    expect(await reply.promise).toEqual(RELEASED);
    expect(container.log.slice(from)).toEqual([]);
  });

  it("refuses a command whose turn is released after its checkout is ready, before the command starts", async () => {
    captureLogs();
    const { stub, container } = await prepared("release-after-ready");
    container.on = (argv) => (argv.includes("show") ? { stdout: "hello\n" } : undefined);
    const from = container.log.length;

    // The prepare and the command share the ready check; once it has settled there is no prepare left to abort, and
    // the release lands before the command's turn is checked again.
    const reply = await runInDurableObject(stub, async (instance) => {
      const ready = instance.prepare(target(1));
      const command = instance.run(target(1), readFile("README.md"));
      void ready.then(() => instance.release(1));
      return command;
    });

    expect(reply).toEqual(RELEASED);
    expect(container.log.slice(from)).toEqual([`cat -- ${DIR}/.git/prq-ready`]);
  });

  it("never stops a newer turn's rebuild on an older turn's release", async () => {
    captureLogs();
    const { stub, container } = newWorkspace("late-release");
    container.mergeBase = BASE;
    const fetch = container.holdNext(isFetch);

    const reply = tracked(stub.prepare(target(2, "b")));
    await untilHeld(fetch);
    await stub.release(1);
    const held = container.execs.find((exec) => isFetch(exec.argv));
    expect(held?.signal?.aborted).toBe(false);
    await runInDurableObject(stub, () => fetch.open());

    expect(await reply.promise).toEqual({ ok: true, value: { sha: sha("b"), mergeBase: BASE } });
    expect(held?.kills).toEqual([]);
  });
});

describe("after a reset", () => {
  it("still refuses a released turn, and kills the old processes before the next turn's first command", async () => {
    captureLogs();
    const { name, stub: before, container } = await prepared("reset");
    await before.release(1);
    const stub = await reset(name);
    const from = container.log.length;

    expect(await stub.run(target(1), readFile("README.md"))).toEqual(RELEASED);
    expect(container.log.slice(from)).toEqual([PKILL]);

    container.mergeBase = BASE;
    expect(await stub.prepare(target(2, "b"))).toEqual({ ok: true, value: { sha: sha("b"), mergeBase: BASE } });
    // The new instance sets the running container up again before its first command.
    expect(container.log.slice(from, from + 5)).toEqual([PKILL, ...SETUP, `cat -- ${DIR}/.git/prq-ready`]);
  });

  it("kills an earlier instance's rm, so it cannot remove the next prepare's checkout", async () => {
    captureLogs();
    const { name, stub: before, container } = await prepared("cleanup-rm");
    // The token file is gone, so the next prepare rebuilds; its rm is held when the Workspace resets.
    await runInDurableObject(before, () => {
      if (container.disk !== null) {
        container.disk.token = null;
      }
    });
    const wipe = container.holdNext((argv) => argv[0] === "rm");
    void before.prepare(target(2)).catch(() => undefined);
    await untilHeld(wipe);
    const old = container.execs.at(-1);
    container.orphanProcesses();
    const stub = await reset(name);

    expect(await stub.prepare(target(3, "b"))).toEqual({ ok: true, value: { sha: sha("b"), mergeBase: BASE } });
    expect(old?.argv[0]).toBe("rm");
    expect(old?.kills).toEqual([9]);
    // Let the old rm go on, as a process the cleanup missed would: the new checkout stays.
    await runInDurableObject(stub, async () => {
      wipe.open();
      await scheduler.wait(10);
    });
    expect(container.disk?.head).toBe(sha("b"));
    expect(container.disk?.token).toBe(tokenOf(container));
  });

  it("starts no container operation of two concurrent calls before the one cleanup ends", async () => {
    captureLogs();
    const { name, container } = await prepared("cleanup-gate");
    container.on = (argv) => (argv.includes("show") ? { stdout: "hello\n" } : undefined);
    const pkill = container.holdNext((argv) => argv[0] === "pkill");
    const stub = await reset(name);
    const from = container.log.length;

    const one = tracked(stub.run(target(2), readFile("README.md")));
    const two = tracked(stub.run(target(2), readFile("README.md")));
    await untilHeld(pkill);
    await scheduler.wait(50);
    expect(container.log.slice(from)).toEqual([PKILL]);
    expect(one.settled() || two.settled()).toBe(false);
    await runInDurableObject(stub, () => pkill.open());

    for (const reply of await Promise.all([one.promise, two.promise])) {
      expect(reply).toMatchObject({ ok: true, value: { page: { lines: ["hello"] } } });
    }
    expect(container.commands("pkill", from)).toHaveLength(1);
    const after = container.execs.slice(container.execs.findIndex((exec) => exec.argv[0] === "pkill") + 1);
    expect(after.map((exec) => exec.kills)).toEqual(after.map(() => []));
  });

  it("stops the container when pkill fails, and opens the gate only once the stop is confirmed", async () => {
    captureLogs();
    const { name, container } = await prepared("cleanup-stop");
    container.on = (argv) => (argv[0] === "pkill" ? { reject: new Error("exec failed") } : undefined);
    const stop = container.holdStop();
    const stub = await reset(name);
    const from = container.log.length;

    const one = tracked(stub.prepare(target(2)));
    const two = tracked(stub.prepare(target(2)));
    await untilHeld(stop);
    await scheduler.wait(50);
    expect(container.log.slice(from)).toEqual([PKILL, "destroy"]);
    expect(one.settled() || two.settled()).toBe(false);
    container.mergeBase = BASE;
    await runInDurableObject(stub, () => stop.open());

    for (const reply of await Promise.all([one.promise, two.promise])) {
      expect(reply).toEqual({ ok: true, value: { sha: sha("a"), mergeBase: BASE } });
    }
    // The stopped container's checkout is gone: rebuilt from git init in a new container.
    expect(container.log.slice(from + 2)).toEqual([...STARTED, ...rebuildLog("a", tokenOf(container))]);
  });

  it("stops the container when pkill does not answer within 10 s", async () => {
    captureLogs();
    const { name, container } = await prepared("cleanup-pkill-timeout");
    container.on = (argv) => (argv[0] === "pkill" ? { never: true } : undefined);
    const stop = container.holdStop();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stub = await reset(name);
    const from = container.log.length;

    const reply = tracked(stub.prepare(target(2)));
    await settles(() => container.log.length > from, "the cleanup");
    await advance(stub, PKILL_MS - 1);
    expect(container.log.slice(from)).toEqual([PKILL]);
    await advance(stub, 1);
    expect(stop.reached()).toBe(true);
    container.mergeBase = BASE;
    await runInDurableObject(stub, () => stop.open());

    expect(await reply.promise).toEqual({ ok: true, value: { sha: sha("a"), mergeBase: BASE } });
    expect(container.commands("init", from)).toHaveLength(1);
  });

  it("fails every call when the stop is not confirmed within 30 s, until a newer turn cleans up again", async () => {
    captureLogs();
    const { name, container } = await prepared("cleanup-fails");
    container.on = (argv) => (argv[0] === "pkill" ? { reject: new Error("exec failed") } : undefined);
    container.destroyReply = async () => undefined;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stub = await reset(name);
    const from = container.log.length;

    const one = tracked(stub.prepare(target(2)));
    const two = tracked(stub.run(target(2), readFile("README.md")));
    await settles(() => container.commands("destroy", from).length === 1, "the stop");
    await advance(stub, STOP_MS - 1);
    expect(one.settled() || two.settled()).toBe(false);
    await advance(stub, 1);

    const reason = "pkill failed: exec failed, and the container was not confirmed stopped within 30 s";
    expect(await one.promise).toEqual({ ok: false, kind: "cleanup", reason });
    expect(await two.promise).toEqual({ ok: false, kind: "cleanup", reason });
    expect(container.log.slice(from)).toEqual([PKILL, "destroy"]);

    // The next turn tries again, and nothing runs before its cleanup ends: pkill now answers that no git runs.
    container.on = () => undefined;
    const retry = container.holdNext((argv) => argv[0] === "pkill");
    vi.useRealTimers();
    const next = tracked(stub.prepare(target(3)));
    await untilHeld(retry);
    await scheduler.wait(50);
    expect(container.log.slice(from + 2)).toEqual([PKILL]);
    expect(next.settled()).toBe(false);
    await runInDurableObject(stub, () => retry.open());
    expect(await next.promise).toEqual({ ok: true, value: { sha: sha("a"), mergeBase: BASE } });
    expect(container.commands("pkill", from)).toHaveLength(2);
  });
});
