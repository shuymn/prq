import { vValidator } from "@hono/valibot-validator";
import {
  type AgentPage,
  AgentQuery,
  type ErrorResponse,
  type LedgerPage,
  LedgerQuery,
  PrRef,
  type RepoPage,
  RepoQuery,
  RetryRequest,
  type RetryResponse,
  ROUTE_CALL_MS,
} from "@prq/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import { type CallBound, errorResponse, invalidRequest } from "./http.ts";
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
      // The Hub's pages (docs/design.md, PR ledger and Presence): the ledger's rows in the list's order under its
      // filters, the present agents, and the repositories for the list's menu. Each only reads, so one that lands after
      // the route stopped waiting changes nothing.
      .get("/ledger", vValidator("query", LedgerQuery, invalidRequest), async (c) => {
        const query = c.req.valid("query");
        const call = (async (): Promise<LedgerPage | ErrorResponse> => (await hubStub(c.env)).ledgerPage(query))();
        const result = await bound(call, ROUTE_CALL_MS, "the Hub's ledger page");
        return "error" in result ? errorResponse(c, result.error, result.detail) : c.json(result);
      })
      .get("/agents", vValidator("query", AgentQuery, invalidRequest), async (c) => {
        const { cursor } = c.req.valid("query");
        const call = (async (): Promise<AgentPage | ErrorResponse> => (await hubStub(c.env)).agentPage(cursor))();
        const result = await bound(call, ROUTE_CALL_MS, "the Hub's agent page");
        return "error" in result ? errorResponse(c, result.error, result.detail) : c.json(result);
      })
      .get("/repos", vValidator("query", RepoQuery, invalidRequest), async (c) => {
        const { cursor } = c.req.valid("query");
        const call = (async (): Promise<RepoPage | ErrorResponse> => (await hubStub(c.env)).repoPage(cursor))();
        const result = await bound(call, ROUTE_CALL_MS, "the Hub's repository page");
        return "error" in result ? errorResponse(c, result.error, result.detail) : c.json(result);
      })
  );
}
