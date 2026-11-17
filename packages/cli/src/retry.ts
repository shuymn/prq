import { ROUTE_CALL_MS, waitBoundMs } from "@prq/protocol";

import { CliError, EXIT } from "./errors.ts";

// How long the client waits for a route beyond the route's own bound, so the route's 503 arrives before the client
// gives up; a client timeout is then a network or edge failure, retried like one.
export const CLIENT_MARGIN_MS = 5_000;

// The client's timeout for a route that answers within ROUTE_CALL_MS (claim, context, submit).
export const CALL_TIMEOUT_MS = ROUTE_CALL_MS + CLIENT_MARGIN_MS;

// The client's timeout for /cli/wait asked for timeoutMs: the route answers within the wait's bound plus ROUTE_CALL_MS.
export function waitTimeoutMs(timeoutMs: number | undefined): number {
  return waitBoundMs(timeoutMs) + ROUTE_CALL_MS + CLIENT_MARGIN_MS;
}

// Retries: 1 s after the first failure, doubling to 15 s. A command other than wait starts no attempt later than
// RETRY_WINDOW_MS after its first, whichever of its requests the attempt is for, so it ends within that plus one
// CALL_TIMEOUT_MS, under the 120 s a foreground command gets by default in Claude Code.
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

// One command's retry window: it opens at the command's first attempt and is shared by every request the command
// makes (a context's pages, a submit's claim and resubmit), so a later request does not start a window of its own.
export class RetryWindow {
  readonly clock: Clock;
  #first: number | null = null;
  #failure: string | null = null;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  // Before every attempt: the window opens at the first, and none starts after it closed.
  open(): void {
    const now = this.clock.now();
    this.#first ??= now;
    if (now - this.#first > RETRY_WINDOW_MS) {
      throw this.closed();
    }
  }

  // After a failed attempt: whether a backoff of delayMs still ends inside the window.
  failed(failure: Retryable, delayMs: number): boolean {
    this.#failure = failure.reason;
    return this.#first !== null && this.clock.now() + delayMs - this.#first <= RETRY_WINDOW_MS;
  }

  // The error that ends the command, naming the last failure.
  closed(): CliError {
    const reason = this.#failure ?? `its requests took more than ${RETRY_WINDOW_MS / 1000} s`;
    return new CliError(EXIT.error, `the server is unavailable (${reason}); try again`);
  }
}

// Makes attempts until one is not Retryable, within the command's window; past it, the command ends with exit 1. The
// window is checked before a backoff, so no sleep is spent on an attempt it rules out, and again before every attempt,
// since a sleep can end late (a machine that slept) and an earlier request can have used the window up. onStreak hears
// the first failure only: one stderr line per streak, not one per attempt.
export async function withRetry<T>(
  attempt: () => Promise<T | Retryable>,
  window: RetryWindow,
  onStreak: (failure: Retryable) => void,
): Promise<T> {
  for (let failures = 1; ; failures += 1) {
    window.open();
    const result = await attempt();
    if (!(result instanceof Retryable)) {
      return result;
    }
    if (failures === 1) {
      onStreak(result);
    }
    const delay = backoffMs(failures);
    if (!window.failed(result, delay)) {
      throw window.closed();
    }
    await window.clock.sleep(delay);
  }
}
