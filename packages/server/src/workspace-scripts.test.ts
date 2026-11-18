import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { parseTar } from "nanotar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SCRIPT_CALL_MS,
  STDERR_TAIL_CHARS,
  type ScriptResult,
  type ScriptRun,
  type WorkspaceCommand,
  type WorkspaceTarget,
} from "./pr-session/workspace.ts";
import { type FrameFile, runnerArgv } from "./skill-runner.ts";
import { captureLogs, events } from "./test/access.ts";
import {
  type ExecCall,
  type FakeContainer,
  frameOf,
  newWorkspace,
  type Hold,
  isRunnerArgv,
  runnerExecs,
  useFakeContainers,
} from "./test/container.ts";
import { tracked } from "./test/session.ts";
import { BASE, sha } from "./test/webhook.ts";
import { toolArgv } from "./workspace-git.ts";
import { RUNNER_MS, SCRIPT_MS, type Workspace, type WorkspaceReply } from "./workspace.ts";

// Skill scripts in the Workspace (docs/design.md, Workspace (cloud)): one exec of the container's runner per run, its
// frame written only to a caller still waiting, the turn's scratch record, the waits bounded, and no script ending ever
// stopping the container or signalling a runner. The container is a fake whose runner applies the real runner's checks
// in their order (the real runner's own test is skill-runner.node.test.ts).

beforeEach(() => {
  useFakeContainers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DIR = "/workspace/repo";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function target(seq: number, commit = "a"): WorkspaceTarget {
  return { fullName: "octo/demo", installationId: 7, sha: sha(commit), baseSha: BASE, seq };
}

const FILES: FrameFile[] = [
  { path: "SKILL.md", mode: "100644", content: encoder.encode("---\nname: polish\n---\nbody\n") },
  { path: "references/a.md", mode: "100644", content: encoder.encode("A\n") },
  { path: "scripts/check.py", mode: "100755", content: encoder.encode("print('ok')\n") },
];
const ARGV = ["python3", "/workspace/skills/polish/scripts/check.py", "--stance=説明"];

function scriptRun(overrides: Partial<ScriptRun> = {}): ScriptRun {
  return { name: "polish", files: FILES, argv: ARGV, stdin: "INPUT 入力", capChars: 10_000, ...overrides };
}

const readme: WorkspaceCommand = {
  argv: toolArgv.readFile(sha("a"), "README.md"),
  page: { start: { line: 1, char: 0 }, capChars: 11_800, numbered: true, detectBinary: true },
};

// A Workspace whose checkout of commit a is ready under turn 1.
async function prepared(label: string) {
  const workspace = newWorkspace(label);
  workspace.container.mergeBase = BASE;
  expect(await workspace.stub.prepare(target(1))).toEqual({ ok: true, value: { sha: sha("a"), mergeBase: BASE } });
  return workspace;
}

type Scratch = { scratch_seq: number; scratch_gen: number; scratch_established: number; scratch_pending: number };

async function scratchRecord(stub: DurableObjectStub<Workspace>): Promise<Scratch> {
  return runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<Scratch>(
        "SELECT scratch_seq, scratch_gen, scratch_established, scratch_pending FROM prq_workspace WHERE id = 1",
      )
      .one(),
  );
}

async function reset(name: string): Promise<DurableObjectStub<Workspace>> {
  await abortAllDurableObjects();
  return env.Workspace.getByName(name);
}

async function advance(stub: DurableObjectStub<Workspace>, ms: number): Promise<void> {
  await runInDurableObject(stub, () => vi.advanceTimersByTimeAsync(ms));
}

// Waits on the real clock for a check (under fake timers, vitest's waitFor advances them).
async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (check()) {
      return;
    }
    await scheduler.wait(20);
  }
  throw new Error(`${what}: not within 3 s`);
}

async function untilHeld(hold: Hold): Promise<void> {
  await until(() => hold.reached(), "the hold was not reached");
}

async function open(stub: DurableObjectStub<Workspace>, hold: { open(): void }): Promise<void> {
  await runInDurableObject(stub, () => hold.open());
}

function value(reply: WorkspaceReply<ScriptResult>): ScriptResult {
  if (!reply.ok) {
    throw new Error(`the run failed: ${reply.kind}: ${reply.reason}`);
  }
  return reply.value;
}

