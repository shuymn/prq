// GitHub's webhook deliveries as the Worker receives them: a pull_request payload, signed here with WebCrypto (not with
// the library the Worker verifies with) under the configured secret, and sent through the Worker entry.

import type { PrRef } from "@prq/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";

import { prSessionStub } from "../names.ts";

// The host's GitHub user ID (vitest.config.ts), and someone else's.
export const HOST_ID = Number(env.HOST_GITHUB_ID);
export const OTHER_ID = HOST_ID + 1;

// A head SHA named by a label: the label's bytes in hex, padded to 40 digits.
export function sha(label: string): string {
  const hex = [...new TextEncoder().encode(label)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.padEnd(40, "0");
}

export const BASE = sha("base");

// The GitHub App installation deliveries come through unless a test names another (or none).
export const INSTALLATION_ID = 77;

// GitHub's clock as the events tell it: each event made without a time is a second after the one made before it.
let clock = Date.UTC(2026, 10, 1);

export function nextAt(): number {
  clock += 1000;
  return clock;
}

type EventOptions = {
  action?: string;
  head?: string;
  // The time of the pull request's state the event carries (pull_request.updated_at), whole seconds.
  at?: number;
  // The head a synchronize event moved from.
  before?: string;
  // The base's SHA (BASE unless given).
  base?: string;
  title?: string;
  url?: string;
  fullName?: string;
  state?: "open" | "closed";
  merged?: boolean;
  author?: number;
  sender?: number;
  // The App installation the delivery names; null leaves it out.
  installation?: number | null;
};

// A pull_request event for the pull request, as GitHub sends it (the fields prq reads, and the sender).
export function pullRequestEvent(pr: PrRef, options: EventOptions = {}) {
  const { action = "synchronize", head = sha("head"), title = "A change", state = "open", merged = false } = options;
  const fullName = options.fullName ?? `${pr.owner}/${pr.repo}`;
  const updatedAt = new Date(options.at ?? nextAt()).toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    action,
    number: pr.number,
    ...(options.before === undefined ? {} : { before: options.before, after: head }),
    pull_request: {
      number: pr.number,
      updated_at: updatedAt,
      title,
      state,
      merged,
      html_url: options.url ?? `https://github.com/${fullName}/pull/${pr.number}`,
      user: { id: options.author ?? HOST_ID, login: "host" },
      head: { sha: head, ref: "topic" },
      base: { sha: options.base ?? BASE, ref: "main" },
    },
    repository: { name: pr.repo, full_name: fullName, owner: { login: pr.owner } },
    sender: { id: options.sender ?? HOST_ID, login: "sender" },
    ...(options.installation === null ? {} : { installation: { id: options.installation ?? INSTALLATION_ID } }),
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

type Delivery = { body: string; event?: string; signature?: string | null; deliveryId?: string | null };

// A delivery's request: the body as it is, the event header (pull_request unless given), the signature header (the
// body's own unless given; null leaves it out) and the delivery ID header (a new one unless given; null leaves it out).
export async function deliveryRequest({
  body,
  event = "pull_request",
  signature: signed,
  deliveryId = crypto.randomUUID(),
}: Delivery): Promise<Request> {
  const headers = new Headers({ "Content-Type": "application/json", "X-GitHub-Event": event });
  if (deliveryId !== null) {
    headers.set("X-GitHub-Delivery", deliveryId);
  }
  const header = signed === undefined ? await signature(body) : signed;
  if (header !== null) {
    headers.set("X-Hub-Signature-256", header);
  }
  return new Request("https://prq.example/webhook", { method: "POST", headers, body });
}

export async function deliver(delivery: Delivery): Promise<Response> {
  return exports.default.fetch(await deliveryRequest(delivery));
}

// Runs the session's settle, as the wake its inbox armed would: it takes in the stored deliveries.
export async function takeIn(pr: PrRef): Promise<void> {
  await (await prSessionStub(env, pr)).settle();
}

// A signed pull_request delivery of the event, through the Worker, stored and then taken in.
export async function send(pr: PrRef, options: EventOptions = {}): Promise<void> {
  const res = await deliver({ body: JSON.stringify(pullRequestEvent(pr, options)) });
  if (res.status !== 200) {
    throw new Error(`the delivery answered ${res.status}`);
  }
  await takeIn(pr);
}

// A push of the head, by the host, a second after the event before it.
export function push(pr: PrRef, label: string, options: Omit<EventOptions, "head"> = {}): Promise<void> {
  return send(pr, { action: "synchronize", ...options, head: sha(label) });
}

export type InboxRow = { delivery_id: string; action: string; head_sha: string; processed: number };

// The session's inbox, in the order stored.
export async function inbox(pr: PrRef): Promise<InboxRow[]> {
  return runInDurableObject(await prSessionStub(env, pr), (_, state) =>
    state.storage.sql
      .exec<InboxRow>("SELECT delivery_id, action, head_sha, processed FROM prq_inbox ORDER BY seq")
      .toArray(),
  );
}
