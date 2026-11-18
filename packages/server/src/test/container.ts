// A container for the Workspace tests, which run without containers: it records every operation in order and answers
// the prepare's commands as git would for a checkout it simulates (the commits fetched, HEAD, the ready token), and a
// tool's command with the output a test gives. A command can be held until a test lets it go, fail, or never end.
// Its promises and streams are made inside exec, so they belong to the Workspace's request: a test opens a hold, or
// changes the container, inside the Workspace (runInDurableObject).

import { env } from "cloudflare:workers";
import { parseTar } from "nanotar";
import { expect, vi } from "vitest";

import type { FrameHeader } from "../skill-runner.ts";
import { Workspace, type WorkspaceContainer } from "../workspace.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type ExecCall = {
  argv: string[];
  env: Record<string, string> | undefined;
  signal: AbortSignal | undefined;
  // The signals kill() was called with, and the stdout bytes the process emitted.
  kills: number[];
  emitted: number;
  // The bytes written to the process's stdin, and whether it was ended.
  stdin: Uint8Array[];
  stdinEnded: boolean;
};

// The skill runner's state on the container's disk (container/prq-skill-run.py), lost with the disk: its lock, its
// state (the newest sequence and its scratch generation), its running marker, each turn's scratch directory (its files
// by name) and the installed skills (each file's mode and text).
export type RunnerDisk = {
  locked: boolean;
  state: { seq: number; gen: number } | null;
  running: boolean;
  scratch: Map<number, Map<string, string>>;
  skills: Map<string, Map<string, { mode: string; text: string }>>;
};

function emptyRunnerDisk(): RunnerDisk {
  return { locked: false, state: null, running: false, scratch: new Map(), skills: new Map() };
}

// A script as the fake runner runs it: the skill and its argv, the input, and the turn's scratch directory (which the
// script may change).
export type FakeScript = {
  name: string;
  argv: string[];
  input: string;
  header: FrameHeader;
  scratch: Map<string, string>;
  files: Map<string, { mode: string; text: string }>;
};

// How a script ends, as a test scripts it: an exit (0 by default) or its timeout, its output, whether the runner
// confirmed its processes ended, and its trailer (this run's, none, or one with another nonce); or never, or the RPC
// carrying the process failing after the frame (its streams and exit code reject).
export type ScriptReply = {
  exitCode?: number;
  timeout?: boolean;
  stdout?: string;
  stderr?: string;
  clean?: boolean;
  trailer?: "own" | "none" | "foreign";
  never?: boolean;
  rpcFailure?: boolean;
};

// Where a runner can be held: after its frame and before its lock, or inside its lock before its script ends.
export type RunnerStage = "lock" | "script";

const RUNNER_PATH = "/usr/local/libexec/prq-skill-run";

// Whether an exec is a script run's runner (not its reset cleanup), by the path and flag a test expects, apart from the
// Workspace's own argv builder.
export function isRunnerArgv(argv: readonly string[]): boolean {
  return argv[3] === RUNNER_PATH && argv[4] !== "--reset-cleanup";
}

const PREPARE_NAMES = /^(?:git|git-.*|rm|cat|sh)$/;

// How one command ends: its exit code and outputs (stdout as text or bytes, emitted in chunks), or never.
export type Reply = {
  exitCode?: number;
  stdout?: string | Uint8Array;
  stderr?: string;
  chunkBytes?: number;
  never?: boolean;
  // exec itself rejects.
  reject?: Error;
};

// A command held before it answers: whether one got there, and letting it go (inside the Workspace).
export type Hold = { reached(): boolean; open(): void };

type PendingHold = { match: (argv: string[]) => boolean; reached: boolean; opened: boolean; release: () => void };

// The checkout the container's disk holds.
type Disk = { remote: string | null; objects: Set<string>; head: string | null; token: string | null } | null;

// A setup call of the container: its interceptions and its idle stop.
export type SetupCall = "intercept http" | "intercept https" | "idle";