// The header line of the frame an exec received, as written.
function rawHeader(call: ExecCall | undefined): Record<string, unknown> {
  const bytes = call?.stdin.flatMap((chunk) => [...chunk]) ?? [];
  const end = bytes.indexOf(0x0a);
  return JSON.parse(decoder.decode(new Uint8Array(bytes.slice(0, end))));
}

function frame(call: ExecCall | undefined) {
  if (call === undefined) {
    throw new Error("no runner exec");
  }
  const read = frameOf(call);
  if (!("header" in read)) {
    throw new Error("the exec received no complete frame");
  }
  return read;
}

// No script ending stopped the container or signalled a process.
function untouched(container: FakeContainer): void {
  expect(container.log).not.toContain("destroy");
  expect(container.execs.flatMap((call) => call.kills)).toEqual([]);
}

describe("a run", () => {
  it("issues one exec, the runner's, once its scratch record is pending and durable, and frames the bundle, the input and the prepare's token", async () => {
    captureLogs();
    const { stub, container } = newWorkspace("frame");
    container.mergeBase = BASE;
    await runInDurableObject(stub, (_, state) => {
      const sync = state.storage.sync.bind(state.storage);
      vi.spyOn(state.storage, "sync").mockImplementation(async () => {
        container.log.push("sync started");
        await sync();
        container.log.push("sync done");
      });
    });
    // The exec reads the record as the runner is started.
    const held = container.holdExec(isRunnerArgv);
    const first = tracked(stub.runScript(target(1), scriptRun()));
    await untilHeld(held);
    expect(await scratchRecord(stub)).toEqual({
      scratch_seq: 1,
      scratch_gen: 1,
      scratch_established: 0,
      scratch_pending: 1,
    });
    await open(stub, held);
    expect(value(await first.promise)).toMatchObject({
      ending: { kind: "exit", code: 0 },
      scratch: "new",
      clean: true,
    });

    // A fresh prepare: after it, exactly the sync and the runner's exec.
    const ready = container.log.findIndex((entry) => entry.startsWith("sh -c"));
    expect(container.log.slice(ready + 1)).toEqual(["sync started", "sync done", runnerArgv("polish", ARGV).join(" ")]);
    const [call] = runnerExecs(container);
    expect(call?.env).toEqual({ PRQ_SCRIPT_S: String(SCRIPT_MS / 1000) });
    const firstFrame = frame(call);
    expect(firstFrame.header).toMatchObject({ seq: 1, gen: 1, first: true, token: container.disk?.token });
    expect(firstFrame.header.leftMs).toBeGreaterThan(0);
    expect(firstFrame.header.leftMs).toBeLessThanOrEqual(SCRIPT_CALL_MS);
    const header = rawHeader(call);
    expect(header.archiveBytes).toBe(firstFrame.archive.byteLength);
    expect(header.inputBytes).toBe(encoder.encode("INPUT 入力").byteLength);
    expect(decoder.decode(firstFrame.input)).toBe("INPUT 入力");
    expect(
      parseTar(firstFrame.archive).map((item) => ({
        path: item.name,
        type: item.type,
        mode: item.attrs?.mode,
        text: decoder.decode(item.data),
      })),
    ).toEqual(
      FILES.map((file) => ({
        path: file.path,
        type: "file",
        mode: file.mode === "100755" ? "0000755" : "0000644",
        text: decoder.decode(file.content),
      })),
    );
    expect(await scratchRecord(stub)).toEqual({
      scratch_seq: 1,
      scratch_gen: 1,
      scratch_established: 1,
      scratch_pending: 0,
    });

    // A reused checkout: its ready-token read, then the sync and the one exec.
    const from = container.log.length;
    expect(value(await stub.runScript(target(1), scriptRun()))).toMatchObject({ scratch: "kept" });
    expect(container.log.slice(from)).toEqual([
      `cat -- ${DIR}/.git/prq-ready`,
      "sync started",
      "sync done",
      runnerArgv("polish", ARGV).join(" "),
    ]);
    const second = frame(runnerExecs(container)[1]);
    expect(second.header).toMatchObject({ seq: 1, gen: 1, first: false, token: container.disk?.token });
    expect(second.header.nonce).not.toBe(firstFrame.header.nonce);
    expect(second.header.nonce).toMatch(/^[0-9a-f]{32}$/);
    untouched(container);
  });

  it("ends a script past SCRIPT_MS by the runner's own timeout, and the turn's next run goes on", async () => {
    captureLogs();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub, container } = await prepared("timeout");
    const hold = container.holdRunner("script");
    container.onScript = () => ({ timeout: true, stdout: "partial" });
    const reply = tracked(stub.runScript(target(1), scriptRun()));
    await untilHeld(hold);
    // Past the script's bound the Workspace does nothing: the runner ends it.
    await advance(stub, SCRIPT_MS + 1000);
    expect(reply.settled()).toBe(false);
    await open(stub, hold);
    expect(value(await reply.promise)).toMatchObject({
      ending: { kind: "timeout" },
      scratch: "new",
      clean: true,
      stdout: "partial",
    });

    container.onScript = () => ({ stdout: "ok\n" });
    expect(value(await stub.runScript(target(1), scriptRun()))).toMatchObject({
      ending: { kind: "exit", code: 0 },
      scratch: "kept",
      stdout: "ok\n",
    });
    untouched(container);
  });

  it("holds at most its caps of the streams, reads both to their ends, and counts only this run's trailer", async () => {
    captureLogs();
    const { stub, container } = await prepared("streams");
    const stdout = Array.from({ length: 3000 }, (_, i) => `line ${i} ✓`).join("\n");
    const stderr = `${"e".repeat(5000)}\nTraceback: the end\n${"f".repeat(32)} scratch=new end=exit:0 clean=1`;
    container.onScript = () => ({ exitCode: 3, stdout, stderr });

    const result = value(await stub.runScript(target(1), scriptRun({ capChars: 1000 })));

    expect(result.ending).toEqual({ kind: "exit", code: 3 });
    expect(result.stdout).toBe(stdout.slice(0, 1000));
    expect(result.stdoutChars).toBe(stdout.length);
    expect(result.stdoutBytes).toBe(encoder.encode(stdout).byteLength);
    // The script's last line, trailer-shaped with another nonce, is the script's: the tail keeps it.
    expect(result.stderr).toBe(stderr.slice(-STDERR_TAIL_CHARS));
    expect(result.stderrBytes).toBeGreaterThan(encoder.encode(stderr).byteLength);
    // Both streams were read to their ends.
    expect(runnerExecs(container)[0]?.emitted).toBe(encoder.encode(stdout).byteLength);
  });
});

