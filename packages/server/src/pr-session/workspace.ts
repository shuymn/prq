import { WaitTimeout } from "../wait.ts";
import type { Workspace, WorkspaceFailure } from "../workspace.ts";
import type { Page, PageRequest } from "./pages.ts";

// What a cloud job's tools read the code through (docs/design.md, Workspace (cloud)): a checkout of the job's commit,
// which runs git commands for the session. The Workspace (src/workspace.ts) implements it in a container; tests use an
// in-memory fake. Every call ends: the session races each against its turn's abort signal and a backstop, and the
// Workspace bounds each command itself (60 s, and a page of output at most).

// The commit a job reads; the pull request's base, which the checkout fetches too; the repository and the GitHub App
// installation whose token fetches them (null when no webhook named one); and the sequence number of the turn making
// the call, which the Workspace orders calls of different turns by.
export type WorkspaceTarget = {
  fullName: string;
  installationId: number | null;
  sha: string;
  baseSha: string;
  seq: number;
};

// A checkout made ready: its commit, and the merge base of the base and the commit when the history reaches it.
export type PreparedWorkspace = { sha: string; mergeBase: string | null };

// One git command, as argv after `git`, and the page of its output to return. Every argument the model gave follows
// `--end-of-options` or `--`, so none is read as an option.
export type WorkspaceCommand = { argv: readonly string[]; page: PageRequest };

// How a command ended: its exit code, its page of output (read through pageLines), and the start of its stderr.
export type CommandResult = { exitCode: number; page: Page; stderr: string };

export interface WorkspaceClient {
  // Makes the checkout of the target's commit ready (fetching it and the base), or fails with the reason.
  prepare(target: WorkspaceTarget, signal: AbortSignal): Promise<PreparedWorkspace>;
  // Runs one command in the checkout of the target's commit, rebuilding the checkout first when it was lost. Rejects
  // with WorkspaceLost when the turn cannot go on.
  run(target: WorkspaceTarget, command: WorkspaceCommand, signal: AbortSignal): Promise<CommandResult>;
  // The turn of this sequence has ended: work it started stops, and its later calls are refused.
  release(seq: number): Promise<void>;
}

// The start of the reason a job fails when its checkout was lost during the turn and the rebuild failed.
export const WORKSPACE_LOST = "workspace: lost and could not be rebuilt";
// The start of the reason a call fails when the Workspace could not make sure, after a restart, that nothing of its
// earlier instance still runs in the container.
export const CLEANUP_FAILED = "could not clean up after a restart";

// A workspace failure after which the turn cannot go on; its message is the job's failure reason. Any other failure of
// a command comes back to the model as text.
export class WorkspaceLost extends Error {
  override readonly name = "WorkspaceLost";
}

// The session's client of its Workspace. The Workspace answers failures as values (an error's class does not cross
// RPC); they are thrown here as the callers expect them. A call's signal is not sent: the caller stops waiting on it,
// and the turn's release stops what the Workspace is doing for it.
export function workspaceClient(stub: Pick<Workspace, "prepare" | "run" | "release">): WorkspaceClient {
  return {
    prepare: async (target) => {
      const reply = await stub.prepare(target);
      if (!reply.ok) {
        throw new Error(reply.kind === "cleanup" ? `${CLEANUP_FAILED}: ${reply.reason}` : reply.reason);
      }
      return reply.value;
    },
    run: async (target, command) => {
      const reply = await stub.run(target, command);
      if (!reply.ok) {
        throw runFailure(reply);
      }
      return reply.value;
    },
    release: (seq) => stub.release(seq),
  };
}

function runFailure(failure: WorkspaceFailure): Error {
  switch (failure.kind) {
    case "failed":
      return new WorkspaceLost(`${WORKSPACE_LOST}: ${failure.reason}`);
    case "cleanup":
      return new WorkspaceLost(`workspace: ${CLEANUP_FAILED}: ${failure.reason}`);
    default:
      return new Error(failure.reason);
  }
}

// The longest a workspace call is waited for: a backstop over the workspace's own bounds (a command's 60 s, a
// checkout's 30 minutes), since any call may have to rebuild the checkout first. A tool call gets it as the AI SDK's
// `timeout.toolMs`; the prepare before a turn's first model call races it as well.
export const WORKSPACE_CALL_MS = 31 * 60_000;

// The most stderr a command returns: enough for git's message.
export const STDERR_CHARS = 1000;

// Waits for a workspace call until it settles, the signal aborts, or, when given, the backstop passes (a WaitTimeout).
// A call is not started once the signal has aborted, so no call's failure goes unobserved. Every ending removes the
// abort listener and clears the timer; the call itself may still be running in the workspace, which ends it by its own
// bounds.
export function raceAbort<T>(start: () => Promise<T>, signal: AbortSignal, backstopMs?: number): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  const call = start();
  const ended = Promise.withResolvers<never>();
  const onAbort = (): void => ended.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timer =
    backstopMs === undefined
      ? undefined
      : setTimeout(() => ended.reject(new WaitTimeout(`the workspace took over ${backstopMs} ms`)), backstopMs);
  return Promise.race([call, ended.promise]).finally(() => {
    signal.removeEventListener("abort", onAbort);
    clearTimeout(timer);
  });
}
