import { vValidator } from "@hono/valibot-validator";
import {
  ClaimRequest,
  type ClaimResponse,
  ContextRequest,
  type ContextResponse,
  type ErrorResponse,
  SubmitRequest,
  type SubmitResponse,
  WaitRequest,
  WaitResponse,
} from "@prq/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import { type CallBound, errorResponse, invalidRequest, ROUTE_CALL_MS } from "./http.ts";
import { waitBoundMs } from "./hub.ts";
import { hubStub, prSessionStub } from "./names.ts";

// /cli/*: what a local agent calls (docs/design.md, Notification and wait; Owner and jobs). Each call to a Durable
// Object, its start included, is bounded; when the bound passes the route answers 503 and the call keeps running.
export function cliRoutes(bound: CallBound) {
  return (
    new Hono<{ Bindings: Env }>()
      // Passed to the Hub as a request, whose signal ends the wait there: this request's when the agent goes away, or
      // the route's own when it stops waiting. The Hub answers within the wait's bound; the route allows ROUTE_CALL_MS
      // on top of it for the Hub's start.
      .post("/wait", vValidator("json", WaitRequest, invalidRequest), async (c) => {
        const body = c.req.valid("json");
        const stop = new AbortController();
        const request = new Request(c.req.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.any([c.req.raw.signal, stop.signal]),
        });
        const call = hubStub(c.env).then((hub) => hub.fetch(request));
        let res: Response;
        try {
          res = await bound(call, waitBoundMs(body.timeoutMs) + ROUTE_CALL_MS, "the Hub's wait");
        } catch (error) {
          stop.abort();
          throw error;
        }
        if (!res.ok) {
          throw new Error(`the Hub's wait answered ${res.status}`);
        }
        return c.json(v.parse(WaitResponse, await res.json()));
      })
      // A claim that lands after the route stopped waiting is a newer attempt than the agent's resend, so it can take
      // the job under another claimId. The agent's submit then gets stale_claim; it claims again and resubmits under the
      // run its answer was produced under, accepted only if no retry came since (docs/design.md, Owner and jobs).
      .post("/claim", vValidator("json", ClaimRequest, invalidRequest), async (c) => {
        const { agentId } = c.req.valid("json");
        const call = (async (): Promise<ClaimResponse> => (await hubStub(c.env)).claim(agentId))();
        return c.json(await bound(call, ROUTE_CALL_MS, "the Hub's claim"));
      })
      // A submit is a contact from the agent, whatever the session answers. One that lands after the route stopped
      // waiting stores the answer once; the agent's resend gets duplicate.
      .post("/submit", vValidator("json", SubmitRequest, invalidRequest), async (c) => {
        const { pr, ...submission } = c.req.valid("json");
        const call = (async (): Promise<SubmitResponse | ErrorResponse> => {
          await (await hubStub(c.env)).touch(submission.agentId);
          return (await prSessionStub(c.env, pr)).submit(submission);
        })();
        const result = await bound(call, ROUTE_CALL_MS, "the submit");
        return "error" in result ? errorResponse(c, result.error, result.detail) : c.json(result);
      })
      // A context is a contact from the agent too. It only reads the session, so one that lands after the route stopped
      // waiting changes no job; the agent's resend reads it again.
      .post("/context", vValidator("json", ContextRequest, invalidRequest), async (c) => {
        const { pr, agentId, jobId, claimId } = c.req.valid("json");
        const call = (async (): Promise<ContextResponse | ErrorResponse> => {
          await (await hubStub(c.env)).touch(agentId);
          return (await prSessionStub(c.env, pr)).context(agentId, jobId, claimId);
        })();
        const result = await bound(call, ROUTE_CALL_MS, "the context");
        return "error" in result ? errorResponse(c, result.error, result.detail) : c.json(result);
      })
  );
}