describe("the frame gate", () => {
  it.each([
    {
      why: "its bound passed",
      giveUp: async (stub: DurableObjectStub<Workspace>) => advance(stub, RUNNER_MS),
      next: 1,
    },
    {
      why: "a newer turn superseded it",
      giveUp: async (stub: DurableObjectStub<Workspace>) => {
        expect(await stub.prepare(target(2))).toMatchObject({ ok: true });
      },
      next: 2,
    },
  ])("gives no frame to a runner whose caller gave up ($why) before its exec returned", async ({ giveUp, next }) => {
    const logs = captureLogs();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub, container } = await prepared("gate");
    const held = container.holdExec(isRunnerArgv);
    const a = tracked(stub.runScript(target(1), scriptRun()));
    await untilHeld(held);
    await giveUp(stub);
    expect(value(await a.promise).ending).toMatchObject({ kind: "not started" });
    expect((await scratchRecord(stub)).scratch_pending).toBe(0);

    // B runs and finishes.
    container.onScript = (script) => {
      script.scratch.set("b.txt", "B");
      return {};
    };
    expect(value(await stub.runScript(target(next), scriptRun({ stdin: "B" }))).ending).toEqual({
      kind: "exit",
      code: 0,
    });
    const before = structuredClone(container.runner);
    const spawned = container.spawned.length;

    // A's exec returns its handle now: the post-handle check ends its stdin with no byte.
    await open(stub, held);
    const [callA] = runnerExecs(container);
    await until(() => callA?.stdinEnded === true, "the stdin of A was not ended");
    expect(callA?.stdin).toEqual([]);
    expect(events(logs, "prq.workspace.frame_withheld")).toEqual([expect.objectContaining({ seq: 1 })]);
    await until(() => container.runnerEnds.at(-1)?.end === "failed:frame", "the runner of A did not end");
    expect(container.runner).toEqual(before);
    expect(container.spawned).toHaveLength(spawned);
    expect((await scratchRecord(stub)).scratch_pending).toBe(0);
    untouched(container);
  });
});

