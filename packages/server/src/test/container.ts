// A container for the Workspace tests, which run without containers: it records every operation in order and answers
// the prepare's commands as git would for a checkout it simulates (the commits fetched, HEAD, the ready token), and a
// tool's command with the output a test gives. A command can be held until a test lets it go, fail, or never end.
// Its promises and streams are made inside exec, so they belong to the Workspace's request: a test opens a hold, or
// changes the container, inside the Workspace (runInDurableObject).

import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";

import { Workspace, type WorkspaceContainer } from "../workspace.ts";

const encoder = new TextEncoder();

export type ExecCall = {
  argv: string[];
  env: Record<string, string> | undefined;
  signal: AbortSignal | undefined;
  // The signals kill() was called with, and the stdout bytes the process emitted.
  kills: number[];
  emitted: number;
};

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
    this.#exited = Promise.withResolvers<void>();
  }

  // The container stops (an idle stop, a crash, an eviction, a destroy): its disk goes with it.
  stop(): void {
    this.#running = false;
    this.disk = null;
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
    const call: ExecCall = { argv: [...cmd], env: options?.env, signal: options?.signal, kills: [], emitted: 0 };
    this.log.push(cmd.join(" "));
    this.execs.push(call);
    if (!this.#running) {
      throw new Error("the container is not running");
    }
    const index = this.#holds.findIndex((candidate) => candidate.match(call.argv));
    let hold: Promise<void> = Promise.resolve();
    if (index !== -1) {
      const [pending] = this.#holds.splice(index, 1);
      if (pending !== undefined && !pending.opened) {
        const waiting = Promise.withResolvers<void>();
        pending.reached = true;
        pending.release = waiting.resolve;
        hold = waiting.promise;
      }
    }
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

  // The commands a prepare and its cleanup run, as git and the shell answer them on the simulated disk.
  #simulate(argv: string[]): Reply {
    const [program, ...args] = argv;
    if (program === "pkill") {
      // pkill -KILL [-x] PATTERN: every process still running whose name matches (the whole name with -x).
      const source = args.at(-1) ?? "";
      const pattern = new RegExp(args.includes("-x") ? `^(?:${source})$` : source);
      const matched = [...this.#live].filter((live) => pattern.test(live.argv[0] ?? ""));
      for (const live of matched) {
        live.kill(9);
      }
      return { exitCode: matched.length > 0 ? 0 : 1 };
    }
    if (program === "rm") {
      this.disk = null;
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

// A process that answers once its hold lets it go: the reply is made then (a held command changes the simulated disk
// only when it goes on), its output streams in chunks, and it exits. kill() ends it at once with 137, its streams
// closed, and a held command then never answers; an orphaned process's kill settles nothing its starter waits on.
function fakeProcess(
  call: ExecCall,
  hold: Promise<void>,
  respond: () => Reply,
): { process: ExecProcess; orphan: () => void } {
  const exit = Promise.withResolvers<number>();
  const answered = Promise.withResolvers<Reply | null>();
  let killed = false;
  let orphaned = false;
  void hold.then(() => {
    if (killed) {
      return;
    }
    const reply = respond();
    answered.resolve(reply);
    if (reply.never !== true) {
      exit.resolve(reply.exitCode ?? 0);
    }
  });
  const stream = (bytesOf: (reply: Reply) => Uint8Array, counted: boolean): ReadableStream<Uint8Array> => {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const reply = await answered.promise;
        if (reply === null || killed || reply.never === true) {
          controller.close();
          return;
        }
        const bytes = bytesOf(reply);
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
