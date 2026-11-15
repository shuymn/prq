// GitHub webhook: signature check (@octokit/webhooks-methods), only the owner's own PRs, then the PrSession intake.
import { verify } from "@octokit/webhooks-methods";
import { getAgentByName } from "agents";
import { Hono } from "hono";

/**
 * The PrSession name: owner~repo~number. routeAgentRequest takes the path segment as is (no percent-decoding), so
 * "owner/repo#n" cannot be addressed from /agents/pr-session/:name; "~" is URL-safe and never in GitHub names.
 */
export function sessionName(fullName: string, number: number): string {
  return `${fullName.replace("/", "~")}~${number}`;
}

export const webhook = new Hono<{ Bindings: Env }>().post("/", async (c) => {
  const body = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? "";
  if (!(await verify(c.env.WEBHOOK_SECRET, body, signature))) return c.json({ error: "bad signature" }, 401);
  const delivery = c.req.header("x-github-delivery");
  if (!delivery) return c.json({ error: "missing delivery" }, 400);
  if (c.req.header("x-github-event") !== "pull_request") return c.json({ status: "ignored" });
  const event = JSON.parse(body) as {
    action: string;
    pull_request: { number: number; user: { id: number }; head: { sha: string } };
    repository: { full_name: string };
  };
  // The PR author, not the sender (the sender is whoever caused the event).
  if (String(event.pull_request.user.id) !== c.env.OWNER_GITHUB_ID) return c.json({ status: "ignored" });
  if (!["opened", "synchronize", "reopened"].includes(event.action)) return c.json({ status: "ignored" });
  const stub = await getAgentByName(
    c.env.PrSession,
    sessionName(event.repository.full_name, event.pull_request.number),
  );
  return c.json(await stub.ingestHead(delivery, event.pull_request.head.sha));
});