describe("the runner lock", () => {
  it("answers busy at once while a runner whose caller is gone holds it, and refuses that runner's authorization presented again", async () => {
    captureLogs();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub, container } = await prepared("busy");
    const hold = container.holdRunner("script");
    const a = tracked(stub.runScript(target(1), scriptRun()));
    await untilHeld(hold);
    // A's caller gives up at the exec's bound; its runner goes on inside the lock.
    await advance(stub, RUNNER_MS);
    expect(value(await a.promise).ending).toMatchObject({ kind: "unknown" });

    expect(value(await stub.runScript(target(1), scriptRun())).ending).toEqual({
      kind: "refused",
      end: { kind: "busy" },
    });
    await open(stub, hold);
    await until(() => !container.runner.locked, "the lock was not freed");
    const retried = value(await stub.runScript(target(1), scriptRun()));
    expect(retried).toMatchObject({ ending: { kind: "exit", code: 0 }, scratch: "lost" });
    expect(frame(runnerExecs(container)[2]).header).toMatchObject({ gen: 2, first: false });

    // A's frame, its turn, generation and token, presented to a new runner with the lock free.
    const [callA] = runnerExecs(container);
    const before = structuredClone(container.runner);
    const spawned = container.spawned.length;
    await runInDurableObject(stub, async () => {
      const replay = await container.exec(callA?.argv ?? [], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const writer = replay.stdin?.getWriter();
      for (const chunk of callA?.stdin ?? []) {
        await writer?.write(chunk);
      }
      await writer?.close();
      await replay.exitCode;
    });
    expect(container.runnerEnds.at(-1)?.end).toBe("failed:stale-scratch");
    expect(container.runner).toEqual(before);
    expect(container.spawned).toHaveLength(spawned);
    untouched(container);
  });
});

describe("git beside a script", () => {
  it("runs while a runner is live and after its caller's wait ended", async () => {
    captureLogs();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub, container } = await prepared("git");
    container.on = (argv) => (argv.includes("show") ? { stdout: "# demo\n" } : undefined);
    const hold = container.holdRunner("script");
    const a = tracked(stub.runScript(target(1), scriptRun()));
    await untilHeld(hold);
    expect(await stub.run(target(1), readme)).toMatchObject({ ok: true, value: { page: { lines: ["# demo"] } } });
    await advance(stub, RUNNER_MS);
    expect(value(await a.promise).ending).toMatchObject({ kind: "unknown" });
    expect(await stub.run(target(1), readme)).toMatchObject({ ok: true, value: { page: { lines: ["# demo"] } } });
    await open(stub, hold);
    untouched(container);
  });

  it("is never followed by a stop or a signal, whatever the script's ending", async () => {
    captureLogs();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub, container } = await prepared("endings");
    const endings: unknown[] = [];
    const runOnce = async () => {
      endings.push(value(await stub.runScript(target(1), scriptRun())).ending);
    };
    for (const reply of [
      { exitCode: 2 },
      { timeout: true },
      { clean: false },
      { trailer: "none" as const },
      { trailer: "foreign" as const },
      { rpcFailure: true },
    ]) {
      container.onScript = () => reply;
      await runOnce();
      container.runner.running = false;
    }
    // Each refusal of the runner.
    container.onScript = () => ({});
    container.runner.running = true;
    await runOnce();
    container.runner.running = false;
    // The token changes after the run's checkout was checked, before its runner reads it.
    const token = container.disk?.token ?? null;
    const lock = container.holdRunner("lock");
    const changed = tracked(runOnce());
    await untilHeld(lock);
    if (container.disk !== null) {
      container.disk.token = "0".repeat(32);
    }
    await open(stub, lock);
    await changed.promise;
    if (container.disk !== null) {
      container.disk.token = token;
    }
    container.runner.state = { seq: 1, gen: 99 };
    await runOnce();
    container.runner.state = { seq: 9, gen: 1 };
    await runOnce();
    container.runner.state = null;
    container.runner.locked = true;
    await runOnce();
    container.runner.locked = false;
    // The exec's RPC failing before its handle, and a gate that sent no frame.
    container.runnerReject = new Error("the exec RPC failed");
    await runOnce();
    container.runnerReject = null;
    const held = container.holdExec(isRunnerArgv);
    const gated = tracked(stub.runScript(target(1), scriptRun()));
    await untilHeld(held);
    await advance(stub, RUNNER_MS);
    endings.push(value(await gated.promise).ending);
    await open(stub, held);
    // A wait that ended at the exec's bound.
    const hold = container.holdRunner("script");
    const late = tracked(stub.runScript(target(1), scriptRun()));
    await untilHeld(hold);
    await advance(stub, RUNNER_MS);
    endings.push(value(await late.promise).ending);
    await open(stub, hold);

    expect(endings.map((ending) => JSON.stringify(ending))).toEqual([
      JSON.stringify({ kind: "exit", code: 2 }),
      JSON.stringify({ kind: "timeout" }),
      JSON.stringify({ kind: "exit", code: 0 }),
      JSON.stringify({ kind: "unknown", reason: "the runner ended without this run's trailer" }),
      JSON.stringify({ kind: "unknown", reason: "the runner ended without this run's trailer" }),
      JSON.stringify({ kind: "unknown", reason: "the RPC to the container failed" }),
      JSON.stringify({ kind: "refused", end: { kind: "failed", reason: "unclean", detail: null } }),
      JSON.stringify({ kind: "refused", end: { kind: "failed", reason: "checkout", detail: null } }),
      JSON.stringify({ kind: "refused", end: { kind: "failed", reason: "stale-scratch", detail: null } }),
      JSON.stringify({ kind: "refused", end: { kind: "failed", reason: "stale-turn", detail: null } }),
      JSON.stringify({ kind: "refused", end: { kind: "busy" } }),
      JSON.stringify({ kind: "not started", reason: "the exec RPC failed" }),
      JSON.stringify({ kind: "not started", reason: `the runner did not end within ${RUNNER_MS / 60_000} minutes` }),
      JSON.stringify({ kind: "unknown", reason: `the runner did not end within ${RUNNER_MS / 60_000} minutes` }),
    ]);
    untouched(container);
  });
});

