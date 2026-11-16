import { vValidator } from "@hono/valibot-validator";
import { PrRef } from "@prq/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import { errorResponse, invalidRequest } from "./http.ts";
import { prSessionStub } from "./names.ts";

// A job in a pull request's path. Owner and repository take any case and address the canonical session; the number is
// written without leading zeros.
const JobPath = v.object({
  owner: PrRef.entries.owner,
  repo: PrRef.entries.repo,
  number: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/), v.transform(Number), PrRef.entries.number),
  jobId: v.string(),
});

// /api/*: what the UI calls besides the Agents routes.
export const apiRoutes = new Hono<{ Bindings: Env }>()
  // The host's retry of a claimed or failed job (docs/design.md, Owner and jobs).
  .post("/pr/:owner/:repo/:number/jobs/:jobId/retry", vValidator("param", JobPath, invalidRequest), async (c) => {
    const { jobId, ...pr } = c.req.valid("param");
    const result = await (await prSessionStub(c.env, pr)).retryJob(jobId);
    return "error" in result ? errorResponse(c, result.error, result.detail) : c.json(result);
  });
