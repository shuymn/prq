import { verify } from "@octokit/webhooks-methods";
import { canonicalPrRef, PrDetails, PrRef, Sha, sessionName } from "@prq/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import { readWebhookConfig } from "./config.ts";
import { type CallBound, errorResponse } from "./http.ts";
import { log } from "./log.ts";
import { prSessionStub } from "./names.ts";
import type { Delivery } from "./pr-session/jobs.ts";

// How long the route waits for the session to store a delivery, its start included. GitHub counts a delivery failed
// when it gets no answer within 10 s and does not send it again by itself; this leaves half of that for GitHub's
// connection, the Worker's start and the signature check. Storing is one insert and one schedule write, which a
// started session does in milliseconds and a cold one well within this.
export const WEBHOOK_CALL_MS = 5_000;

// GitHub's signature header: `sha256=` and the HMAC-SHA256 of the raw body under the webhook secret, in lowercase hex.
// The form is checked here: the library's build for Workers drops a `sha256=` prefix if there is one and reads hex
// pairs out of whatever remains, so it alone would take a bare digest.
const SIGNATURE = /^sha256=[0-9a-f]{64}$/;

// What prq reads of a pull_request event (GitHub's payload, not prq's contract). updated_at is GitHub's time of the
// state the event carries; before is the head a synchronize event moved from. The details are held to PrDetails'
// lengths, which GitHub's stay within.
const PullRequestEvent = v.object({
  action: v.string(),
  before: v.optional(Sha),
  pull_request: v.object({
    updated_at: v.pipe(v.string(), v.isoTimestamp(), v.transform(Date.parse)),
    number: PrRef.entries.number,
    title: PrDetails.entries.title,
    state: v.picklist(["open", "closed"]),
    merged: v.nullish(v.boolean()),
    html_url: PrDetails.entries.url,
    user: v.object({ id: v.number() }),
    head: v.object({ sha: Sha }),
    base: v.object({ sha: Sha }),
  }),
  repository: v.object({
    name: PrRef.entries.repo,
    full_name: PrDetails.entries.fullName,
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

// GitHub's ID of the event a delivery carries (a GUID); a redelivery from GitHub's UI carries the same one.
const DeliveryId = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

// /webhook (outside Access): the GitHub App's deliveries (docs/design.md, Intake; Authentication boundary). A delivery is
// taken in only when it is signed with the webhook secret and is a pull_request event of a pull request the host
// authored (the author, not the sender, who may be anyone who changed it); anything else reaches no PrSession. The
// route answers once the session has stored the delivery in its inbox, and settle takes it in later. The session
// call is bounded under GitHub's limit; when the bound passes the route answers 503, GitHub records the delivery as
// failed, and the call keeps running. One that lands stores the delivery once, and a redelivery from GitHub's UI is
// then a duplicate; the current head follows GitHub's order (moveHead), not when either is taken in, within that
// order's same-second limits.
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
    const deliveryId = v.safeParse(DeliveryId, c.req.header("X-GitHub-Delivery"));
    if (!deliveryId.success) {
      log("prq.webhook.rejected", { reason: "delivery_id" }, "warn");
      return errorResponse(c, "bad_request", "missing X-GitHub-Delivery");
    }
    const pr = canonicalPrRef({ owner: repository.owner.login, repo: repository.name, number: pull.number });
    const delivery: Delivery = {
      deliveryId: deliveryId.output,
      action,
      push: PUSHES.has(action),
      at: pull.updated_at,
      before: parsed.output.before ?? null,
      details: {
        fullName: repository.full_name,
        title: pull.title,
        state: pull.state === "open" ? "open" : pull.merged === true ? "merged" : "closed",
        url: pull.html_url,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
      },
    };
    log("prq.webhook.received", { pr: sessionName(pr), action, headSha: delivery.details.headSha });
    const call = (async () => (await prSessionStub(c.env, pr)).receive(delivery))();
    const status = await bound(call, WEBHOOK_CALL_MS, "the session's inbox");
    return c.json({ status });
  });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
