import { ROUTE_CALL_MS, waitBoundMs } from "@prq/protocol";

import { CliError, EXIT } from "./errors.ts";

// How long the client waits for a route beyond the route's own bound, so the route's 503 arrives before the client
// gives up; a client timeout is then a network or edge failure, retried like one.
const CLIENT_MARGIN_MS = 5_000;

// The client's timeout for a route that answers within ROUTE_CALL_MS (claim, context, submit).
export const CALL_TIMEOUT_MS = ROUTE_CALL_MS + CLIENT_MARGIN_MS;

// The client's timeout for /cli/wait asked for timeoutMs: the route answers within the wait's bound plus ROUTE_CALL_MS.
export function waitTimeoutMs(timeoutMs: number | undefined): number {
  return waitBoundMs(timeoutMs) + ROUTE_CALL_MS + CLIENT_MARGIN_MS;
}

// Retries: 1 s after the first failure, doubling to 15 s. A command other than wait starts no attempt later than
// RETRY_WINDOW_MS after its first, so it ends within that plus one CALL_TIMEOUT_MS, under the 120 s a foreground command
// gets by default in Claude Code.
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 15_000;
export const RETRY_WINDOW_MS = 60_000;

// The delay after the nth failure in a row (n from 1).
export function backoffMs(failures: number): number {
  return Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS);
}

// An attempt that may be made again: the route answered 503, or the request failed at the network or timed out. Every
// route is safe to resend (docs/design.md, Notification and wait).
export class Retryable {
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }
}

export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const systemClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// Makes attempts until one is not Retryable, starting none later than RETRY_WINDOW_MS after the first; then the
// command ends with exit 1. The window is checked before a backoff, so no sleep is spent on an attempt it rules out,
// and again before the attempt, since a sleep can end late (a machine that slept). onStreak hears the first failure
// only: one stderr line per streak, not one per attempt.
export async function withRetry<T>(
  attempt: () => Promise<T | Retryable>,
  clock: Clock,
  onStreak: (failure: Retryable) => void,
): Promise<T> {
  const first = clock.now();
  for (let failures = 1; ; failures += 1) {
    const result = await attempt();
    if (!(result instanceof Retryable)) {
      return result;
    }
    if (failures === 1) {
      onStreak(result);
    }
    const delay = backoffMs(failures);
    const unavailable = () => new CliError(EXIT.error, `the server is unavailable (${result.reason}); try again`);
    if (clock.now() + delay - first > RETRY_WINDOW_MS) {
      throw unavailable();
    }
    await clock.sleep(delay);
    if (clock.now() - first > RETRY_WINDOW_MS) {
      throw unavailable();
    }
  }
}
