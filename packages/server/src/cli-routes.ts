// /cli/*: prq's HTTP API. wait is a long-poll; claim and submit go through the Hub / PrSession that own the state.
import { ClaimRequest, SubmitRequest, WaitRequest } from "@prq/protocol";
import { getAgentByName } from "agents";
import { Hono } from "hono";
import * as v from "valibot";

import { HUB_NAME } from "./hub.ts";

export const cliRoutes = new Hono<{ Bindings: Env }>()
  .post("/wait", async (c) => {
    const req = v.safeParse(WaitRequest, await c.req.json());
    if (!req.success) return c.json({ error: "bad_request" }, 400);
    const hub = await getAgentByName(c.env.Hub, HUB_NAME);
    return c.json(await hub.wait(req.output.agentId, req.output.timeoutMs ?? 20_000));
  })
  .post("/claim", async (c) => {
    const req = v.safeParse(ClaimRequest, await c.req.json());
    if (!req.success) return c.json({ error: "bad_request" }, 400);
    const hub = await getAgentByName(c.env.Hub, HUB_NAME);
    return c.json(await hub.claim(req.output.agentId));
  })
  .post("/submit", async (c) => {
    const req = v.safeParse(SubmitRequest, await c.req.json());
    if (!req.success) return c.json({ error: "bad_request" }, 400);
    const hub = await getAgentByName(c.env.Hub, HUB_NAME);
    await hub.touch(req.output.agentId);
    const session = await getAgentByName(c.env.PrSession, req.output.session);
    const res = await session.submit(req.output);
    return res.ok ? c.json(res.body) : c.json(res.body, res.status as 404 | 409);
  });
