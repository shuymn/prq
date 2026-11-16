import { AIChatAgent } from "@cloudflare/ai-chat";
import { MessageType } from "@cloudflare/ai-chat/types";
import {
  type ClaimResponse,
  type ErrorResponse,
  type HistoryChangedMessage,
  type Job,
  type JobTarget,
  type MessageMetadata,
  type Owner,
  parseSessionName,
  type PrRef,
  type PrSessionView,
  type RetryResponse,
  type SubmitResponse,
} from "@prq/protocol";
import type { Connection } from "agents";
import type { UIMessage } from "ai";
import * as v from "valibot";

import { refuseSubAgent, sendServerVersion } from "../agents.ts";
import { errorName, log } from "../log.ts";
import { hubStub } from "../names.ts";
import { migrate, PR_SESSION_SCHEMA } from "../schema.ts";
import { SerialQueue, WaitTimeout, withTimeout } from "../wait.ts";
import { CLOUD_NOT_CONFIGURED, type CloudAgent } from "./cloud.ts";
import { addedMessages, isChatList, questionsOnly, refusedChatResponse, refusedFrame } from "./history.ts";
import {
  allJobs,
  createAnswerJobs,
  decideOwner,
  deleteOutbox,
  endFinalizing,
  failPending,
  finalizingJobs,
  freshClaim,
  hasAnswerJob,
  jobById,
  jobTarget,
  type JobRow,
  type JobState,
  jobView,
  outboxRow,
  type Peek,
  peekJobs,
  readOwner,
  reserve,
  resultMessageId,
  resumeClaim,
  retry,
  startNext,
  writeNotify,
} from "./jobs.ts";

// Seconds until the wake armed before a write that creates work runs settle.
const WAKE_S = 5;
// The wait before redelivering a failed outbox row, doubling up to the maximum while deliveries keep failing.
const RETRY_FIRST_S = 5;
const RETRY_MAX_S = 60;
// How long a call to the Hub may take.
const HUB_CALL_MS = 10_000;
// How long a submit waits for the conversation to settle before entering the history queue.
const STABLE_WAIT_MS = 30_000;

// A local agent's answer to its claimed job (/cli/submit).
export type Submission = { agentId: string; jobId: string; claimId: string; target: JobTarget; text: string };

// What one step that can make jobs waiting did beyond its own change: cloud jobs failed or handed over.
type CloudOutcome = { failed: JobRow[]; started: { row: JobRow; agent: CloudAgent } | null };
const NO_CLOUD_OUTCOME: CloudOutcome = { failed: [], started: null };

// A question from the UI: a user message the server did not add (server messages carry metadata).
function isQuestion(message: { role: string; metadata?: unknown }): boolean {
  return message.role === "user" && message.metadata === undefined;
}

// A stored message as the session store returns it: its parts are not typed further.
type StoredMessage = { parts: readonly unknown[] };

const TextPart = v.object({ type: v.literal("text"), text: v.string() });

function textOf(message: StoredMessage): string {
  return message.parts.map((part) => (v.is(TextPart, part) ? part.text : "")).join("");
}

