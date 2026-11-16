// GitHub's webhook deliveries as the Worker receives them: a pull_request payload, signed here with WebCrypto (not with
// the library the Worker verifies with) under the configured secret, and sent through the Worker entry.

import type { PrRef } from "@prq/protocol";
import { env, exports } from "cloudflare:workers";

// The host's GitHub user ID (vitest.config.ts), and someone else's.
export const HOST_ID = Number(env.HOST_GITHUB_ID);
export const OTHER_ID = HOST_ID + 1;

// A head SHA named by a label: the label's bytes in hex, padded to 40 digits.
export function sha(label: string): string {
  const hex = [...new TextEncoder().encode(label)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.padEnd(40, "0");
}

export const BASE = sha("base");

type EventOptions = {
  action?: string;
  head?: string;
  title?: string;
  state?: "open" | "closed";
  merged?: boolean;
  author?: number;
  sender?: number;
};

// A pull_request event for the pull request, as GitHub sends it (the fields prq reads, and the sender).
export function pullRequestEvent(pr: PrRef, options: EventOptions = {}) {
  const { action = "synchronize", head = sha("head"), title = "A change", state = "open", merged = false } = options;
  const fullName = `${pr.owner}/${pr.repo}`;
  return {
    action,
    number: pr.number,
    pull_request: {
      number: pr.number,
      title,
      state,
      merged,
      html_url: `https://github.com/${fullName}/pull/${pr.number}`,
      user: { id: options.author ?? HOST_ID, login: "host" },
      head: { sha: head, ref: "topic" },
      base: { sha: BASE, ref: "main" },
    },
    repository: { name: pr.repo, full_name: fullName, owner: { login: pr.owner } },
    sender: { id: options.sender ?? HOST_ID, login: "sender" },
  };
}

// GitHub's signature of a body: `sha256=` and the HMAC-SHA256 under the secret, in hex.
export async function signature(body: string, secret: string = env.WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

type Delivery = { body: string; event?: string; signature?: string | null };

// A delivery's request: the body as it is, the event header (pull_request unless given) and the signature header (the
// body's own unless given; null leaves it out).
export async function deliveryRequest({ body, event = "pull_request", signature: signed }: Delivery): Promise<Request> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-GitHub-Event": event,
    "X-GitHub-Delivery": crypto.randomUUID(),
  });
  const header = signed === undefined ? await signature(body) : signed;
  if (header !== null) {
    headers.set("X-Hub-Signature-256", header);
  }
  return new Request("https://prq.example/webhook", { method: "POST", headers, body });
}

export async function deliver(delivery: Delivery): Promise<Response> {
  return exports.default.fetch(await deliveryRequest(delivery));
}

// A signed pull_request delivery of the event, through the Worker; it must be taken in.
export async function send(pr: PrRef, options: EventOptions = {}): Promise<void> {
  const res = await deliver({ body: JSON.stringify(pullRequestEvent(pr, options)) });
  if (res.status !== 200) {
    throw new Error(`the delivery answered ${res.status}`);
  }
}

// A push of the head, by the host.
export function push(pr: PrRef, label: string): Promise<void> {
  return send(pr, { action: "synchronize", head: sha(label) });
}
