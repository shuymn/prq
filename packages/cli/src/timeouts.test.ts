import { ROUTE_CALL_MS, WAIT_MAX_MS, waitBoundMs } from "@prq/protocol";
import { describe, expect, it } from "vitest";

import { CALL_TIMEOUT_MS, CLIENT_MARGIN_MS, waitTimeoutMs } from "./retry.ts";

// Each route answers within its bound (packages/server/src/cli-routes.ts): ROUTE_CALL_MS for claim, context and
// submit, and the wait's bound plus ROUTE_CALL_MS for wait. The client waits CLIENT_MARGIN_MS (5 s, docs/design.md,
// Local CLI) longer, so the route's own 503 arrives before the client gives up.
describe("client timeouts", () => {
  it("allow a margin of 5 s", () => {
    expect(CLIENT_MARGIN_MS).toBe(5_000);
  });

  it.each([undefined, 0, 1, WAIT_MAX_MS - 1, WAIT_MAX_MS, 10 * WAIT_MAX_MS])(
    "are the wait route's bound plus the margin for timeoutMs %s",
    (timeoutMs) => {
      expect(waitTimeoutMs(timeoutMs)).toBe(waitBoundMs(timeoutMs) + ROUTE_CALL_MS + CLIENT_MARGIN_MS);
    },
  );

  it("are the other routes' bound plus the margin", () => {
    expect(CALL_TIMEOUT_MS).toBe(ROUTE_CALL_MS + CLIENT_MARGIN_MS);
  });
});
