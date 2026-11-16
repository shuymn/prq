import { describe, expect, it, vi } from "vitest";

import { latch } from "./test/latch.ts";
import { SerialQueue, WaitTimeout, withTimeout } from "./wait.ts";

describe("withTimeout", () => {
  it("passes the outcome through and fails a wait that takes too long, leaving no timer", async () => {
    vi.useFakeTimers();
    try {
      await expect(withTimeout(Promise.resolve("done"), 1000, "a call")).resolves.toBe("done");
      await expect(withTimeout(Promise.reject(new Error("failed")), 1000, "a call")).rejects.toThrow("failed");
      const held = latch();
      const outcome = withTimeout(held.promise, 1000, "a call").catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await outcome).toBeInstanceOf(WaitTimeout);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SerialQueue", () => {
  it("runs queued writes in order, also after one fails", async () => {
    const queue = new SerialQueue("a write", 1000);
    const started = latch();
    const held = latch();
    const order: string[] = [];
    const first = queue.run(async () => {
      order.push("first");
      started.open();
      await held.promise;
      order.push("first ends");
      throw new Error("first failed");
    });
    const second = queue.run(async () => {
      order.push("second");
    });
    // The first write runs and is held; the second waits for it.
    await started.promise;
    expect(order).toEqual(["first"]);

    held.open();

    await expect(first).rejects.toThrow("first failed");
    await second;
    expect(order).toEqual(["first", "first ends", "second"]);
  });

  it("fails a write that waits too long without running it, and keeps later writes behind the earlier ones", async () => {
    vi.useFakeTimers();
    try {
      const queue = new SerialQueue("a write", 1000);
      const held = latch();
      const ran: string[] = [];
      const first = queue.run(() => held.promise);
      const late = queue.run(async () => {
        ran.push("late");
      });
      const outcome = late.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await outcome).toBeInstanceOf(WaitTimeout);
      const next = queue.run(async () => {
        ran.push("next");
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(ran).toEqual([]);

      held.open();

      await first;
      await next;
      expect(ran).toEqual(["next"]);
      // Every wait's timer is gone once its task has started or failed.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