describe("an unknown ending", () => {
  // Each way a run's wait ends after its frame with no ending seen, A's runner held inside the lock until then.
  const kinds = [
    {
      kind: "the exec's bound",
      sameTurn: true,
      end: async (stub: DurableObjectStub<Workspace>) => advance(stub, RUNNER_MS),
      reason: `the runner did not end within ${RUNNER_MS / 60_000} minutes`,
    },
    {
      kind: "a release",
      sameTurn: false,
      end: async (stub: DurableObjectStub<Workspace>) => stub.release(1),
      reason: "the turn has ended",
    },
    {
      kind: "a newer turn",
      sameTurn: false,
      end: async (stub: DurableObjectStub<Workspace>) => {
        expect(await stub.prepare(target(2))).toMatchObject({ ok: true });
      },
      reason: "superseded by a newer turn",
    },
  ];

  it.each(kinds)(
    "after $kind raises the turn's scratch generation: its next run makes the scratch again, a later turn's finds none",
    async ({ sameTurn, end, reason }) => {
      captureLogs();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { stub, container } = await prepared("unknown");
      container.onScript = (script) => {
        script.scratch.set(`${script.header.nonce}.txt`, "made");
        return {};
      };
      // A run that makes the scratch, then A, held.
      expect(value(await stub.runScript(target(1), scriptRun()))).toMatchObject({ scratch: "new" });
      const hold = container.holdRunner("script");
      const a = tracked(stub.runScript(target(1), scriptRun()));
      await untilHeld(hold);
      await end(stub);
      expect(value(await a.promise).ending).toEqual({ kind: "unknown", reason });
      expect(await scratchRecord(stub)).toMatchObject({ scratch_gen: 2, scratch_pending: 0 });
      await open(stub, hold);
      await until(() => !container.runner.locked, "the lock was not freed");

      // The turn's next run, when the turn may still run: its frame, and the scratch holding its file alone.
      const nextRun = async () => {
        const next = value(await stub.runScript(target(1), scriptRun()));
        const { seq, gen, first, nonce } = frame(runnerExecs(container).at(-1)).header;
        const files = [...(container.runner.scratch.get(1)?.keys() ?? [])];
        return {
          ending: next.ending,
          scratch: next.scratch,
          seq,
          gen,
          first,
          onlyItsFile: files.join() === `${nonce}.txt`,
        };
      };
      expect(sameTurn ? await nextRun() : null).toEqual(
        sameTurn
          ? { ending: { kind: "exit", code: 0 }, scratch: "lost", seq: 1, gen: 2, first: false, onlyItsFile: true }
          : null,
      );
      const later = value(await stub.runScript(target(3), scriptRun()));
      expect(later).toMatchObject({ ending: { kind: "exit", code: 0 }, scratch: "new" });
      expect(frame(runnerExecs(container).at(-1)).header).toMatchObject({ seq: 3, gen: 1, first: true });
      expect([...container.runner.scratch.keys()]).toEqual([3]);
      untouched(container);
    },
  );

  it.each([
    { kind: "an RPC failure", reply: { rpcFailure: true }, reason: "the RPC to the container failed" },
    {
      kind: "an exec that ends with no trailer",
      reply: { trailer: "none" as const },
      reason: "the runner ended without this run's trailer",
    },
    {
      kind: "an exec that ends with only another nonce's trailer",
      reply: { trailer: "foreign" as const },
      reason: "the runner ended without this run's trailer",
    },
  ])("after $kind raises it too, and the next run says the scratch was lost", async ({ reply, reason }) => {
    captureLogs();
    const { stub, container } = await prepared("unknown-exec");
    expect(value(await stub.runScript(target(1), scriptRun()))).toMatchObject({ scratch: "new" });
    container.onScript = () => reply;
    expect(value(await stub.runScript(target(1), scriptRun())).ending).toEqual({ kind: "unknown", reason });
    container.onScript = () => ({});
    expect(value(await stub.runScript(target(1), scriptRun()))).toMatchObject({
      ending: { kind: "exit", code: 0 },
      scratch: "lost",
    });
    expect(frame(runnerExecs(container).at(-1)).header).toMatchObject({ gen: 2, first: false });
  });

  it("leaves only a new turn's scratch when its first attempt ended unknown before the lock and its retry is not the turn's first", async () => {
    captureLogs();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub, container } = await prepared("retired");
    container.onScript = (script) => {
      script.scratch.set(`${script.header.seq}.txt`, "made");
      return {};
    };
    expect(value(await stub.runScript(target(1), scriptRun()))).toMatchObject({ scratch: "new" });
    // Turn 2's first attempt, held before the runner lock, ends unknown at the exec's bound.
    const hold = container.holdRunner("lock");
    const attempt = tracked(stub.runScript(target(2), scriptRun()));
    await untilHeld(hold);
    await advance(stub, RUNNER_MS);
    expect(value(await attempt.promise).ending).toMatchObject({ kind: "unknown" });
    // Its retry carries the raised generation and is not the turn's first frame.
    expect(value(await stub.runScript(target(2), scriptRun()))).toMatchObject({
      ending: { kind: "exit", code: 0 },
      scratch: "lost",
    });
    expect(frame(runnerExecs(container).at(-1)).header).toMatchObject({ seq: 2, gen: 2, first: false });
    expect([...container.runner.scratch.keys()]).toEqual([2]);
    // The first attempt's runner, let go, is refused and changes nothing.
    await open(stub, hold);
    await until(() => container.runnerEnds.length === 3, "the first attempt's ending");
    expect(container.runnerEnds.at(-1)?.end).toBe("failed:stale-scratch");
    expect([...container.runner.scratch.keys()]).toEqual([2]);
  });
});

