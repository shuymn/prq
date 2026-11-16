import { verify } from "@octokit/webhooks-methods";
import { canonicalPrRef, type PrDetails, PrRef, Sha, sessionName } from "@prq/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import { readWebhookConfig } from "./config.ts";
import { type CallBound, errorResponse, ROUTE_CALL_MS } from "./http.ts";
import { log } from "./log.ts";
import { prSessionStub } from "./names.ts";

// GitHub's signature header: `sha256=` and the HMAC-SHA256 of the raw body under the webhook secret, in lowercase hex.
// The form is checked here: the library's build for Workers drops a `sha256=` prefix if there is one and reads hex
// pairs out of whatever remains, so it alone would take a bare digest.
const SIGNATURE = /^sha256=[0-9a-f]{64}$/;

// What prq reads of a pull_request event (GitHub's payload, not prq's contract).
const PullRequestEvent = v.object({
  action: v.string(),
  pull_request: v.object({
    number: PrRef.entries.number,
    title: v.string(),
    state: v.picklist(["open", "closed"]),
    merged: v.nullish(v.boolean()),
    html_url: v.string(),
    user: v.object({ id: v.number() }),
    head: v.object({ sha: Sha }),
    base: v.object({ sha: Sha }),
  }),
  repository: v.object({
    name: PrRef.entries.repo,
    full_name: v.string(),
    owner: v.object({ login: PrRef.entries.owner }),
  }),
});

// A push: the head may have moved. An edit or a close changes the details only.
const PUSHES = new Set(["opened", "reopened", "synchronize"]);
const UPDATES = new Set(["edited", "closed"]);

// Whether GitHub signed the body: the header's form, then the HMAC, compared in constant time by the library.
async function signedByGitHub(secret: string, body: string, signature: string | undefined): Promise<boolean> {
  // The library throws on an empty body; a delivery always has one.
  return signature !== undefined && SIGNATURE.test(signature) && body !== "" && verify(secret, body, signature);
}

// /webhook (outside Access): the GitHub App's deliveries (docs/design.md, Intake; Authentication boundary). A delivery is
// taken in only when it is signed with the webhook secret and is a pull_request event of a pull request the host
// authored (the author, not the sender, who may be anyone who changed it); anything else reaches no PrSession. The
// session call is bounded like every route's. One that lands after the route answered 503 is a delivery arriving
// then: it makes no second job for its head, and by arrival order its head is current until the next push.
export function webhookRoutes(bound: CallBound) {
  return new Hono<{ Bindings: Env }>().post("/", async (c) => {
    const config = readWebhookConfig(c.env);
    if (!config.ok) {
      log("prq.config.invalid", { issues: config.issues }, "error");
      return errorResponse(c, "internal", "the server is not configured");
    }
    const { WEBHOOK_SECRET: secret, HOST_GITHUB_ID: host } = config.config;
    const body = await c.req.text();
    if (!(await signedByGitHub(secret, body, c.req.header("X-Hub-Signature-256")))) {
      log("prq.webhook.rejected", { reason: "signature" }, "warn");
      return errorResponse(c, "unauthorized", "invalid signature");
    }
    const githubEvent = c.req.header("X-GitHub-Event") ?? null;
    if (githubEvent !== "pull_request") {
      log("prq.webhook.ignored", { githubEvent, reason: "event" });
      return c.json({ status: "ignored" });
    }
    const parsed = v.safeParse(PullRequestEvent, parseJson(body));
    if (!parsed.success) {
      log("prq.webhook.rejected", { reason: "payload" }, "warn");
      return errorResponse(c, "bad_request", "not a pull_request event payload");
    }
    const { action, pull_request: pull, repository } = parsed.output;
    if (String(pull.user.id) !== host) {
      log("prq.webhook.ignored", { action, reason: "author" });
      return c.json({ status: "ignored" });
    }
    if (!PUSHES.has(action) && !UPDATES.has(action)) {
      log("prq.webhook.ignored", { action, reason: "action" });
      return c.json({ status: "ignored" });
    }
    const pr = canonicalPrRef({ owner: repository.owner.login, repo: repository.name, number: pull.number });
    const details: PrDetails = {
      fullName: repository.full_name,
      title: pull.title,
      state: pull.state === "open" ? "open" : pull.merged === true ? "merged" : "closed",
      url: pull.html_url,
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
    };
    log("prq.webhook.received", { pr: sessionName(pr), action, headSha: details.headSha });
    const call = (async (): Promise<void> => {
      const session = await prSessionStub(c.env, pr);
      await (PUSHES.has(action) ? session.ingestHead(details) : session.updatePr(details));
    })();
    await bound(call, ROUTE_CALL_MS, "the session's intake");
    return c.json({ status: "received" });
  });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