// One pull request's conversation (named by sessionName), its owner and its jobs. It is the only place job state
// changes. Its stored history is append-only.
export class PrSession extends AIChatAgent<Env, PrSessionView> {
  readonly #sql: SqlStorage;
  readonly #writes = new SerialQueue("a history write");
  // Arming a delivery retry: a check for a later wake, then a schedule, one failed delivery at a time.
  readonly #retries = new SerialQueue("a delivery retry");
  #retryDelayS = RETRY_FIRST_S;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    migrate(ctx.storage, PR_SESSION_SCHEMA);
    // AIChatAgent installs its frame handler in its constructor. This wrapper is where a client's input enters: it
    // refuses the frames that write history other than through a chat request (the SDK client waits for no answer to
    // them), refuses a chat request not in the expected shape with a failed response, takes the messages a client may
    // not add out of a chat request, and passes the rest through.
    // Whether a message is stored is read from this.messages, synchronously, so frames keep their order; a stored
    // non-question outside it (a history over hydrationByteBudget) is only left out of the request, as it is stored.
    const handle = this.onMessage.bind(this);
    this.onMessage = (connection, message) => {
      const refused = refusedFrame(message);
      if (refused !== null) {
        log("prq.chat.refused", { pr: this.name, type: refused }, "warn");
        return;
      }
      let cached: ReadonlySet<string> | undefined;
      const request = questionsOnly(message, (id) => {
        cached ??= new Set(this.messages.map((stored) => stored.id));
        return cached.has(id);
      });
      const type = MessageType.CF_AGENT_USE_CHAT_REQUEST;
      if ("refusedId" in request) {
        log("prq.chat.refused", { pr: this.name, type, malformed: true }, "warn");
        if (request.refusedId !== null) {
          connection.send(refusedChatResponse(request.refusedId));
        }
        return;
      }
      if (request.removed > 0) {
        log("prq.chat.refused", { pr: this.name, type, messages: request.removed }, "warn");
      }
      return handle(connection, request.message);
    };
  }

  // Runs after the SDK has loaded this.messages, before the session handles any event.
  override async onStart(): Promise<void> {
    this.#publishView();
    await this.settle();
  }

  override onConnect(connection: Connection): void {
    sendServerVersion(connection);
  }

  // Every chat list a connection receives comes from #sendHistory, after a save. The SDK's own lists are not sent: the
  // client's list it relays to the other connections before saving, and its cached list after a save.
  override broadcast(message: string | ArrayBuffer | ArrayBufferView, without?: string[]): void {
    if (!isChatList(message)) {
      super.broadcast(message, without);
    }
  }

  override async onBeforeSubAgent(): Promise<Response> {
    return refuseSubAgent();
  }

  // The view is the server's: a client's state update is refused (the SDK answers it with cf_agent_state_error).
  override validateStateChange(_next: PrSessionView, source: Connection | "server"): void {
    if (source !== "server") {
      log("prq.state.refused", { pr: this.name }, "warn");
      throw new Error("the session view is set by the server only");
    }
  }

  // A chat request has stored its questions: each gets a job. No model turn runs and nothing is streamed; the SDK
  // then sends its "no response" frame, which ends the request in the client.
  override async onChatMessage(): Promise<Response | undefined> {
    await this.#attempt("create_jobs", () => this.createJobs());
    return undefined;
  }

  // The history writes of a chat request and of the server come here (the SDK's streaming paths write around it, and
  // stay unused while onChatMessage returns undefined). A chat request passes the client's whole list (asking for
  // stored messages it lacks to be deleted); only messages with new IDs are added, after the stored ones, and the
  // stored history then goes to every connection, the sender included.
  override persistMessages(messages: UIMessage[]): Promise<void> {
    return this.#writes.run(() => this.insertMessages(messages));
  }

  // Inside the write queue: decides what is new against the history as it is now, not as it was when the write was
  // requested. New questions arm the wake first, so a question stored just before a stop still gets its job.
  protected async insertMessages(messages: UIMessage[]): Promise<void> {
    const cached = new Set(this.messages.map((message) => message.id));
    // this.messages holds the most recent history only (hydrationByteBudget); an ID outside it is looked up in storage.
    const session = this.sessions.session();
    const added = await addedMessages(
      messages,
      async (id) => cached.has(id) || (await session.getMessage(id)) !== null,
    );
    if (added.some(isQuestion)) {
      await this.#armWake();
    }
    await super.persistMessages([...this.messages, ...added]);
    await this.#sendHistory();
  }

  // Sends every connection the stored history, as the list a client replaces its own with. It is read within the
  // budget the SDK keeps history in memory under. A longer history goes as a HistoryChangedMessage instead, since its
  // most recent part would replace the whole list a client has; the client reloads it through get-messages.
  async #sendHistory(): Promise<void> {
    const history = await this.sessions.session().getRecentHistory(this.hydrationByteBudget);
    if (history.truncated) {
      log("prq.chat.history_over_budget", { pr: this.name, bytes: history.totalContentBytes });
      const changed: HistoryChangedMessage = { type: "prq:history-changed" };
      super.broadcast(JSON.stringify(changed));
      return;
    }
    super.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_MESSAGES, messages: history.messages }));
  }

  // --- The view ---

  // The session as the UI shows it (also its Agent state).
  view(): PrSessionView {
    return { pr: this.#pr(), owner: readOwner(this.#sql), jobs: allJobs(this.#sql).map(jobView) };
  }

  #publishView(): void {
    this.setState(this.view());
  }

  #pr(): PrRef {
    const pr = parseSessionName(this.name);
    if (pr === null) {
      throw new Error("a PrSession is addressed by its canonical session name only");
    }
    return pr;
  }

  // --- Owner and intake ---

  // The pool's answer to whether a local agent is present (spied on in tests).
  protected async readPool(): Promise<boolean> {
    const hub = await hubStub(this.env);
    return withTimeout(hub.isLocalPresent(), HUB_CALL_MS, "the Hub's presence check");
  }

  // The stored owner (spied on in tests).
  protected async ownerOf(): Promise<Owner | null> {
    return readOwner(this.#sql);
  }

  // The owner, decided from the pool at the session's first job; the first stored decision wins.
  async #decideOwner(): Promise<Owner> {
    const stored = readOwner(this.#sql);
    if (stored !== null) {
      return stored;
    }
    const decided: Owner = (await this.readPool()) ? "local" : "cloud";
    if (decideOwner(this.#sql, decided)) {
      log("prq.owner.decided", { pr: this.name, owner: decided });
    }
    return this.#storedOwner();
  }

  // The owner of a session that has jobs: jobs are created only once it is set.
  #storedOwner(): Owner {
    const owner = readOwner(this.#sql);
    if (owner === null) {
      throw new Error("a session with jobs has an owner");
    }
    return owner;
  }

  // The stored questions that have no job, oldest first. They are read from storage, not this.messages, which holds the
  // most recent history only: a question stored before a stop can be older than that. Each createJobs gives every
  // question it finds a job in one step, and questions are only appended, so the questions with jobs come before those
  // without: the walk reads one message at a time from the newest and ends at the first question that has a job.
  async #questionsWithoutJobs(): Promise<string[]> {
    const found: string[] = [];
    for await (const message of this.sessions.session().history({ newestFirst: true })) {
      if (isQuestion(message)) {
        if (hasAnswerJob(this.#sql, message.id)) {
          break;
        }
        found.push(message.id);
      }
    }
    return found.toReversed();
  }

  // A job for every stored question that has none, in one step with what makes it reach an agent: the outbox row of a
  // local session, the cloud seam of a cloud one. Called by intake and by settle (spied on in tests).
  protected async createJobs(): Promise<void> {
    const questions = await this.#questionsWithoutJobs();
    if (questions.length === 0) {
      return;
    }
    const owner = await this.#decideOwner();
    const now = Date.now();
    const { created, cloud } = this.ctx.storage.transactionSync(() => {
      // A question another step gave a job meanwhile keeps that one.
      const rows = createAnswerJobs(this.#sql, questions, now);
      return { created: rows, cloud: rows.length > 0 ? this.#newWork(owner, now) : NO_CLOUD_OUTCOME };
    });
    for (const row of created) {
      log("prq.job.created", { ...this.#jobFields(row), to: this.#stateAfter(row, cloud) });
    }
    this.#afterNewWork(cloud);
    if (owner === "local" && created.length > 0) {
      await this.#deliverOutbox();
    }
  }

  // Inside the step that made jobs pending: a local session writes its notify row; a cloud session runs the cloud seam.
  #newWork(owner: Owner, now: number): CloudOutcome {
    if (owner === "local") {
      writeNotify(this.#sql);
      return NO_CLOUD_OUTCOME;
    }
    return this.#cloudSeam(now);
  }

  // The cloud seam: with no agent, every waiting job fails; with one, the next waiting job becomes running unless one
  // is running already.
  #cloudSeam(now: number): CloudOutcome {
    const agent = this.cloudAgent();
    if (agent === undefined) {
      return { failed: failPending(this.#sql, CLOUD_NOT_CONFIGURED, now), started: null };
    }
    const row = startNext(this.#sql, now);
    return { failed: [], started: row === undefined ? null : { row, agent } };
  }

  // The cloud agent of a cloud session; none until #5 configures one.
  protected cloudAgent(): CloudAgent | undefined {
    return undefined;
  }

  // After the step's transaction: logs, the hand-over to the cloud agent (still in the same synchronous step), and the
  // view.
  #afterNewWork(cloud: CloudOutcome): void {
    for (const row of cloud.failed) {
      log("prq.job.failed", { ...this.#jobFields(row), from: "pending", to: "failed", reason: row.failure }, "warn");
    }
    if (cloud.started !== null) {
      const { row, agent } = cloud.started;
      log("prq.job.started", { ...this.#jobFields(row), from: "pending", to: "running" });
      agent.start(
        this.#job(
          row,
          this.messages.find((message) => message.id === row.target),
        ),
      );
    }
    this.#publishView();
  }

  #stateAfter(row: JobRow, cloud: CloudOutcome): JobState {
    if (cloud.failed.some((failed) => failed.job_id === row.job_id)) {
      return "failed";
    }
    return cloud.started?.row.job_id === row.job_id ? "running" : row.state;
  }

  #jobFields(row: JobRow): Record<string, unknown> {
    return { pr: this.name, jobId: row.job_id, kind: row.kind };
  }

  // --- Local jobs ---

  // What the Hub needs for wait: the agent's own claimed job, a pending job, any open job. A cloud session has none.
  peek(agentId: string): Peek {
    if (readOwner(this.#sql) !== "local") {
      return { resume: false, fresh: false, open: false };
    }
    return peekJobs(this.#sql, agentId);
  }

  // resume: the agent's own claimed job, under a new claimId (the old one stops working). fresh: the next pending job.
  // A job claimed by one agent ID is never returned to another.
  async claim(agentId: string, mode: "resume" | "fresh"): Promise<ClaimResponse> {
    if ((await this.ownerOf()) !== "local") {
      return { job: null };
    }
    const claimId = crypto.randomUUID();
    const now = Date.now();
    const row =
      mode === "resume" ? resumeClaim(this.#sql, agentId, claimId, now) : freshClaim(this.#sql, agentId, claimId, now);
    if (row === undefined) {
      return { job: null };
    }
    const from = mode === "resume" ? "claimed" : "pending";
    log(mode === "resume" ? "prq.job.resumed" : "prq.job.claimed", {
      ...this.#jobFields(row),
      from,
      to: "claimed",
      agentId,
    });
    this.#publishView();
    const question = row.kind === "answer" ? await this.#message(row.target) : undefined;
    return { job: this.#job(row, question), claimId, resumed: mode === "resume" };
  }

  #job(row: JobRow, question: StoredMessage | undefined): Job {
    const job: Job = { jobId: row.job_id, pr: this.#pr(), target: jobTarget(row), workspaceSha: row.workspace_sha };
    return question === undefined ? job : { ...job, question: textOf(question) };
  }

  async #message(id: string): Promise<StoredMessage | undefined> {
    return (
      this.messages.find((message) => message.id === id) ?? (await this.sessions.session().getMessage(id)) ?? undefined
    );
  }

  // A local agent's answer. The conversation is let settle first, outside the history queue: the SDK counts a client
  // save as pending until it returns from persistMessages, so waiting inside the queue could wait on a save queued
  // behind this submit. Inside the queue the job is read again and checked, reserved (claimed → finalizing, the point
  // at which the submit wins), the answer is appended, and the job is done, so no other write sits between them.
  // A submit that fails on the way (the conversation does not settle, the queue or the append fails) answers internal
  // and leaves the job claimed, so the agent can submit again.
  async submit(submission: Submission): Promise<SubmitResponse | ErrorResponse> {
    try {
      if (!(await this.waitUntilStable({ timeout: STABLE_WAIT_MS }))) {
        throw new WaitTimeout(`the conversation did not settle within ${STABLE_WAIT_MS} ms`);
      }
      return await this.#writes.run(() => this.#finalize(submission));
    } catch (error) {
      log("prq.job.submit_failed", { pr: this.name, jobId: submission.jobId, error: errorName(error) }, "error");
      return { error: "internal" };
    }
  }

  async #finalize(submission: Submission): Promise<SubmitResponse | ErrorResponse> {
    const { agentId, jobId, claimId, target, text } = submission;
    const row = jobById(this.#sql, jobId);
    if (row === undefined) {
      return this.#reject(submission, null, { error: "unknown_job" });
    }
    const wanted = target.kind === "answer" ? target.messageId : target.headSha;
    if (target.kind !== row.kind || wanted !== row.target) {
      return this.#reject(submission, row, { error: "target_mismatch" });
    }
    // A done job answers the submit that finished it, by the claim and the agent that held it, with its result again.
    if (row.state === "done") {
      if (row.done_claim_id === claimId && row.agent_id === agentId && row.result_message_id !== null) {
        log("prq.job.duplicate", { ...this.#jobFields(row), agentId });
        return { status: "duplicate", messageId: row.result_message_id };
      }
      return this.#reject(submission, row, { error: "stale_claim", detail: "the job is done under another claim" });
    }
    // The reservation is the claim check: only the job's current claim, held by this agent, moves it.
    const reserved = reserve(this.#sql, jobId, claimId, agentId, Date.now());
    if (reserved === undefined) {
      return this.#reject(submission, row, {
        error: "stale_claim",
        detail: "the claim is not the job's current claim",
      });
    }
    this.#publishView();
    const metadata: MessageMetadata = {
      kind: "answer",
      jobId,
      questionId: reserved.target,
      sha: reserved.workspace_sha,
      by: { kind: "local", agentId },
    };
    const messageId = resultMessageId(reserved);
    try {
      await this.insertMessages([{ id: messageId, role: "assistant", metadata, parts: [{ type: "text", text }] }]);
    } finally {
      await this.#endFinalizing(reserved, "prq.job.submitted");
    }
    return { status: "accepted", messageId };
  }

  // A refused submit, logged with the job's kind when the job is known.
  #reject(submission: Submission, row: JobRow | null, error: ErrorResponse): ErrorResponse {
    const job = row === null ? { pr: this.name, jobId: submission.jobId } : this.#jobFields(row);
    log("prq.job.rejected", { ...job, agentId: submission.agentId, reason: error.error }, "warn");
    return error;
  }

  // Inside the history queue: a finalizing job becomes done when its message is stored, else claimed again.
  async #endFinalizing(row: JobRow, event: "prq.job.submitted" | "prq.job.swept"): Promise<void> {
    const stored = (await this.#message(resultMessageId(row))) !== undefined;
    const ended = endFinalizing(this.#sql, row, stored, Date.now());
    if (ended !== undefined) {
      log(event, { ...this.#jobFields(ended), from: "finalizing", to: ended.state, agentId: ended.agent_id });
      this.#publishView();
    }
  }

  // The host's retry of a claimed or failed job: back to waiting with the claim cleared, so the earlier claimId is
  // rejected from now on.
  async retryJob(jobId: string): Promise<RetryResponse | ErrorResponse> {
    const before = jobById(this.#sql, jobId);
    if (before === undefined) {
      return { error: "unknown_job" };
    }
    if (before.state !== "claimed" && before.state !== "failed") {
      return { error: "not_retryable", detail: `the job is ${jobView(before).state}` };
    }
    await this.#armWake();
    const owner = this.#storedOwner();
    const now = Date.now();
    const change = this.ctx.storage.transactionSync(() => {
      const from = jobById(this.#sql, jobId)?.state;
      const row = retry(this.#sql, jobId, now);
      return row === undefined ? null : { from, row, cloud: this.#newWork(owner, now) };
    });
    if (change === null) {
      return { error: "not_retryable", detail: "the job changed state" };
    }
    log("prq.job.retried", {
      ...this.#jobFields(change.row),
      from: change.from,
      to: this.#stateAfter(change.row, change.cloud),
    });
    this.#afterNewWork(change.cloud);
    if (owner === "local") {
      await this.#deliverOutbox();
    }
    return { status: "retried" };
  }

  // --- The wake, settle and the outbox ---

  // A new schedule row each time, never deduplicated: an idempotent one-shot would match the row of a settle that is
  // running and vanish when that run ends.
  async #armWake(delayS = WAKE_S): Promise<void> {
    await this.schedule(delayS, "settle", undefined, { idempotent: false });
  }

  // Run by the wake and at every start: finishes what a stop or a failure left. Each step is idempotent, and a failing
  // step does not stop the others.
  async settle(): Promise<void> {
    await this.#attempt("create_jobs", () => this.createJobs());
    await this.#attempt("sweep", () => this.#writes.run(() => this.#sweepFinalizing()));
    await this.#attempt("cloud", () => this.#settleCloud());
    await this.#deliverOutbox();
  }

  async #attempt(step: string, run: () => Promise<void> | void): Promise<void> {
    try {
      await run();
    } catch (error) {
      log("prq.settle.failed", { pr: this.name, step, error: errorName(error) }, "error");
      await this.#armRetry();
    }
  }

  // Inside the history queue no submit is between its reservation and done, so a finalizing job here was left by a
  // submit that stopped or failed.
  async #sweepFinalizing(): Promise<void> {
    for (const row of finalizingJobs(this.#sql)) {
      await this.#endFinalizing(row, "prq.job.swept");
    }
  }

  #settleCloud(): void {
    if (readOwner(this.#sql) === "cloud") {
      this.#afterNewWork(this.ctx.storage.transactionSync(() => this.#cloudSeam(Date.now())));
    }
  }

  // Delivers the outbox row to the Hub (spied on in tests). The row is deleted only if it is still the generation that
  // was read, so a row written again during the call stays for the next delivery.
  protected async deliver(): Promise<void> {
    const row = outboxRow(this.#sql);
    if (row === undefined) {
      return;
    }
    const hub = await hubStub(this.env);
    await withTimeout(hub.notify(this.name), HUB_CALL_MS, "the Hub's notify");
    if (deleteOutbox(this.#sql, row)) {
      log("prq.outbox.delivered", { pr: this.name, kind: row.kind, gen: row.gen });
    }
  }

  async #deliverOutbox(): Promise<void> {
    try {
      await this.deliver();
      this.#retryDelayS = RETRY_FIRST_S;
    } catch (error) {
      log("prq.outbox.failed", { pr: this.name, error: errorName(error) }, "error");
      await this.#armRetry();
    }
  }

  // A redelivery wake, unless a settle is already scheduled for a later second (the running one's time has passed, so
  // it never counts). The check and the schedule run under one lock: both await, and two failures checking together
  // would each see no later wake and each arm one.
  async #armRetry(): Promise<void> {
    try {
      await this.#retries.run(async () => {
        const later = await this.listSchedules({ timeRange: { start: new Date(Date.now() + 1000) } });
        if (later.some((schedule) => schedule.callback === "settle")) {
          return;
        }
        await this.#armWake(this.#retryDelayS);
        this.#retryDelayS = Math.min(this.#retryDelayS * 2, RETRY_MAX_S);
      });
    } catch (error) {
      log("prq.outbox.retry_failed", { pr: this.name, error: errorName(error) }, "error");
    }
  }
}
