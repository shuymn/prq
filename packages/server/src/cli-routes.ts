import { vValidator } from "@hono/valibot-validator";
import {
  ClaimRequest,
  type ClaimResponse,
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
      // on top of it for the Hub's start. It changes no job, so it carries no deadline.
      .post("/wait", vValidator("json", WaitRequest, invalidRequest), async (c) => {
        const body = c.req.valid("json");
        const stop = new AbortController();
        const request = new Request(c.req.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.any([c.req.raw.signal, stop.signal]),
        });
        const call = async () => (await hubStub(c.env)).fetch(request);
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
      // The Hub and each session refuse the claim after its deadline, so one the route stopped waiting for claims
      // nothing after the 503.
      .post("/claim", vValidator("json", ClaimRequest, invalidRequest), async (c) => {
        const { agentId } = c.req.valid("json");
        const call = async (deadline: number): Promise<ClaimResponse | ErrorResponse> =>
          (await hubStub(c.env)).claim(agentId, deadline);
        const result = await bound(call, ROUTE_CALL_MS, "the Hub's claim");
        return "error" in result ? errorResponse(c, result.error, result.detail) : c.json(result);
      })
      // A submit is a contact from the agent, whatever the session answers. It carries no deadline: only the job's
      // current claim, held by this agent, stores an answer, and only once, so one that lands after the route stopped
      // waiting stores what the agent's resend would, and the resend gets duplicate.
      .post("/submit", vValidator("json", SubmitRequest, invalidRequest), async (c) => {
        const { pr, ...submission } = c.req.valid("json");
        const call = async (): Promise<SubmitResponse | ErrorResponse> => {
          await (await hubStub(c.env)).touch(submission.agentId);
          return (await prSessionStub(c.env, pr)).submit(submission);
        };
        const result = await bound(call, ROUTE_CALL_MS, "the submit");
        return "error" in result ? errorResponse(c, result.error, result.detail) : c.json(result);
      })
  );
}