export class FakeContainer implements WorkspaceContainer {
  #running = false;
  // Whether HTTPS requests of the running container reach the egress: a fetch fails without it.
  #intercepted = false;
  // Every operation, in order: start, intercepts, the idle timeout, each exec's argv joined, destroy.
  readonly log: string[] = [];
  readonly execs: ExecCall[] = [];
  readonly starts: unknown[] = [];
  readonly egress: unknown[] = [];
  disk: Disk = null;
  runner: RunnerDisk = emptyRunnerDisk();
  // A test's script: how each run that gets past the runner's checks ends.
  onScript: (script: FakeScript) => ScriptReply = () => ({});
  // The scripts the runners spawned, in order.
  readonly spawned: FakeScript[] = [];
  // A runner's exec rejects with this error before it returns a process (the RPC failing).
  runnerReject: Error | null = null;
  // The ending of every runner, by nonce: its trailer's fields.
  readonly runnerEnds: { nonce: string; scratch: string; end: string; clean: boolean }[] = [];
  readonly #runnerHolds: { stage: RunnerStage; hold: PendingHold }[] = [];
  readonly #execHolds: PendingHold[] = [];
  // The merge base, and how many deepen rounds it takes to reach it.
  mergeBase: string | null = null;
  deepenNeeded = 0;
  #deepened = 0;
  // A test's answer to a command, or undefined for the simulated one.
  on: (argv: string[]) => Reply | undefined = () => undefined;
  // destroy(): stops the container unless a test changes it (holds or refuses the stop).
  destroyReply: () => Promise<void> = async () => this.stop();
  readonly #holds: PendingHold[] = [];
  // The processes that have not exited, by their argv.
  readonly #live = new Set<{ argv: string[]; kill(signal?: number): void; orphan(): void }>();
  #exited = Promise.withResolvers<void>();

  get running(): boolean {
    return this.#running;
  }

  start(options?: ContainerStartupOptions): void {
    this.log.push("start");
    this.starts.push(options);
    this.#running = true;
    this.#intercepted = false;
    this.disk = null;
    this.runner = emptyRunnerDisk();
    this.#exited = Promise.withResolvers<void>();
  }

  // The container stops (an idle stop, a crash, an eviction, a destroy): its disk goes with it.
  stop(): void {
    this.#running = false;
    this.disk = null;
    this.runner = emptyRunnerDisk();
    this.#exited.resolve();
  }

  // Each setup call answers at once, its setting made, unless a test changes it (a call that rejects or never
  // answers makes no setting).
  setupReply: (call: SetupCall) => Promise<void> = async () => undefined;

  async interceptAllOutboundHttp(binding: Fetcher): Promise<void> {
    this.log.push("intercept http");
    await this.setupReply("intercept http");
    this.egress.push(binding);
  }

  async interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void> {
    this.log.push(`intercept https ${addr}`);
    await this.setupReply("intercept https");
    this.egress.push(binding);
    this.#intercepted = true;
  }

  async setInactivityTimeout(durationMs: number | bigint): Promise<void> {
    this.log.push(`idle ${durationMs}`);
    await this.setupReply("idle");
  }

  monitor(): Promise<void> {
    return this.#exited.promise;
  }

  async destroy(): Promise<void> {
    this.log.push("destroy");
    await this.destroyReply();
  }

  // destroy() returns at once, and the container stops only when the hold is opened.
  holdStop(): Hold {
    const hold: PendingHold = { match: () => false, reached: false, opened: false, release: () => undefined };
    this.destroyReply = async () => {
      hold.reached = true;
      hold.release = () => this.stop();
    };
    return {
      reached: () => hold.reached,
      open: () => hold.release(),
    };
  }

  // Holds the next command that matches until the hold is opened.
  holdNext(match: (argv: string[]) => boolean): Hold {
    const hold: PendingHold = { match, reached: false, opened: false, release: () => undefined };
    this.#holds.push(hold);
    return {
      reached: () => hold.reached,
      open: () => {
        hold.opened = true;
        hold.release();
      },
    };
  }

  // Holds the next runner that reaches the stage until the hold is opened.
  holdRunner(stage: RunnerStage): Hold {
    const hold: PendingHold = { match: () => true, reached: false, opened: false, release: () => undefined };
    this.#runnerHolds.push({ stage, hold });
    return {
      reached: () => hold.reached,
      open: () => {
        hold.opened = true;
        hold.release();
      },
    };
  }

  // Holds the next exec that matches before it returns its process (a pending admission) until the hold is opened.
  holdExec(match: (argv: string[]) => boolean): Hold {
    const hold: PendingHold = { match, reached: false, opened: false, release: () => undefined };
    this.#execHolds.push(hold);
    return {
      reached: () => hold.reached,
      open: () => {
        hold.opened = true;
        hold.release();
      },
    };
  }

