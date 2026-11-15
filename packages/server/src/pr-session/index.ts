// PrSession: one AIChatAgent per PR. It owns the conversation, the owner (cloud | local, fixed at creation) and the
// job state, and serializes claim / submit / retry.
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { ClaimResponse, Job, JobTarget, SubmitRequest, SubmitResponse, ErrorResponse } from "@prq/protocol";
import { getAgentByName } from "agents";
import { convertToModelMessages, streamText, type UIMessage } from "ai";

import { HUB_NAME } from "../hub.ts";
import { createModel } from "../model.ts";

export type Owner = "local" | "cloud";
type JobState = "pending" | "claimed" | "running" | "done" | "superseded";
type JobRow = {
  seq: number;
  job_id: string;
  kind: "answer" | "analysis";
  target: string;
  question: string | null;
  state: JobState;
  agent_id: string | null;
  claim_id: string | null;
  claimed_at: number | null;
  done_claim_id: string | null;
  result_message_id: string | null;
};
export type SubmitResult = { ok: true; body: SubmitResponse } | { ok: false; status: number; body: ErrorResponse };
export type IngestResult = { status: "duplicate" | "accepted"; jobId?: string };

export function textOf(message: UIMessage | undefined): string {
  return (message?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
}

export class PrSession extends AIChatAgent<Env> {
  /** Submits being finalized, keyed by jobId, so a concurrent resend waits for the first instead of racing it. */
  #finalizing = new Map<string, { claimId: string; done: Promise<SubmitResult> }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql`CREATE TABLE IF NOT EXISTS prq_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS prq_jobs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      question TEXT,
      state TEXT NOT NULL,
      agent_id TEXT,
      claim_id TEXT,
      claimed_at INTEGER,
      done_claim_id TEXT,
      result_message_id TEXT,
      UNIQUE(kind, target))`;
    this.sql`CREATE TABLE IF NOT EXISTS prq_deliveries (delivery_id TEXT PRIMARY KEY)`;
  }

  // --- owner -------------------------------------------------------------------------------------------------------

  /** The owner, decided from the Hub's pool on first use and fixed afterwards. */
  async owner(): Promise<Owner> {
    const stored = this.#meta("owner");
    if (stored) return stored as Owner;
    const hub = await getAgentByName(this.env.Hub, HUB_NAME);
    const owner: Owner = (await hub.isLocalPresent()) ? "local" : "cloud";
    // Another request may have decided while we awaited the Hub: the first decision wins.
    this.sql`INSERT OR IGNORE INTO prq_meta (key, value) VALUES ('owner', ${owner})`;
    return this.#meta("owner") as Owner;
  }

  #meta(key: string): string | undefined {
    return this.sql<{ value: string }>`SELECT value FROM prq_meta WHERE key = ${key}`[0]?.value;
  }

  // --- chat input -----------------------------------------------------------------------------------------------------

  override async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    if ((await this.owner()) === "local") {
      // No model turn: every user question without a job gets one (a queued submit may already have persisted a later
      // question, so the last message is not necessarily this turn's), then the Hub is told.
      this.#createAnswerJobs();
      await this.#notifyHub();
      return undefined;
    }
    const last = this.messages.findLast((m) => m.role === "user");
    const result = streamText({
      model: createModel(`echo: ${textOf(last)}`, Number(this.env.MOCK_CHUNK_DELAY_MS)),
      messages: await convertToModelMessages(this.messages),
      ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
    return result.toUIMessageStreamResponse();
  }

  #createAnswerJobs(): void {
    for (const m of this.messages) {
      if (m.role !== "user" || (m.metadata as { kind?: string } | undefined)?.kind === "analysis") continue;
      this.sql`INSERT OR IGNORE INTO prq_jobs (job_id, kind, target, question, state)
        VALUES (${crypto.randomUUID()}, 'answer', ${m.id}, ${textOf(m)}, 'pending')`;
    }
  }

  async #notifyHub(): Promise<void> {
    const hub = await getAgentByName(this.env.Hub, HUB_NAME);
    await hub.notify(this.name);
  }

  // --- webhook input --------------------------------------------------------------------------------------------------

  /** A pull_request event for a new head. Duplicate deliveries are dropped; unstarted analyses coalesce to the latest. */
  async ingestHead(deliveryId: string, headSha: string): Promise<IngestResult> {
    const inserted = this.sql<{ delivery_id: string }>`
      INSERT OR IGNORE INTO prq_deliveries (delivery_id) VALUES (${deliveryId}) RETURNING delivery_id`;
    if (inserted.length === 0) return { status: "duplicate" };
    const owner = await this.owner();
    const existing = this.#jobByTarget("analysis", headSha);
    if (existing) return { status: "accepted", jobId: existing.job_id };
    this.sql`UPDATE prq_jobs SET state = 'superseded' WHERE kind = 'analysis' AND state = 'pending'`;
    const jobId = crypto.randomUUID();
    this.sql`INSERT INTO prq_jobs (job_id, kind, target, state) VALUES (${jobId}, 'analysis', ${headSha}, 'pending')`;
    this.sql`INSERT OR REPLACE INTO prq_meta (key, value) VALUES ('head', ${headSha})`;
    if (owner === "local") await this.#notifyHub();
    else await this.schedule(0, "drainAnalysis");
    return { status: "accepted", jobId };
  }

  /**
   * Cloud owner: runs pending analyses one at a time. Before each, it waits until the chat is stable, so questions
   * already queued in the chat run first, and it adds the analysis with the functional saveMessages so the turn
   * starts from the transcript as it is then, not from a stale this.messages.
   */
  async drainAnalysis(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        await this.waitUntilStable({ timeout: 60_000 });
        const job = this.sql<JobRow>`SELECT * FROM prq_jobs
          WHERE kind = 'analysis' AND state = 'pending' ORDER BY seq LIMIT 1`[0];
        if (!job) return;
        this.sql`UPDATE prq_jobs SET state = 'running' WHERE job_id = ${job.job_id}`;
        const request: UIMessage = {
          id: `analysis-request-${job.job_id}`,
          role: "user",
          metadata: { kind: "analysis", headSha: job.target, jobId: job.job_id },
          parts: [{ type: "text", text: `analyze ${job.target}` }],
        };
        await this.saveMessages((current) => [...current, request]);
        this.sql`UPDATE prq_jobs SET state = 'done' WHERE job_id = ${job.job_id}`;
      }
    } finally {
      this.#draining = false;
    }
  }
  #draining = false;

  // --- local jobs -----------------------------------------------------------------------------------------------------

  #jobByTarget(kind: string, target: string): JobRow | undefined {
    return this.sql<JobRow>`SELECT * FROM prq_jobs WHERE kind = ${kind} AND target = ${target}`[0];
  }

  #job(jobId: string): JobRow | undefined {
    return this.sql<JobRow>`SELECT * FROM prq_jobs WHERE job_id = ${jobId}`[0];
  }

  #toJob(row: JobRow): Job {
    const target: JobTarget =
      row.kind === "answer" ? { kind: "answer", messageId: row.target } : { kind: "analysis", headSha: row.target };
    return { jobId: row.job_id, session: this.name, target, ...(row.question !== null ? { question: row.question } : {}) };
  }

  /** What the Hub needs for wait: whether this agent has a job here, and whether any open job remains. */
  async peek(agentId: string): Promise<{ resume: boolean; fresh: boolean; open: boolean }> {
    if ((await this.owner()) !== "local") return { resume: false, fresh: false, open: false };
    const rows = this.sql<{ state: JobState; agent_id: string | null }>`
      SELECT state, agent_id FROM prq_jobs WHERE state IN ('pending', 'claimed')`;
    return {
      resume: rows.some((r) => r.state === "claimed" && r.agent_id === agentId),
      fresh: rows.some((r) => r.state === "pending"),
      open: rows.length > 0,
    };
  }

  /**
   * resume: this agent's oldest unfinished claimed job, with a new claimId (the old one stops working).
   * fresh: the oldest pending job, answers before analyses.
   * A job claimed by another agent ID is never returned.
   */
  async claim(agentId: string, mode: "resume" | "fresh"): Promise<ClaimResponse> {
    if ((await this.owner()) !== "local") return { job: null };
    const row =
      mode === "resume"
        ? this.sql<JobRow>`SELECT * FROM prq_jobs WHERE state = 'claimed' AND agent_id = ${agentId} ORDER BY seq LIMIT 1`[0]
        : this.sql<JobRow>`SELECT * FROM prq_jobs WHERE state = 'pending'
            ORDER BY CASE kind WHEN 'answer' THEN 0 ELSE 1 END, seq LIMIT 1`[0];
    if (!row) return { job: null };
    const claimId = crypto.randomUUID();
    this.sql`UPDATE prq_jobs SET state = 'claimed', agent_id = ${agentId}, claim_id = ${claimId}, claimed_at = ${Date.now()}
      WHERE job_id = ${row.job_id}`;
    return { job: this.#toJob(row), claimId, resumed: mode === "resume" };
  }

  /** The UI's "retry": a claimed job goes back to pending and its claimId stops working. */
  async retryJob(jobId: string): Promise<boolean> {
    const row = this.#job(jobId);
    if (!row || row.state !== "claimed") return false;
    this.sql`UPDATE prq_jobs SET state = 'pending', agent_id = NULL, claim_id = NULL, claimed_at = NULL
      WHERE job_id = ${jobId}`;
    await this.#notifyHub();
    return true;
  }

  async submit(req: SubmitRequest): Promise<SubmitResult> {
    const inflight = this.#finalizing.get(req.jobId);
    if (inflight) {
      const first = await inflight.done;
      if (inflight.claimId === req.claimId && first.ok) {
        return { ok: true, body: { status: "duplicate", messageId: first.body.messageId } };
      }
      return first.ok ? stale("the job was finalized by another claim") : first;
    }
    const row = this.#job(req.jobId);
    if (!row) return { ok: false, status: 404, body: { error: "unknown_job" } };
    if (row.state === "done") {
      // A resend of the submit that finalized the job returns the stored result and adds nothing.
      if (row.done_claim_id === req.claimId && row.result_message_id) {
        return { ok: true, body: { status: "duplicate", messageId: row.result_message_id } };
      }
      return stale("the job is already done");
    }
    if (row.state !== "claimed" || row.claim_id !== req.claimId || row.agent_id !== req.agentId) {
      return stale("claimId is not the current claim");
    }
    if (row.kind !== req.target.kind) return mismatch("kind");
    const wanted = req.target.kind === "answer" ? req.target.messageId : req.target.headSha;
    if (row.target !== wanted) return mismatch("target");
    const done = this.#finalize(row, req);
    this.#finalizing.set(req.jobId, { claimId: req.claimId, done });
    try {
      return await done;
    } finally {
      this.#finalizing.delete(req.jobId);
    }
  }

  async #finalize(row: JobRow, req: SubmitRequest): Promise<SubmitResult> {
    await this.waitUntilStable({ timeout: 10_000 });
    if (row.kind === "answer" && !this.messages.some((m) => m.id === row.target)) {
      return mismatch("the question message is gone");
    }
    const messageId = `answer-${row.job_id}`;
    if (!this.messages.some((m) => m.id === messageId)) {
      const answer: UIMessage = {
        id: messageId,
        role: "assistant",
        metadata: { jobId: row.job_id, kind: row.kind, target: row.target, agentId: req.agentId },
        parts: [{ type: "text", text: req.text }],
      };
      // Append one message to the latest transcript; no turn runs, and the clients receive it as a broadcast.
      await this.persistMessages([...this.messages, answer]);
    }
    this.sql`UPDATE prq_jobs SET state = 'done', done_claim_id = ${req.claimId}, result_message_id = ${messageId}
      WHERE job_id = ${row.job_id}`;
    return { ok: true, body: { status: "accepted", messageId } };
  }

  /** For tests and the future UI: the job list. */
  async jobs(): Promise<JobRow[]> {
    return this.sql<JobRow>`SELECT * FROM prq_jobs ORDER BY seq`;
  }

  async transcript(): Promise<UIMessage[]> {
    return this.messages;
  }
}

function stale(detail: string): SubmitResult {
  return { ok: false, status: 409, body: { error: "stale_claim", detail } };
}
function mismatch(detail: string): SubmitResult {
  return { ok: false, status: 409, body: { error: "target_mismatch", detail } };
}
