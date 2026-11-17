import type { Page, PageRequest } from "./pages.ts";

// What a cloud job's tools read the code through (docs/design.md, Workspace (cloud)): a checkout of the job's commit,
// which runs git commands for the session. The Sandbox implements it from #5's container work; tests use an in-memory
// fake. Every call ends: the session races each against its turn's abort signal and a backstop, and an implementation
// bounds each command itself (60 s, and a page of output at most).

// The commit a job reads, and the pull request's base, which the checkout fetches too.
export type WorkspaceTarget = { sha: string; baseSha: string };

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
  // Runs one command in the checkout of the target's commit.
  run(target: WorkspaceTarget, command: WorkspaceCommand, signal: AbortSignal): Promise<CommandResult>;
}

// The longest a workspace call is waited for: a backstop over the workspace's own bounds (a command's 60 s, a
// checkout's 30 minutes), since any call may have to rebuild the checkout first. A tool call gets it as the AI SDK's
// `timeout.toolMs`; the prepare before a turn's first model call races it as well.
export const WORKSPACE_CALL_MS = 31 * 60_000;

// The most stderr a command returns: enough for git's message.
export const STDERR_CHARS = 1000;

// A workspace call that ended its wait: at the turn's abort or at the backstop. The call itself may still be running in
// the workspace, which ends it by its own bounds.
export function raceAbort<T>(call: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  const listening = new AbortController();
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true, signal: listening.signal });
  });
  return Promise.race([call, aborted]).finally(() => listening.abort());
}