  // Takes out the first hold that matches and marks it reached: a promise of its opening (settled at once when none
  // matches or it was opened already).
  #reach<T>(holds: T[], matches: (entry: T) => boolean, holdOf: (entry: T) => PendingHold): Promise<void> {
    const index = holds.findIndex(matches);
    const [entry] = index === -1 ? [] : holds.splice(index, 1);
    const pending = entry === undefined ? undefined : holdOf(entry);
    if (pending === undefined || pending.opened) {
      return Promise.resolve();
    }
    const waiting = Promise.withResolvers<void>();
    pending.reached = true;
    pending.release = waiting.resolve;
    return waiting.promise;
  }

  // The running processes outlive the instance that started them, which a test is about to reset: that instance's
  // code is gone, so a later kill ends a process without resuming any of it.
  orphanProcesses(): void {
    for (const live of this.#live) {
      live.orphan();
    }
  }

  // The commands logged since a point, which contain the word.
  commands(word: string, from = 0): string[] {
    return this.log.slice(from).filter((entry) => entry.split(" ").includes(word));
  }

  async exec(cmd: string[], options?: ContainerExecOptions): Promise<ExecProcess> {
    const call: ExecCall = {
      argv: [...cmd],
      env: options?.env,
      signal: options?.signal,
      kills: [],
      emitted: 0,
      stdin: [],
      stdinEnded: false,
    };
    this.log.push(cmd.join(" "));
    this.execs.push(call);
    if (!this.#running) {
      throw new Error("the container is not running");
    }
    await this.#reach(
      this.#execHolds,
      (hold) => hold.match(call.argv),
      (hold) => hold,
    );
    if (isRunnerArgv(call.argv)) {
      if (this.runnerReject !== null) {
        throw this.runnerReject;
      }
      return this.#runnerProcess(call);
    }
    // Its handle returns at once; the command answers once its hold opens.
    const hold = this.#reach(
      this.#holds,
      (candidate) => candidate.match(call.argv),
      (candidate) => candidate,
    );
    const early = this.on(call.argv);
    if (early?.reject !== undefined) {
      throw early.reject;
    }
    const { process: child, orphan } = fakeProcess(call, hold, () => early ?? this.#simulate(call.argv));
    const live = { argv: call.argv, kill: (signal?: number) => child.kill(signal), orphan };
    this.#live.add(live);
    void child.exitCode.then(() => this.#live.delete(live));
    return child;
  }

  // A runner's process: it reads the frame only once the Workspace has written it and ended stdin (a stdin ended
  // without a complete frame changes nothing), applies the runner's checks in their order on the runner's disk, and
  // replies with the script's output and the trailer as the test scripts it.
  #runnerProcess(call: ExecCall): ExecProcess {
    const name = call.argv[call.argv.indexOf("--") - 1] ?? "";
    const argv = call.argv.slice(call.argv.indexOf("--") + 1);
    const stdinEnded = Promise.withResolvers<void>();
    const stdin = new WritableStream<Uint8Array>({
      write: (chunk) => {
        call.stdin.push(new Uint8Array(chunk));
      },
      close: () => {
        call.stdinEnded = true;
        stdinEnded.resolve();
      },
    });
    const outcome = stdinEnded.promise.then(() => this.#runScript(name, argv, joined(call.stdin)));
    const reply = outcome.then(({ nonce, scratch, end, script }): Reply => {
      if (script?.never === true) {
        return { never: true };
      }
      if (script?.rpcFailure === true) {
        throw new Error("the RPC to the container failed");
      }
      const clean = script?.clean ?? true;
      const trailerNonce = script?.trailer === "foreign" ? "f".repeat(32) : nonce;
      const trailer =
        script?.trailer === "none" ? "" : `\n${trailerNonce} scratch=${scratch} end=${end} clean=${clean ? 1 : 0}\n`;
      this.runnerEnds.push({ nonce, scratch, end, clean });
      return { exitCode: 0, stdout: script?.stdout ?? "", stderr: `${script?.stderr ?? ""}${trailer}` };
    });
    const { process: child, orphan } = fakeProcess(
      call,
      reply.then(
        () => undefined,
        () => undefined,
      ),
      () => {
        throw new Error("answered by the runner");
      },
      reply,
    );
    const live = { argv: call.argv, kill: (signal?: number) => child.kill(signal), orphan };
    this.#live.add(live);
    void child.exitCode.then(
      () => this.#live.delete(live),
      () => this.#live.delete(live),
    );
    return { ...child, stdin };
  }

  async #runScript(name: string, argv: string[], bytes: Uint8Array): Promise<RunnerOutcome & { nonce: string }> {
    const frame = readFrame(bytes);
    if (!("header" in frame)) {
      return { nonce: frame.nonce ?? "-", scratch: "-", end: "failed:frame" };
    }
    const { header } = frame;
    const received = Date.now();
    await this.#reach(
      this.#runnerHolds,
      (entry) => entry.stage === "lock",
      (entry) => entry.hold,
    );
    if (this.runner.locked) {
      return { nonce: header.nonce, scratch: "-", end: "busy" };
    }
    const disk = this.runner;
    disk.locked = true;
    try {
      const refusal = this.#refusal(header, received);
      if (refusal !== null) {
        return { nonce: header.nonce, scratch: "-", end: refusal };
      }
      const files = new Map<string, { mode: string; text: string }>();
      for (const item of parseTar(frame.archive)) {
        if (item.type !== "file") {
          return { nonce: header.nonce, scratch: "-", end: `failed:member ${JSON.stringify(item.name)}` };
        }
        files.set(item.name, { mode: item.attrs?.mode ?? "", text: decoder.decode(item.data) });
      }
      let scratch: string;
      if (header.first || disk.state === null || header.seq > disk.state.seq) {
        disk.scratch.clear();
        scratch = header.first ? "new" : "lost";
      } else if (disk.state?.seq === header.seq && disk.state.gen === header.gen && disk.scratch.has(header.seq)) {
        scratch = "kept";
      } else {
        disk.scratch.delete(header.seq);
        scratch = "lost";
      }
      if (scratch !== "kept") {
        disk.scratch.set(header.seq, new Map());
      }
      disk.state = { seq: header.seq, gen: header.gen };
      disk.skills.set(name, files);
      disk.running = true;
      const run: FakeScript = {
        name,
        argv,
        input: decoder.decode(frame.input),
        header,
        scratch: disk.scratch.get(header.seq) ?? new Map(),
        files,
      };
      await this.#reach(
        this.#runnerHolds,
        (entry) => entry.stage === "script",
        (entry) => entry.hold,
      );
      this.spawned.push(run);
      const script = this.onScript(run);
      if (script.clean !== false) {
        disk.running = false;
      }
      const end = script.timeout === true ? "timeout" : `exit:${script.exitCode ?? 0}`;
      return { nonce: header.nonce, scratch, end, script };
    } finally {
      disk.locked = false;
    }
  }

  // The runner's refusals, in its order, on its disk; null when the run may go on.
  #refusal(header: FrameHeader, received: number): string | null {
    const { state, running } = this.runner;
    if (running) {
      return "failed:unclean";
    }
    if (Date.now() >= received + header.leftMs) {
      return "failed:expired";
    }
    if (state !== null && header.seq < state.seq) {
      return "failed:stale-turn";
    }
    if (state?.seq === header.seq && (header.gen < state.gen || (header.gen === state.gen && header.first))) {
      return "failed:stale-scratch";
    }
    if (this.disk?.token !== header.token) {
      return "failed:checkout";
    }
    return null;
  }

  // The commands a prepare and its cleanup run, as git and the shell answer them on the simulated disk.
  #simulate(argv: string[]): Reply {
    const [program, ...args] = argv;
    if (argv[3] === RUNNER_PATH) {
      // The runner's reset cleanup: every process still running that a prepare starts (root's in the container),
      // never a runner (python3).
      const matched = [...this.#live].filter((live) => PREPARE_NAMES.test(live.argv[0] ?? ""));
      for (const live of matched) {
        live.kill(9);
      }
      return { exitCode: matched.length > 0 ? 0 : 1 };
    }
    if (program === "rm") {
      if (args[0] === "-f") {
        if (this.disk !== null) {
          this.disk.token = null;
        }
      } else {
        this.disk = null;
      }
      return { exitCode: 0 };
    }
    if (program === "cat") {
      return this.disk === null || this.disk.token === null
        ? { exitCode: 1, stderr: "cat: can't open the file: No such file or directory\n" }
        : { exitCode: 0, stdout: this.disk.token };
    }
    if (program === "sh") {
      if (this.disk === null) {
        return { exitCode: 2, stderr: "sh: can't create the file: nonexistent directory\n" };
      }
      this.disk.token = args[3] ?? null;
      return { exitCode: 0 };
    }
    if (program !== "git") {
      throw new Error(`a command the fake container does not know: ${argv.join(" ")}`);
    }
    if (args[0] === "init") {
      this.disk = { remote: null, objects: new Set(), head: null, token: null };
      this.#deepened = 0;
      return { exitCode: 0 };
    }
    const disk = this.disk;
    if (disk === null) {
      return { exitCode: 128, stderr: "fatal: cannot change to the checkout: No such file or directory\n" };
    }
    const git = args.slice(2).filter((arg, index, all) => arg !== "-c" && all[index - 1] !== "-c");
    const [command] = git;
    const operands = git.slice(git.indexOf("--end-of-options") + 1);
    switch (command) {
      case "remote":
        disk.remote = git.at(-1) ?? null;
        return { exitCode: 0 };
      case "fetch":
        if (!this.#intercepted) {
          return { exitCode: 128, stderr: "fatal: unable to access the remote: Could not resolve host: github.com\n" };
        }
        for (const sha of operands.slice(1)) {
          disk.objects.add(sha);
        }
        if (git.some((arg) => arg.startsWith("--deepen="))) {
          this.#deepened += 1;
        }
        return { exitCode: 0 };
      case "checkout": {
        const [sha = ""] = operands;
        if (!disk.objects.has(sha)) {
          return { exitCode: 128, stderr: `fatal: reference is not a tree: ${sha}\n` };
        }
        disk.head = sha;
        return { exitCode: 0 };
      }
      case "merge-base":
        return this.mergeBase !== null && this.#deepened >= this.deepenNeeded
          ? { exitCode: 0, stdout: `${this.mergeBase}\n` }
          : { exitCode: 1 };
      case "rev-parse":
        return { exitCode: 0, stdout: `${disk.head ?? ""}\n` };
      default:
        throw new Error(`a git command the fake container does not know: ${argv.join(" ")}`);
    }
  }
}

