// Work for the CLI, made against the Worker directly (not through the stand-in Access): a pull request's webhook,
// which gives a local session an analysis job, a question asked in the UI, which gives it an answer job, the host's
// retry of a job, a skill stored as a confirm stores one, and what the UI reads (the stored conversation, the present
// agents). What goes over HTTP and WebSocket is origin.ts's, with the token Access adds, as the deployed checks make
// the same calls with the service token; what goes over the Worker's RPC (a session's settle and view, a job's
// revision in storage, the Hub's skill store) is the harness's alone.

import { createHmac, randomUUID } from "node:crypto";

import {
  type AgentRow,
  Prompt,
  type PromptKind,
  type PrRef,
  PrSessionView,
  RetryResponse,
  sessionName,
  Skill,
} from "@prq/protocol";
import * as v from "valibot";

import { agentRows, jsonOf, type Origin, postRetry, readMessages, send, sendQuestion } from "./origin.ts";
import { sha1Blob } from "./skill-github.ts";
import { HOST_ID, WEBHOOK_SECRET, type Worker } from "./worker.ts";

// The local Worker as an origin: its URL now (a reset changes it), with the token Access adds.
function workerOrigin(worker: Worker): Origin {
  return { url: worker.url(), headers: async () => ({ "Cf-Access-Jwt-Assertion": await worker.token() }) };
}

// A head SHA named by a label: the label's bytes in hex, padded to 40 digits.
export function sha(label: string): string {
  return Buffer.from(label).toString("hex").padEnd(40, "0").slice(0, 40);
}

let clock = Date.UTC(2026, 10, 1);

type DeliveryOptions = {
  action: "opened" | "synchronize";
  head: string;
  base?: string;
  // pull_request.updated_at, whole seconds (ISO 8601).
  at: string;
  // The head a synchronize moved from.
  before?: string;
  // The GitHub App installation the delivery names; none when left out.
  installation?: number;
  // The pull request's title and URL ("A change" and its GitHub URL when left out).
  title?: string;
  url?: string;
};

// A pull_request delivery as GitHub signs and sends it, of a pull request the host authored, accepted by the Worker.
export async function deliver(worker: Worker, pr: PrRef, options: DeliveryOptions): Promise<void> {
  const { action, head, base = sha("base"), at, before, installation } = options;
  const fullName = `${pr.owner}/${pr.repo}`;
  const { title = "A change", url = `https://github.com/${fullName}/pull/${pr.number}` } = options;
  const body = JSON.stringify({
    action,
    number: pr.number,
    ...(before === undefined ? {} : { before, after: head }),
    pull_request: {
      number: pr.number,
      updated_at: at,
      title,
      state: "open",
      merged: false,
      html_url: url,
      user: { id: HOST_ID, login: "host" },
      head: { sha: head, ref: "topic" },
      base: { sha: base, ref: "main" },
    },
    repository: { name: pr.repo, full_name: fullName, owner: { login: pr.owner } },
    sender: { id: HOST_ID, login: "host" },
    ...(installation === undefined ? {} : { installation: { id: installation } }),
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
}

// An opened delivery a second after the last one; then the session takes it in, as the wake its inbox armed would.
// With a local agent present, a new head is an analysis job for it.
export async function push(
  worker: Worker,
  pr: PrRef,
  head: string,
  base = sha("base"),
  details: Pick<DeliveryOptions, "title" | "url"> = {},
): Promise<void> {
  clock += 1000;
  const at = new Date(clock).toISOString().replace(/\.\d{3}Z$/, "Z");
  await deliver(worker, pr, { action: "opened", head, base, at, ...details });
  const session = await worker.durableObject("PrSession", sessionName(pr));
  await session["settle"]?.();
}

// How long a test waits for the session to answer a chat request, from the handshake to its acknowledgement.
const CHAT_MS = 30_000;

// A question as the host asks it in the UI: a chat request over the session's WebSocket, with the token Access adds
// (ws takes headers; a browser carries Access's cookie instead). The session makes it an answer job,
// which is then taken in as push's delivery is.
export async function ask(worker: Worker, pr: PrRef, id: string, text: string): Promise<void> {
  await sendQuestion(workerOrigin(worker), pr, { id, text }, { timeoutMs: CHAT_MS });
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

// The conversation as the UI loads it (get-messages), as the Worker sent it.
export function getMessages(worker: Worker, pr: PrRef): Promise<unknown> {
  return readMessages(workerOrigin(worker), pr);
}

// The session's view, as its Durable Object gives it.
export async function sessionView(worker: Worker, pr: PrRef): Promise<PrSessionView> {
  const session = await worker.durableObject("PrSession", sessionName(pr));
  return v.parse(PrSessionView, await session["view"]?.());
}

// The conversation the session stores, as the UI loads it (get-messages): each message's ID, role and text.
export async function storedMessages(worker: Worker, pr: PrRef): Promise<{ id: string; role: string; text: string }[]> {
  return v.parse(StoredMessages, await getMessages(worker, pr)).map(({ id, role, parts }) => ({
    id,
    role,
    text: parts.map((part) => part.text ?? "").join(""),
  }));
}

// The host's retry of a job, from the job's revision as the session stores it.
export async function retry(worker: Worker, pr: PrRef, jobId: string): Promise<void> {
  const [row] = await worker.sql("PrSession", sessionName(pr), "SELECT rev FROM prq_jobs WHERE job_id = ?", jobId);
  const rev = v.parse(v.object({ rev: v.number() }), row).rev;
  const answer = v.parse(RetryResponse, jsonOf(await postRetry(workerOrigin(worker), pr, jobId, rev)));
  if (answer.status !== "retried") {
    throw new Error(`the retry answered ${answer.status}`);
  }
}

// A prompt as the host saves it in the UI.
export async function savePrompt(worker: Worker, kind: PromptKind, text: string): Promise<void> {
  const answer = await send(workerOrigin(worker), `/api/prompts/${kind}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (answer.status !== 200) {
    throw new Error(`the prompt save answered ${answer.status}`);
  }
  v.parse(Prompt, jsonOf(answer));
}

// The present agents, as the UI reads them.
export function agents(worker: Worker): Promise<AgentRow[]> {
  return agentRows(workerOrigin(worker));
}

// A skill's files: a path in the skill, its text and its git mode (100644 unless given).
export type SkillFiles = Record<string, { text: string; mode?: "100644" | "100755" }>;

// A skill stored through the Hub's own call, as a confirm stores one after reading GitHub (no GitHub here): registered,
// or, with expectedRev, updated from that revision. Each file carries its git blob SHA-1.
export async function storeSkill(
  worker: Worker,
  name: string,
  files: SkillFiles,
  { commit = "1".repeat(40), expectedRev }: { commit?: string; expectedRev?: number } = {},
): Promise<Skill> {
  const version = {
    name,
    description: `The ${name} skill.`,
    license: null,
    allowedTools: null,
    source: { owner: "octo", repo: "skills", path: `skills/${name}` },
    ref: { name: "main", kind: "branch" },
    sha: commit,
    files: Object.entries(files).map(([path, { text, mode = "100644" }]) => {
      const content = new Uint8Array(Buffer.from(text));
      return { path, mode, size: content.byteLength, blob: sha1Blob(content), content };
    }),
  };
  const hub = await worker.durableObject("Hub", "hub");
  const stored =
    expectedRev === undefined ? hub["registerSkill"]?.(version) : hub["updateSkill"]?.(version, expectedRev);
  return v.parse(Skill, await stored);
}
