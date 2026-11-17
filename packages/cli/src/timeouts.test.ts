import { ROUTE_CALL_MS, WAIT_MAX_MS, waitBoundMs } from "@prq/protocol";
import { describe, expect, it } from "vitest";

import { CALL_TIMEOUT_MS, waitTimeoutMs } from "./retry.ts";

// Each route answers within its bound (packages/server/src/cli-routes.ts): ROUTE_CALL_MS for claim, context and
// submit, and the wait's bound plus ROUTE_CALL_MS for wait. The client waits longer, so the route's own 503 arrives
// before the client gives up.
describe("client timeouts", () => {
  it.each([undefined, 0, 1, WAIT_MAX_MS - 1, WAIT_MAX_MS, 10 * WAIT_MAX_MS])(
    "exceed the wait route's bound for timeoutMs %s",
    (timeoutMs) => {
      expect(waitTimeoutMs(timeoutMs)).toBeGreaterThan(waitBoundMs(timeoutMs) + ROUTE_CALL_MS);
    },
  );

  it("exceed the other routes' bound", () => {
    expect(CALL_TIMEOUT_MS).toBeGreaterThan(ROUTE_CALL_MS);
  });
});
