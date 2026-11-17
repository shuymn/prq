import { describe, expect, it } from "vitest";

import { CliError } from "./errors.ts";
import { type Clock, Retryable, RETRY_WINDOW_MS, RetryWindow, withRetry } from "./retry.ts";

// A clock that moves only when the code under test sleeps or an attempt takes time; a sleep ends overshootMs late.
function fakeClock(overshootMs = 0): Clock & { advance(ms: number): void } {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms + overshootMs;
    },
    advance(ms) {
      now += ms;
    },
  };
}

// Attempts that each take attemptMs and fail until the nth succeeds; the start time of each is recorded.
function attempts(clock: ReturnType<typeof fakeClock>, attemptMs: number, succeedAt = Infinity) {
  const starts: number[] = [];
  const attempt = async (): Promise<string | Retryable> => {
    starts.push(clock.now());
    clock.advance(attemptMs);
    return starts.length === succeedAt ? "answer" : new Retryable("HTTP 503");
  };
  return { starts, attempt };
}

describe("withRetry", () => {
  it("backs off 1 s doubling to 15 s and starts no attempt later than the window", async () => {
    const clock = fakeClock();
    const { starts, attempt } = attempts(clock, 0);
    await expect(withRetry(attempt, new RetryWindow(clock), () => {})).rejects.toEqual(
      new CliError(1, "the server is unavailable (HTTP 503); try again"),
    );
    expect(starts).toEqual([0, 1_000, 3_000, 7_000, 15_000, 30_000, 45_000, 60_000]);
    expect(Math.max(...starts)).toBeLessThanOrEqual(RETRY_WINDOW_MS);
  });

  it("counts the attempts' own time against the window", async () => {
    const clock = fakeClock();
    const { starts, attempt } = attempts(clock, 10);
    await expect(withRetry(attempt, new RetryWindow(clock), () => {})).rejects.toBeInstanceOf(CliError);
    expect(starts).toEqual([0, 1_010, 3_020, 7_030, 15_040, 30_050, 45_060]);
  });

  it("starts no attempt after the window when a sleep ends late", async () => {
    const clock = fakeClock(65_000);
    const { starts, attempt } = attempts(clock, 0, 2);
    await expect(withRetry(attempt, new RetryWindow(clock), () => {})).rejects.toEqual(
      new CliError(1, "the server is unavailable (HTTP 503); try again"),
    );
    expect(starts).toEqual([0]);
  });

  it("returns the first answer, telling onStreak once", async () => {
    const clock = fakeClock();
    const { starts, attempt } = attempts(clock, 0, 4);
    const streaks: string[] = [];
    await expect(withRetry(attempt, new RetryWindow(clock), (failure) => streaks.push(failure.reason))).resolves.toBe(
      "answer",
    );
    expect(starts).toEqual([0, 1_000, 3_000, 7_000]);
    expect(streaks).toEqual(["HTTP 503"]);
  });
});
