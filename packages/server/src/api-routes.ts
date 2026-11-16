import { vValidator } from "@hono/valibot-validator";
import {
  type ErrorResponse,
  type LedgerPage,
  LedgerQuery,
  PrRef,
  RetryRequest,
  type RetryResponse,
} from "@prq/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import { type CallBound, errorResponse, invalidRequest, ROUTE_CALL_MS } from "./http.ts";
import { hubStub, prSessionStub } from "./names.ts";

// A job in a pull request's path. Owner and repository take any case and address the canonical session; the number is
// written without leading zeros.
const JobPath = v.object({
  owner: PrRef.entries.owner,
  repo: PrRef.entries.repo,
  number: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/), v.transform(Number), PrRef.entries.number),
  jobId: v.string(),
});

// /api/*: what the UI calls besides the Agents routes. Each call to a Durable Object, its start included, is bounded;
// when the bound passes the route answers 503 and the call keeps running.
export function apiRoutes(bound: CallBound) {
  return (
    new Hono<{ Bindings: Env }>()
      // The host's retry of a claimed or failed job, from the job's rev in the view the UI shows (docs/design.md, Owner
      // and jobs). The session applies it only while the job is still at that rev, so a retry that lands after the
      // route stopped waiting changes nothing once anything changed the job; it gets 409 stale_job.
      .post(
        "/pr/:owner/:repo/:number/jobs/:jobId/retry",
        vValidator("param", JobPath, invalidRequest),
        vValidator("json", RetryRequest, invalidRequest),
        async (c) => {
          const { jobId, ...pr } = c.req.valid("param");
          const { expectedRev } = c.req.valid("json");
          const call = (async (): Promise<RetryResponse | ErrorResponse> =>
            (await prSessionStub(c.env, pr)).retryJob(jobId, expectedRev))();
          const result = await bound(call, ROUTE_CALL_MS, "a session's retry");
          return "error" in result ? errorResponse(c, result.error, result.detail) : c.json(result);
        },
      )
      // The ledger's rows a page at a time, in the list's order (docs/design.md, PR ledger). The UI reads them again when
      // the Hub view's ledgerVersion or localAgentPresent changes. A page only reads, so one that lands after the route
      // stopped waiting changes nothing.
      .get("/ledger", vValidator("query", LedgerQuery, invalidRequest), async (c) => {
        const { cursor } = c.req.valid("query");
        const call = (async (): Promise<LedgerPage | ErrorResponse> => (await hubStub(c.env)).ledgerPage(cursor))();
        const result = await bound(call, ROUTE_CALL_MS, "the Hub's ledger page");
        return "error" in result ? errorResponse(c, result.error, result.detail) : c.json(result);
      })
  );
}
