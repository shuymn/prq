// Work for the CLI, made against the Worker directly (not through the stand-in Access): a pull request's webhook,
// which gives a local session an analysis job, the host's retry of a job, and the present agents.

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
export async function push(worker: Worker, pr: PrRef, head: string, action = "opened"): Promise<void> {
  clock += 1000;
  const fullName = `${pr.owner}/${pr.repo}`;
  const body = JSON.stringify({
    action,
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
      base: { sha: sha("base"), ref: "main" },
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
