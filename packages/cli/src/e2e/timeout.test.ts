import { describe, expect, it } from "vitest";

import { CALL_TIMEOUT_MS } from "../retry.ts";
import { result, stderrLines } from "../test/cli.ts";
import { latch } from "../test/latch.ts";
import { useStack } from "../test/stack.ts";

const stack = useStack();

// In a file of its own: it waits out the client's timeout, so it runs beside the other files rather than after them.
describe("the client's timeout", () => {
  it(
    "a claim with no answer within the timeout is given up and sent again",
    async () => {
      const answered = latch();
      const release = latch();
      stack.access().plan("/cli/claim", { kind: "hold", answered, release });
      try {
        const exit = await stack.run(["claim", "--agent-id", "laptop"]);
        expect(exit.code).toBe(0);
        expect(result(exit)).toEqual({ job: null, next: "wait" });
        expect(stderrLines(exit)).toEqual(["prq: /cli/claim is unavailable (timed out); retrying"]);
        const [first, second] = stack.access().log;
        // The first request was never answered; the second started once the first timed out and the backoff passed.
        expect(first?.status).toBeNull();
        expect(second?.status).toBe(200);
        expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(CALL_TIMEOUT_MS);
      } finally {
        release.open();
      }
    },
    CALL_TIMEOUT_MS + 30_000,
  );
});