describe("a call's bound", () => {
  it("ends an exec entered late at the call's bound, before RUNNER_MS, and a run queued behind it never starts", async () => {
    captureLogs();
    // The clock too: a run's deadline is its arrival's time and the bound.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { stub, container } = newWorkspace("bound");
    container.mergeBase = BASE;
    // Four runs arrive while the checkout's fetch takes 29 minutes.
    const fetch = container.holdNext((argv) => argv.includes("fetch"));
    const first = container.holdRunner("script");
    const runs = [1, 2, 3, 4].map((n) => tracked(stub.runScript(target(1), scriptRun({ stdin: `run ${n}` }))));
    await untilHeld(fetch);
    await advance(stub, 29 * 60_000);
    await open(stub, fetch);
    // Run 1 holds its runner until the exec's bound (32 minutes).
    await untilHeld(first);
    const second = container.holdExec(isRunnerArgv);
    await advance(stub, RUNNER_MS);
    expect(value(await runs[0]!.promise).ending).toMatchObject({ kind: "unknown" });
    await open(stub, first);
    // Run 2's exec does not return until its bound (35 minutes).
    await untilHeld(second);
    const third = container.holdRunner("script");
    await advance(stub, RUNNER_MS);
    expect(value(await runs[1]!.promise).ending).toMatchObject({ kind: "not started" });
    // Run 3 enters its exec with a minute left on its call's bound, which its frame tells the runner.
    await untilHeld(third);
    expect(frame(runnerExecs(container)[2]).header.leftMs).toBe(60_000);
    await advance(stub, 60_000 - 1);
    expect(runs[2]!.settled()).toBe(false);
    expect(runs[3]!.settled()).toBe(false);
    await advance(stub, 1);
    const reason = `the script call reached its bound of ${SCRIPT_CALL_MS / 60_000} minutes`;
    expect(value(await runs[2]!.promise).ending).toEqual({ kind: "unknown", reason });
    expect(value(await runs[3]!.promise).ending).toEqual({ kind: "not started", reason });
    // Run 3's runner then ends with another nonce's trailer; run 4 had no exec.
    container.onScript = () => ({ trailer: "foreign" });
    await open(stub, third);
    await open(stub, second);
    expect(runnerExecs(container)).toHaveLength(3);
    untouched(container);
  });

  // The pending record's durability wait held past the bound: its timer fires while the wait is still held, or the
  // wait ends just after the deadline with the timer not yet run.
  it.each([
    {
      by: "the bound's timer, the wait still held",
      pass: (stub: DurableObjectStub<Workspace>) => advance(stub, 1),
    },
    {
      by: "the wait ending at the deadline, before the timer",
      pass: async (stub: DurableObjectStub<Workspace>, durable: PromiseWithResolvers<void>) => {
        vi.setSystemTime(Date.now() + 1);
        await runInDurableObject(stub, () => durable.resolve());
      },
    },
  ])("ends a run whose record's durability wait passes its bound ($by), with no exec", async ({ pass }) => {
    captureLogs();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { stub, container } = await prepared("sync-bound");
    const durable = Promise.withResolvers<void>();
    let waited = false;
    await runInDurableObject(stub, (_, state) => {
      vi.spyOn(state.storage, "sync").mockImplementation(() => {
        waited = true;
        return durable.promise;
      });
    });
    const run = tracked(stub.runScript(target(1), scriptRun()));
    await until(() => waited, "the durability wait");
    await advance(stub, SCRIPT_CALL_MS - 1);
    expect(run.settled()).toBe(false);
    await pass(stub, durable);
    await until(() => run.settled(), "the Workspace's answer");
    const reason = `the script call reached its bound of ${SCRIPT_CALL_MS / 60_000} minutes`;
    expect(value(await run.promise).ending).toEqual({ kind: "not started", reason });
    expect(runnerExecs(container)).toHaveLength(0);
    expect(await scratchRecord(stub)).toMatchObject({ scratch_pending: 0 });
    await runInDurableObject(stub, () => durable.resolve());
  });
});