// --- The skill runner ---

type RunnerOutcome = { scratch: string; end: string; script?: ScriptReply };

// The frame an exec's stdin received, as a runner reads it.
export function frameOf(call: ExecCall): ReturnType<typeof readFrame> {
  return readFrame(joined(call.stdin));
}

// The runner execs among the execs, in order (not the reset cleanup).
export function runnerExecs(container: FakeContainer): ExecCall[] {
  return container.execs.filter((call) => isRunnerArgv(call.argv));
}

// The frame on a runner's stdin, read as the runner reads it: the header line, then exactly the declared archive and
// input; only the nonce (or null) when it is not complete or has more.
function readFrame(
  bytes: Uint8Array,
): { header: FrameHeader; archive: Uint8Array; input: Uint8Array } | { nonce: string | null } {
  const end = bytes.indexOf(0x0a);
  if (end === -1) {
    return { nonce: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes.subarray(0, end)));
  } catch {
    return { nonce: null };
  }
  const field = (key: string): unknown =>
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, key) : undefined;
  const nonce = field("nonce");
  const archiveBytes = field("archiveBytes");
  const inputBytes = field("inputBytes");
  if (typeof nonce !== "string" || typeof archiveBytes !== "number" || typeof inputBytes !== "number") {
    return { nonce: null };
  }
  if (bytes.byteLength !== end + 1 + archiveBytes + inputBytes) {
    return { nonce };
  }
  const header: FrameHeader = {
    nonce,
    seq: Number(field("seq")),
    gen: Number(field("gen")),
    first: field("first") === true,
    token: String(field("token")),
    leftMs: Number(field("leftMs")),
  };
  // Copies: nanotar's parseTar reads the view's whole buffer.
  const archive = bytes.slice(end + 1, end + 1 + archiveBytes);
  return { header, archive, input: bytes.slice(end + 1 + archiveBytes) };
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// A process that answers once its hold lets it go: the reply is made then (a held command changes the simulated disk
// only when it goes on), its output streams in chunks, and it exits. kill() ends it at once with 137, its streams
// closed, and a held command then never answers; an orphaned process's kill settles nothing its starter waits on.
function fakeProcess(
  call: ExecCall,
  hold: Promise<void>,
  respond: () => Reply,
  answer?: Promise<Reply>,
): { process: ExecProcess; orphan: () => void } {
  const exit = Promise.withResolvers<number>();
  // Settled for whoever reads the exit code; a failed RPC's rejection is not left unhandled when no one does.
  exit.promise.catch(() => undefined);
  const answered = Promise.withResolvers<Reply | null>();
  let killed = false;
  let orphaned = false;
  let failure: { error: unknown } | null = null;
  void hold.then(async () => {
    if (killed) {
      return;
    }
    let reply: Reply;
    try {
      reply = answer === undefined ? respond() : await answer;
    } catch (error) {
      if (orphaned) {
        return;
      }
      failure = { error };
      answered.resolve(null);
      exit.reject(error);
      return;
    }
    // An orphaned process's starter is gone: what it waited on stays unsettled.
    if (orphaned) {
      return;
    }
    answered.resolve(reply);
    if (reply.never !== true) {
      exit.resolve(reply.exitCode ?? 0);
    }
  });
  const stream = (bytesOf: (reply: Reply) => Uint8Array, counted: boolean): ReadableStream<Uint8Array> => {
    let offset = 0;
    // Encoded once, at the first pull after the reply.
    let encoded: Uint8Array | null = null;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const reply = await answered.promise;
        if (failure !== null) {
          controller.error(failure.error);
          return;
        }
        if (reply === null || killed || reply.never === true) {
          controller.close();
          return;
        }
        encoded ??= bytesOf(reply);
        const bytes = encoded;
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const chunk = bytes.slice(offset, offset + (reply.chunkBytes ?? 4096));
        offset += chunk.length;
        if (counted) {
          call.emitted += chunk.length;
        }
        controller.enqueue(chunk);
      },
    });
  };
  const process: ExecProcess = {
    stdin: null,
    stdout: stream(
      (reply) => (typeof reply.stdout === "string" ? encoder.encode(reply.stdout) : (reply.stdout ?? new Uint8Array())),
      true,
    ),
    stderr: stream((reply) => encoder.encode(reply.stderr ?? ""), false),
    pid: 1,
    isPty: false,
    exitCode: exit.promise,
    output: () => Promise.reject(new Error("the Workspace reads the streams")),
    kill: (signal?: number) => {
      call.kills.push(signal ?? 15);
      killed = true;
      if (!orphaned) {
        answered.resolve(null);
        exit.resolve(137);
      }
    },
    resize: () => undefined,
  };
  return {
    process,
    orphan: () => {
      orphaned = true;
    },
  };
}

