import { vValidator } from "@hono/valibot-validator";
import { ClaimRequest, SubmitRequest, WaitRequest, WaitResponse } from "@prq/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import { errorResponse, invalidRequest } from "./http.ts";
import { hubStub, prSessionStub } from "./names.ts";

// /cli/*: what a local agent calls (docs/design.md, Notification and wait; Owner and jobs).
export const cliRoutes = new Hono<{ Bindings: Env }>()
  // Passed to the Hub as a request carrying this request's signal, so the wait ends when the agent goes away.
  .post("/wait", vValidator("json", WaitRequest, invalidRequest), async (c) => {
    const hub = await hubStub(c.env);
    const res = await hub.fetch(
      new Request(c.req.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(c.req.valid("json")),
        signal: c.req.raw.signal,
      }),
    );
    if (!res.ok) {
      throw new Error(`the Hub's wait answered ${res.status}`);
    }
    return c.json(v.parse(WaitResponse, await res.json()));
  })
  .post("/claim", vValidator("json", ClaimRequest, invalidRequest), async (c) => {
    const hub = await hubStub(c.env);
    return c.json(await hub.claim(c.req.valid("json").agentId));
  })
  // A submit is a contact from the agent, whatever the session answers.
  .post("/submit", vValidator("json", SubmitRequest, invalidRequest), async (c) => {
    const { pr, ...submission } = c.req.valid("json");
    await (await hubStub(c.env)).touch(submission.agentId);
    const result = await (await prSessionStub(c.env, pr)).submit(submission);
    return "error" in result ? errorResponse(c, result.error, result.detail) : c.json(result);
  });
