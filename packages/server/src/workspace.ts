import { DurableObject } from "cloudflare:workers";

import { errorName, log } from "./log.ts";
import { pageLines } from "./pr-session/pages.ts";
import { TOOL_RESULT_CHARS } from "./pr-session/tools.ts";
import {
  type CommandResult,
  type PreparedWorkspace,
  STDERR_CHARS,
  type WorkspaceCommand,
  type WorkspaceTarget,
} from "./pr-session/workspace.ts";
import { migrate, WORKSPACE_SCHEMA } from "./schema.ts";
import {
  opArgv,
  type Checkout,
  prepareCheckout,
  type ReadyRecord,
  type RecordStore,
  type StepResult,
} from "./workspace-git.ts";

// The cloud workspace (docs/design.md, Workspace (cloud)): one Durable Object per session, driving its container. The
// container has no internet; every HTTP and HTTPS request it makes goes to GitEgress (egress.ts), which lets only git
// fetches of github.com through and adds the installation token, so the token never enters the container. A stopped
// container loses its disk, and the next call rebuilds the checkout from empty at the commit it names.
//
// One rebuild at a time, owned here: every call carries its turn's sequence number. The newest sequence seen and the
// highest one released are stored, so a reset forgets neither. A call acts only while its sequence is the newest and
// not released; that gate is checked again after every await and before every side effect, so a release or a newer
// turn that lands meanwhile stops it before its next step. Calls of one turn for one commit share the prepare in
// flight; a newer turn aborts an older turn's and waits for it to settle; a release aborts only its own turn's or an
// older one's. After a reset, a cleanup the constructor starts (the old instance's git may still run in the container)
// comes before every container operation of the new instance.

// The checkout's directory in the container, and the interception CA the container trusts for HTTPS. exec does not
// inherit start's environment, so every command gets the CA and the rest of git's environment itself.
const CHECKOUT_DIR = "/workspace/repo";
const EXEC_ENV = {
  GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: "/root",
};

// The container stops after 30 minutes without a request (owner's decision), losing its disk.
export const IDLE_STOP_MS = 30 * 60_000;
// A tool's command ends after 60 s.
export const COMMAND_MS = 60_000;
// A prepare ends after 30 minutes, whatever it is waiting on (git's own stall bound ends a stalled fetch sooner).
export const PREPARE_MS = 30 * 60_000;
// After a reset: the old instance's git is killed within 10 s, or the container is stopped and confirmed stopped
// within 30 s.
export const PKILL_MS = 10_000;
export const STOP_MS = 30_000;
// The most a command's page collects: 4 bytes for every character a result may hold. The page reader counts only
// what it collects, so a page however far into the output stays reachable.
export const OUTPUT_CAP_BYTES = 4 * TOOL_RESULT_CHARS;
// The most of a prepare step's stdout kept (a SHA, a token).
const STEP_STDOUT_CHARS = 1000;
const SIGKILL = 9;

// What the Workspace uses of its container.
export type WorkspaceContainer = Pick<
  Container,
  | "running"
  | "start"
  | "monitor"
  | "destroy"
  | "exec"
  | "interceptAllOutboundHttp"
  | "interceptOutboundHttps"
  | "setInactivityTimeout"
>;

// Why a call did not complete, as a value (an error's class does not cross RPC): refused (an older or released turn's
// call), cleanup (the cleanup after a reset failed), failed (the checkout could not be made ready), command (the
// command could not be run to its end).
export type WorkspaceFailure = { ok: false; kind: "refused" | "cleanup" | "failed" | "command"; reason: string };
export type WorkspaceReply<T> = { ok: true; value: T } | WorkspaceFailure;

class Refusal extends Error {
  override readonly name = "Refusal";
  readonly kind: "refused" | "cleanup";

  constructor(kind: "refused" | "cleanup", reason: string) {
    super(reason);
    this.kind = kind;
  }
}

const SUPERSEDED = "superseded by a newer turn";
const RELEASED = "the turn has ended";

// The prepare in flight: its turn and commit, what aborts it, and its outcome.
type Flight = { seq: number; sha: string; abort: AbortController; promise: Promise<Checkout>; settled: Promise<void> };

type Gate = { seq: number; released_through: number };
type ReadyRow = { remote: string; sha: string; base_sha: string; merge_base: string | null; token: string };

// A GitHub repository's owner/name, and a commit SHA: the only values a prepare puts into a URL or an argv.
const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*)\/[A-Za-z0-9._-]+$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The promise's outcome, or a rejection with the signal's reason as soon as it aborts. The promise is then left to
// settle on its own, its failure observed here.
async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => undefined);
  signal.throwIfAborted();
  const stop = Promise.withResolvers<never>();
  const onAbort = () => stop.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, stop.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// The outcome of a promise within ms, or "timeout".
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// A stream's text up to chars, read to its end (the rest dropped), so the process writing it is never blocked.
async function readCapped(stream: ReadableStream<Uint8Array> | null, chars: number): Promise<string> {
  if (stream === null) {
    return "";
  }
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    if (text.length < chars) {
      text += decoder.decode(chunk, { stream: true });
    }
  }
  return (text + decoder.decode()).slice(0, chars);
}

