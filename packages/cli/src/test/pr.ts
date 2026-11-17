// Work for the CLI, made against the Worker directly (not through the stand-in Access): a pull request's webhook,
// which gives a local session an analysis job, a question asked in the UI, which gives it an answer job, the host's
// retry of a job, and what the UI reads (the stored conversation, the present agents).

import { createHmac, randomUUID } from "node:crypto";

import { AgentPage, type AgentRow, type PrRef, RetryResponse, sessionName } from "@prq/protocol";
import * as v from "valibot";

import { HOST_ID, WEBHOOK_SECRET, type Worker } from "./worker.ts";

// A head SHA named by a label: the label's bytes in hex, padded to 40 digits.
export function sha(label: string): string {
  return Buffer.from(label).toString("hex").padEnd(40, "0").slice(0, 40);
}

let clock = Date.UTC(2026, 10, 1);

// A pull_request delivery as GitHub signs and sends it, of a pull request the host authored; then the session takes it
// in, as the wake its inbox armed would. With a local agent present, a new head is an analysis job for it.
export async function push(worker: Worker, pr: PrRef, head: string, base = sha("base")): Promise<void> {
  clock += 1000;
  const fullName = `${pr.owner}/${pr.repo}`;
  const body = JSON.stringify({
    action: "opened",
    number: pr.number,
    pull_request: {
      number: pr.number,
      updated_at: new Date(clock).toISOString().replace(/\.\d{3}Z$/, "Z"),
      title: "A change",
      state: "open",
      merged: false,
      html_url: `https://github.com/${fullName}/pull/${pr.number}`,
      user: { id: HOST_ID, login: "host" },
      head: { sha: head, ref: "topic" },
      base: { sha: base, ref: "main" },
    },
    repository: { name: pr.repo, full_name: fullName, owner: { login: pr.owner } },
    sender: { id: HOST_ID, login: "host" },
  });
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
  const res = await fetch(new URL("/webhook", worker.url()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": randomUUID(),
      "X-Hub-Signature-256": signature,
    },
    body,
  });
  if (res.status !== 200) {
    throw new Error(`the webhook answered ${res.status}: ${await res.text()}`);
  }
  const session = await worker.durableObject("PrSession", sessionName(pr));
  await session["settle"]?.();
}

// How long a test waits for the session to answer a chat request.
const CHAT_MS = 30_000;

const ChatFrame = v.object({ type: v.string(), id: v.optional(v.string()), done: v.optional(v.boolean()) });

// A question as the host asks it in the UI: a chat request over the session's WebSocket, with the token Access adds
// (Node's WebSocket takes headers; a browser carries Access's cookie instead). The session makes it an answer job,
// which is then taken in as push's delivery is.
export async function ask(worker: Worker, pr: PrRef, id: string, text: string): Promise<void> {
  const url = new URL(`/agents/pr-session/${sessionName(pr)}`, worker.url());
  url.protocol = "ws:";
  const socket = new WebSocket(url, { headers: { "Cf-Access-Jwt-Assertion": await worker.token() } });
  const request = randomUUID();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => reject(new Error(`no answer to the chat request within ${CHAT_MS} ms`)), CHAT_MS);
  socket.addEventListener("open", () => {
    const messages = [{ id, role: "user", parts: [{ type: "text", text }] }];
    const body = JSON.stringify({ messages, trigger: "submit-message" });
    socket.send(JSON.stringify({ type: "cf_agent_use_chat_request", id: request, init: { method: "POST", body } }));
  });
  socket.addEventListener("message", (event) => {
    const frame = v.safeParse(ChatFrame, typeof event.data === "string" ? parseJson(event.data) : undefined);
    const answer = frame.success ? frame.output : null;
    if (answer?.type === "cf_agent_use_chat_response" && answer.id === request && answer.done === true) {
      resolve();
    }
  });
  socket.addEventListener("error", () => reject(new Error("the chat socket failed")));
  socket.addEventListener("close", (event) => reject(new Error(`the chat socket closed (${event.code})`)));
  try {
    await promise;
  } finally {
    clearTimeout(timer);
    socket.close();
  }
  const session = await worker.durableObject("PrSession", sessionName(pr));
  await session["settle"]?.();
}

const StoredMessages = v.array(
  v.object({
    id: v.string(),
    role: v.string(),
    parts: v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })),
  }),
);

// The conversation the session stores, as the UI loads it (get-messages): each message's ID, role and text.
export async function storedMessages(worker: Worker, pr: PrRef): Promise<{ id: string; role: string; text: string }[]> {
  const res = await fetch(new URL(`/agents/pr-session/${sessionName(pr)}/get-messages`, worker.url()), {
    headers: { "Cf-Access-Jwt-Assertion": await worker.token() },
  });
  if (res.status !== 200) {
    throw new Error(`get-messages answered ${res.status}`);
  }
  return v.parse(StoredMessages, await res.json()).map(({ id, role, parts }) => ({
    id,
    role,
    text: parts.map((part) => part.text ?? "").join(""),
  }));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The host's retry of a job, from the job's revision as the session stores it.
export async function retry(worker: Worker, pr: PrRef, jobId: string): Promise<void> {
  const [row] = await worker.sql("PrSession", sessionName(pr), "SELECT rev FROM prq_jobs WHERE job_id = ?", jobId);
  const rev = v.parse(v.object({ rev: v.number() }), row).rev;
  const res = await fetch(new URL(`/api/pr/${pr.owner}/${pr.repo}/${pr.number}/jobs/${jobId}/retry`, worker.url()), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": await worker.token() },
    body: JSON.stringify({ expectedRev: rev }),
  });
  const answer = v.parse(RetryResponse, await res.json());
  if (answer.status !== "retried") {
    throw new Error(`the retry answered ${answer.status}`);
  }
}

// The present agents, as the UI reads them.
export async function agents(worker: Worker): Promise<AgentRow[]> {
  const res = await fetch(new URL("/api/agents", worker.url()), {
    headers: { "Cf-Access-Jwt-Assertion": await worker.token() },
  });
  return v.parse(AgentPage, await res.json()).rows;
}