describe("a left running marker", () => {
  it("refuses every run as unclean while git serves the checkout, until the container restarts", async () => {
    captureLogs();
    const { stub, container } = await prepared("unclean");
    container.on = (argv) => (argv.includes("show") ? { stdout: "# demo\n" } : undefined);
    container.runner.running = true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(value(await stub.runScript(target(1), scriptRun())).ending).toEqual({
        kind: "refused",
        end: { kind: "failed", reason: "unclean", detail: null },
      });
      expect(await stub.run(target(1), readme)).toMatchObject({ ok: true, value: { page: { lines: ["# demo"] } } });
    }
    expect(container.spawned).toEqual([]);

    container.stop();
    expect(value(await stub.runScript(target(1), scriptRun()))).toMatchObject({
      ending: { kind: "exit", code: 0 },
      scratch: "new",
    });
    untouched(container);
  });
});

describe("a new instance", () => {
  it("raises a pending record's generation before its first exec, so a frame of the old instance is refused", async () => {
    captureLogs();
    const { name, stub, container } = await prepared("raise");
    const lock = container.holdRunner("lock");
    void stub.runScript(target(1), scriptRun({ stdin: "A" })).catch(() => undefined);
    await untilHeld(lock);
    expect(await scratchRecord(stub)).toMatchObject({ scratch_gen: 1, scratch_pending: 1 });

    // Every instance's durability waits, in the container's log beside its commands.
    await runInDurableObject(stub, (_, state) => {
      const storage: { sync: (this: DurableObjectStorage) => Promise<void> } = Object.getPrototypeOf(state.storage);
      const sync = storage.sync;
      vi.spyOn(storage, "sync").mockImplementation(async function (this: DurableObjectStorage) {
        await sync.call(this);
        container.log.push("synced");
      });
    });
    container.orphanProcesses();
    const cleanup = container.holdNext((argv) => argv.at(-1) === "--reset-cleanup");
    const fresh = await reset(name);
    const from = container.log.length;
    const b = tracked(fresh.runScript(target(1), scriptRun({ stdin: "B" })));
    await untilHeld(cleanup);
    // The raised record was made durable before the cleanup, the new instance's first exec.
    const first = container.log.slice(from);
    expect(
      first.slice(
        0,
        first.findIndex((entry) => entry.endsWith("--reset-cleanup")),
      ),
    ).toEqual(["synced"]);
    // The new instance's first exec: the record is raised already.
    expect(await scratchRecord(fresh)).toEqual({
      scratch_seq: 1,
      scratch_gen: 2,
      scratch_established: 1,
      scratch_pending: 0,
    });
    await open(fresh, cleanup);
    container.onScript = (script) => {
      script.scratch.set("b.txt", script.input);
      return {};
    };
    expect(value(await b.promise)).toMatchObject({ ending: { kind: "exit", code: 0 }, scratch: "lost" });
    expect(frame(runnerExecs(container).at(-1)).header).toMatchObject({ gen: 2, first: false });

    const before = structuredClone(container.runner);
    await open(fresh, lock);
    await until(() => container.runnerEnds.at(-1)?.end === "failed:stale-scratch", "the runner of A did not end");
    expect(container.runner).toEqual(before);
    expect(container.spawned.map((script) => script.input)).toEqual(["B"]);
  });

  it("leaves a record that is not pending as it is: a run's scratch is kept across an eviction", async () => {
    captureLogs();
    const { name, stub, container } = await prepared("evicted");
    container.onScript = (script) => {
      if (script.input === "run") {
        script.scratch.set("state.txt", "made");
      }
      return { stdout: script.scratch.get("state.txt") ?? "missing" };
    };
    expect(value(await stub.runScript(target(1), scriptRun({ stdin: "run" })))).toMatchObject({ scratch: "new" });
    const fresh = await reset(name);
    expect(value(await fresh.runScript(target(1), scriptRun({ stdin: "verify" })))).toMatchObject({
      scratch: "kept",
      stdout: "made",
    });
  });
});