const containers = new Map<string, FakeContainer>();

function containerOf(name: string): FakeContainer {
  let container = containers.get(name);
  if (container === undefined) {
    container = new FakeContainer();
    containers.set(name, container);
  }
  return container;
}

// The protected members of Workspace that tests replace or read. A type guard, not an assertion: it also fails a test
// at once when a member is renamed.
export type WorkspaceSeams = {
  container(): WorkspaceContainer;
  inFlight(): { seq: number; sha: string } | null;
};

function hasWorkspaceSeams(instance: object): instance is WorkspaceSeams {
  return ["container", "inFlight"].every((name) => typeof Reflect.get(instance, name) === "function");
}

export function workspaceSeams(instance: object): WorkspaceSeams {
  if (!hasWorkspaceSeams(instance)) {
    throw new TypeError("Workspace lacks a member the tests hold");
  }
  return instance;
}

// Every Workspace instance gets the fake container of its name. A reset instance gets the same container back, as a
// real one keeps running across a reset of its Durable Object.
export function useFakeContainers(): (name: string) => FakeContainer {
  vi.spyOn(workspaceSeams(Workspace.prototype), "container").mockImplementation(function (this: object) {
    const ctx: unknown = Reflect.get(this, "ctx");
    const id: unknown = typeof ctx === "object" && ctx !== null ? Reflect.get(ctx, "id") : undefined;
    const name: unknown = typeof id === "object" && id !== null ? Reflect.get(id, "name") : undefined;
    if (typeof name !== "string") {
      throw new TypeError("a Workspace is addressed by its name");
    }
    return containerOf(name);
  });
  return containerOf;
}

let counter = 0;

// A Workspace no other test uses, its name and its container.
export function newWorkspace(label: string): {
  name: string;
  stub: DurableObjectStub<Workspace>;
  container: FakeContainer;
} {
  counter += 1;
  const name = `octo~${label}~${counter}`;
  return { name, stub: env.Workspace.getByName(name), container: containerOf(name) };
}

// Waits until the hold has a command at it.
export async function untilHeld(hold: Hold): Promise<void> {
  await vi.waitFor(() => expect(hold.reached()).toBe(true), { timeout: 3000, interval: 5 });
}
