import { vValidator } from "@hono/valibot-validator";
import { type ErrorResponse, PrRef, type RetryResponse } from "@prq/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import { type CallBound, errorResponse, invalidRequest, ROUTE_CALL_MS } from "./http.ts";
import { prSessionStub } from "./names.ts";

// A job in a pull request's path. Owner and repository take any case and address the canonical session; the number is
// written without leading zeros.
const JobPath = v.object({
  owner: PrRef.entries.owner,
  repo: PrRef.entries.repo,
  number: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/), v.transform(Number), PrRef.entries.number),
  jobId: v.string(),
});

// /api/*: what the UI calls besides the Agents routes. Each call to a session, its start included, is bounded; when
// the bound passes the route answers 503 and the call keeps running.
export function apiRoutes(bound: CallBound) {
  return (
    new Hono<{ Bindings: Env }>()
      // The host's retry of a claimed or failed job (docs/design.md, Owner and jobs). The session refuses it after its
      // deadline, so one the route stopped waiting for changes nothing after the 503.
      .post("/pr/:owner/:repo/:number/jobs/:jobId/retry", vValidator("param", JobPath, invalidRequest), async (c) => {
        const { jobId, ...pr } = c.req.valid("param");
        const call = async (deadline: number): Promise<RetryResponse | ErrorResponse> =>
          (await prSessionStub(c.env, pr)).retryJob(jobId, deadline);
        const result = await bound(call, ROUTE_CALL_MS, "a session's retry");
        return "error" in result ? errorResponse(c, result.error, result.detail) : c.json(result);
      })
  );
}