export class Workspace extends DurableObject<Env> {
  readonly #sql: SqlStorage;
  // The cleanup after a start of this instance: null once nothing of an earlier instance can still run in the
  // container, else why that could not be made sure.
  #cleanup: Promise<string | null>;
  #cleanupFailed = false;
  #flight: Flight | null = null;
  // The installation whose egress this instance set up on the running container, with the idle stop; null until a
  // setup completes. A running container does not show it was set up: a setup cut short (an abort, a reset) leaves
  // it running without its interception, so each instance sets it up before its first command.
  #setUpFor: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    migrate(ctx.storage, WORKSPACE_SCHEMA);
    this.#cleanup = this.#cleanUp();
  }

  // The container (spied on in tests, which run without containers).
  protected container(): WorkspaceContainer {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("this Durable Object has no container");
    }
    return container;
  }

  // Makes the checkout of the target's commit ready.
  async prepare(target: WorkspaceTarget): Promise<WorkspaceReply<PreparedWorkspace>> {
    try {
      this.#admit(target.seq);
      const { sha, mergeBase } = await this.#ensure(target);
      return { ok: true, value: { sha, mergeBase } };
    } catch (error) {
      return failure(error, "failed");
    }
  }

  // Runs one of the tools' git commands in the checkout of the target's commit, made ready again first if the
  // container or the checkout was lost since the last call.
  async run(target: WorkspaceTarget, command: WorkspaceCommand): Promise<WorkspaceReply<CommandResult>> {
    try {
      this.#admit(target.seq);
      await this.#ensure(target);
    } catch (error) {
      return failure(error, "failed");
    }
    try {
      return { ok: true, value: await this.#command(target.seq, command) };
    } catch (error) {
      return failure(error, "command");
    }
  }

  // The turn of seq has ended: its calls, and those of every older turn, are refused from now on, and the prepare in
  // flight is aborted when it is theirs. A newer turn's work is never touched.
  async release(seq: number): Promise<void> {
    this.#sql.exec("UPDATE prq_workspace SET released_through = max(released_through, ?) WHERE id = 1", seq);
    const flight = this.#flight;
    if (flight !== null && flight.seq <= seq) {
      flight.abort.abort(new Refusal("refused", RELEASED));
    }
  }

  // The prepare in flight, if any (for tests).
  protected inFlight(): { seq: number; sha: string } | null {
    return this.#flight === null ? null : { seq: this.#flight.seq, sha: this.#flight.sha };
  }

  // --- The gate ---

  #gate(): Gate {
    return this.#sql.exec<Gate>("SELECT seq, released_through FROM prq_workspace WHERE id = 1").one();
  }

  #refusal(seq: number, gate: Gate): Refusal | null {
    if (seq <= gate.released_through) {
      return new Refusal("refused", RELEASED);
    }
    return seq < gate.seq ? new Refusal("refused", SUPERSEDED) : null;
  }

  // A call's entry: refused for an older or released turn; a newer turn's raises the stored sequence, aborts an older
  // turn's prepare, and starts a new cleanup when the last one failed.
  #admit(seq: number): void {
    const gate = this.#gate();
    const refusal = this.#refusal(seq, gate);
    if (refusal !== null) {
      throw refusal;
    }
    if (seq > gate.seq) {
      this.#sql.exec("UPDATE prq_workspace SET seq = ? WHERE id = 1", seq);
      const flight = this.#flight;
      if (flight !== null && flight.seq < seq) {
        flight.abort.abort(new Refusal("refused", SUPERSEDED));
      }
      if (this.#cleanupFailed) {
        this.#cleanup = this.#cleanUp();
      }
    }
  }

  // Whether the call may still act: its sequence is the newest and not released.
  #check(seq: number): void {
    const gate = this.#gate();
    const refusal = this.#refusal(seq, gate) ?? (seq === gate.seq ? null : new Refusal("refused", SUPERSEDED));
    if (refusal !== null) {
      throw refusal;
    }
  }

  // Every container operation of this instance: after the cleanup, while the call may act and its signal has not
  // aborted; the wait for the operation ends when the signal aborts.
  async #gated<T>(
    seq: number,
    signal: AbortSignal,
    operation: (container: WorkspaceContainer) => T,
  ): Promise<Awaited<T>> {
    const cleanup = await this.#cleanup;
    if (cleanup !== null) {
      throw new Refusal("cleanup", cleanup);
    }
    this.#check(seq);
    signal.throwIfAborted();
    return untilAborted(Promise.resolve(operation(this.container())), signal);
  }

  // --- The cleanup after a start ---

  // Nothing of an earlier instance may run when this one runs git: its prepare may have been cut by a reset while its
  // fetch went on in the container. A container not running has nothing left; else every git process is killed, and
  // when that cannot be made sure, the container is stopped (its disk goes with it) and confirmed stopped. Only a
  // confirmed ending opens the gate; otherwise every call fails with the reason until a newer turn tries again.
  async #cleanUp(): Promise<string | null> {
    this.#cleanupFailed = false;
    let reason: string | null;
    try {
      reason = await this.#cleanUpContainer(this.container());
    } catch (error) {
      reason = messageOf(error);
    }
    this.#cleanupFailed = reason !== null;
    if (reason !== null) {
      log("prq.workspace.cleanup_failed", { workspace: this.ctx.id.name, reason }, "error");
    }
    return reason;
  }

  async #cleanUpContainer(container: WorkspaceContainer): Promise<string | null> {
    if (!container.running) {
      return null;
    }
    const kill = async (): Promise<string | null> => {
      const process = await container.exec(["pkill", "-KILL", "git"], { env: EXEC_ENV });
      const code = await process.exitCode;
      // 0: killed, 1: none was running.
      return code === 0 || code === 1 ? null : `pkill exited with ${code}`;
    };
    const killed = await within(
      kill().catch((error: unknown) => `pkill failed: ${messageOf(error)}`),
      PKILL_MS,
    );
    if (killed === null) {
      return null;
    }
    const why = killed === "timeout" ? `pkill did not answer within ${PKILL_MS / 1000} s` : killed;
    // The container is stopped instead: its disk, and so the checkout, go with it.
    this.#clearReady();
    const exited = container.monitor().then(
      () => true,
      () => true,
    );
    const destroyed = container.destroy().then(
      () => !container.running,
      () => false,
    );
    const confirmed = await within(Promise.race([exited, destroyed.then((stopped) => stopped || exited)]), STOP_MS);
    return confirmed === true ? null : `${why}, and the container was not confirmed stopped within ${STOP_MS / 1000} s`;
  }

  // --- Prepares ---

  // The target's checkout, ready: through the prepare in flight for this turn and commit, or a new one. An older
  // turn's prepare is aborted and waited for first, so two never run together.
  async #ensure(target: WorkspaceTarget): Promise<Checkout> {
    for (;;) {
      this.#check(target.seq);
      const flight = this.#flight;
      if (flight === null) {
        this.#flight = this.#fly(target);
        continue;
      }
      if (flight.seq === target.seq && flight.sha === target.sha) {
        const checkout = await flight.promise;
        this.#check(target.seq);
        return checkout;
      }
      flight.abort.abort(new Refusal("refused", SUPERSEDED));
      await flight.settled;
    }
  }

  #fly(target: WorkspaceTarget): Flight {
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new Error(`the checkout took over ${PREPARE_MS / 60_000} minutes`)),
      PREPARE_MS,
    );
    const started = Date.now();
    const promise = this.#prepareIn(target, abort.signal).finally(() => {
      clearTimeout(timer);
      if (this.#flight === flight) {
        this.#flight = null;
      }
    });
    const flight: Flight = {
      seq: target.seq,
      sha: target.sha,
      abort,
      promise,
      settled: promise.then(
        (checkout) => {
          log("prq.workspace.prepared", {
            workspace: this.ctx.id.name,
            sha: target.sha,
            plan: checkout.plan,
            ms: Date.now() - started,
          });
        },
        (error: unknown) => {
          log("prq.workspace.prepare_failed", {
            workspace: this.ctx.id.name,
            sha: target.sha,
            error: errorName(error),
          });
        },
      ),
    };
    return flight;
  }

  async #prepareIn(target: WorkspaceTarget, signal: AbortSignal): Promise<Checkout> {
    if (target.installationId === null) {
      throw new Error("no GitHub App installation is known for this pull request");
    }
    if (!FULL_NAME.test(target.fullName) || !SHA.test(target.sha) || !SHA.test(target.baseSha)) {
      throw new Error("the repository or a commit is not in GitHub's form");
    }
    await this.#start(target.seq, target.installationId, signal);
    const store: RecordStore = {
      read: () => {
        this.#check(target.seq);
        signal.throwIfAborted();
        return this.#readReady();
      },
      write: (record) => {
        this.#check(target.seq);
        signal.throwIfAborted();
        this.#sql.exec(
          `INSERT OR REPLACE INTO prq_ready (id, remote, sha, base_sha, merge_base, token) VALUES (1, ?, ?, ?, ?, ?)`,
          record.remote,
          record.sha,
          record.baseSha,
          record.mergeBase,
          record.token,
        );
      },
      clear: () => {
        this.#check(target.seq);
        signal.throwIfAborted();
        this.#clearReady();
      },
    };
    const remote = `https://github.com/${target.fullName}.git`;
    const token = crypto.randomUUID().replaceAll("-", "");
    return prepareCheckout(
      (argv) => this.#step(target.seq, argv, signal),
      store,
      CHECKOUT_DIR,
      { remote, sha: target.sha, baseSha: target.baseSha },
      token,
    );
  }

  // Starts the container when it is not running (no internet; a new container has an empty disk, so no checkout is
  // ready), then sets it up unless this instance already did for the installation: every HTTP and HTTPS request to
  // the egress with the installation, and the idle stop. Each call sets a rule or a timeout, so a repeated setup
  // replaces what an earlier one left.
  async #start(seq: number, installationId: number, signal: AbortSignal): Promise<void> {
    const running = await this.#gated(seq, signal, (container) => container.running);
    if (!running) {
      this.#setUpFor = null;
      this.#clearReady();
      await this.#gated(seq, signal, (container) => container.start({ enableInternet: false }));
    }
    if (this.#setUpFor === installationId) {
      return;
    }
    this.#setUpFor = null;
    const egress = this.ctx.exports.GitEgress({ props: { installationId } });
    await this.#gated(seq, signal, (container) => container.interceptAllOutboundHttp(egress));
    await this.#gated(seq, signal, (container) => container.interceptOutboundHttps("*", egress));
    await this.#gated(seq, signal, (container) => container.setInactivityTimeout(IDLE_STOP_MS));
    this.#setUpFor = installationId;
  }

  // One step of a prepare: its exit code and short outputs. The prepare's abort kills it and ends the step at once.
  async #step(seq: number, argv: readonly string[], signal: AbortSignal): Promise<StepResult> {
    const process = await this.#gated(seq, signal, (container) =>
      container.exec([...argv], { env: EXEC_ENV, signal, stdout: "pipe", stderr: "pipe" }),
    );
    const kill = () => process.kill(SIGKILL);
    signal.addEventListener("abort", kill, { once: true });
    try {
      const ended = Promise.all([
        readCapped(process.stdout, STEP_STDOUT_CHARS),
        readCapped(process.stderr, STDERR_CHARS),
        process.exitCode,
      ]);
      const [stdout, stderr, exitCode] = await untilAborted(ended, signal);
      return { exitCode, stdout, stderr };
    } finally {
      signal.removeEventListener("abort", kill);
    }
  }

  #readReady(): ReadyRecord | null {
    const row = this.#sql
      .exec<ReadyRow>("SELECT remote, sha, base_sha, merge_base, token FROM prq_ready WHERE id = 1")
      .toArray()[0];
    return row === undefined
      ? null
      : { remote: row.remote, sha: row.sha, baseSha: row.base_sha, mergeBase: row.merge_base, token: row.token };
  }

  #clearReady(): void {
    this.#sql.exec("DELETE FROM prq_ready");
  }

  // --- Commands ---

  // A tool's git command in the checkout, its page read as it streams: what comes before the page is only counted, and
  // the page collects at most OUTPUT_CAP_BYTES. Once the page is complete the process is killed (a page cut it, not
  // git, so it counts as exit 0); a command over 60 s is killed and fails.
  async #command(seq: number, command: WorkspaceCommand): Promise<CommandResult> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error(`the command took over ${COMMAND_MS / 1000} s`)),
      COMMAND_MS,
    );
    try {
      const { signal } = timeout;
      const process = await this.#gated(seq, signal, (container) =>
        container.exec(opArgv(CHECKOUT_DIR, command.argv), { env: EXEC_ENV, signal, stdout: "pipe", stderr: "pipe" }),
      );
      const kill = () => process.kill(SIGKILL);
      signal.addEventListener("abort", kill, { once: true });
      try {
        const page = { ...command.page, capChars: Math.min(command.page.capChars, OUTPUT_CAP_BYTES / 4) };
        const stderr = readCapped(process.stderr, STDERR_CHARS);
        stderr.catch(() => undefined);
        const read = async (): Promise<CommandResult> => {
          if (process.stdout === null) {
            throw new Error("the command has no output stream");
          }
          const paged = await pageLines(process.stdout, page);
          const ended = paged.lineCount !== null || paged.binaryBytes !== null;
          if (!ended) {
            kill();
          }
          const exitCode = ended ? await process.exitCode : 0;
          return { exitCode, page: paged, stderr: await stderr };
        };
        return await untilAborted(read(), signal);
      } finally {
        signal.removeEventListener("abort", kill);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function failure(error: unknown, kind: "failed" | "command"): WorkspaceFailure {
  if (error instanceof Refusal) {
    return { ok: false, kind: error.kind, reason: error.message };
  }
  return { ok: false, kind, reason: messageOf(error) };
}