describe("a prepare that changes the checkout", () => {
  it("removes the ready token first, so a runner admitted meanwhile is refused, and the next run carries the new token", async () => {
    captureLogs();
    const { stub, container } = await prepared("token");
    const lock = container.holdRunner("lock");
    const a = tracked(stub.runScript(target(1), scriptRun({ stdin: "A" })));
    await untilHeld(lock);
    const oldToken = container.disk?.token;

    // A newer push's run: its prepare is held after its first change, before its token.
    const fetch = container.holdNext((argv) => argv.includes("fetch"));
    const b = tracked(stub.runScript(target(2, "b"), scriptRun({ stdin: "B" })));
    await untilHeld(fetch);
    expect(value(await a.promise).ending).toMatchObject({ kind: "unknown", reason: "superseded by a newer turn" });
    expect(container.disk?.token).toBeNull();

    const before = structuredClone(container.runner);
    await open(stub, lock);
    await until(() => container.runnerEnds.at(-1)?.end === "failed:checkout", "the runner of A did not end");
    expect(container.runner).toEqual(before);
    expect(container.spawned).toEqual([]);

    await open(stub, fetch);
    expect(value(await b.promise)).toMatchObject({ ending: { kind: "exit", code: 0 }, scratch: "new" });
    const token = frame(runnerExecs(container).at(-1)).header.token;
    expect(token).toBe(container.disk?.token);
    expect(token).not.toBe(oldToken);
    expect(container.spawned.map((script) => script.input)).toEqual(["B"]);
  });
});
