// /api/*: what the UI needs besides the chat socket. Only what the spike exercises.
import { getAgentByName } from "agents";
import { Hono } from "hono";

export const apiRoutes = new Hono<{ Bindings: Env }>()
  .get("/session/:name", async (c) => {
    const s = await getAgentByName(c.env.PrSession, c.req.param("name"));
    return c.json({ owner: await s.owner(), jobs: await s.jobs(), messages: await s.transcript() });
  })
  .post("/session/:name/jobs/:jobId/retry", async (c) => {
    const s = await getAgentByName(c.env.PrSession, c.req.param("name"));
    return c.json({ ok: await s.retryJob(c.req.param("jobId")) });
  });
