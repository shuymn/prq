import { AIChatAgent, type ChatRecoveryOptions, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { MessageType } from "@cloudflare/ai-chat/types";
import {
  type ClaimResponse,
  type ContextResponse,
  type ErrorResponse,
  type HistoryChangedMessage,
  type Job,
  type JobTarget,
  MessageMetadata,
  type Owner,
  parseSessionName,
  type PrRef,
  type PrSessionView,
  type RetryResponse,
  type SubmitResponse,
} from "@prq/protocol";
import type { Connection } from "agents";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import * as v from "valibot";

import { refuseSubAgent, sendServerVersion } from "../agents.ts";
import { errorName, log } from "../log.ts";
import { hubStub } from "../names.ts";
import { migrate, PR_SESSION_SCHEMA } from "../schema.ts";
import { SerialQueue, WaitTimeout, withTimeout } from "../wait.ts";
import {
  CLOUD_NOT_CONFIGURED,
  type CloudAgent,
  MAX_STARTS,
  TURN_INTERRUPTED,
  type Workspace,
  WORKSPACE_NOT_AVAILABLE,
} from "./cloud.ts";
import { type ContextMessage, type Cursor, cursorText, jsonBytes, messageRoom, parseCursor, take } from "./context.ts";
import { addedMessages, isChatList, questionsOnly, refusedChatResponse, refusedFrame } from "./history.ts";
import {
  addInbox,
  addIntake,
  addStep,
  allJobs,
  createAnswerJobs,
  decideOwner,
  type Delivery,
  deleteOutbox,
  endFinalizing,
  endTurn,
  failPending,
  finalizingJobs,
  freshClaim,
  heldJobs,
  ingestHeadJobs,
  intakeIds,
  isHeld,
  jobById,
  jobTarget,
  type JobRow,
  type JobState,
  type JobUsage,
  jobUsage,
  jobView,
  ledgerEntry,
  markStalls,
  moveHead,
  type OutboxKind,
  outboxRow,
  type Peek,
  peekJobs,
  pendingInbox,
  readDetails,
  readHead,
  readOwner,
  recordAttempt,
  recordEvent,
  removeIntake,
  reserve,
  restartTurn,
  resultMessageId,
  resumeClaim,
  retry,
  runningJobs,
  stallDeadline,
  stallMarked,
  startNext,
  takeInbox,
  type TurnEnd,
  writeDetails,
  writeLedger,
  writeNotify,
} from "./jobs.ts";
import { projection } from "./projection.ts";
import { analysisTask, systemPrompt } from "./prompt.ts";
import {
  type Binding,
  type CloudModel,
  errorReason,
  hasText,
  incompleteMessageId,
  newOutcome,
  reasonText,
  resultParts,
  stepTokens,
  turnFailure,
  usageMetadata,
} from "./turn.ts";

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
export type Submission = {
  agentId: string;
  jobId: string;
  claimId: string;
  run: number;
  target: JobTarget;
  text: string;
};

// A claim's 60-minute check (claimAged): the job and the claim it was armed for.
type ClaimRef = { jobId: string; claimId: string };

// The first whole second at or after a time: the SDK stores a schedule's time in whole seconds, rounding a Date down,
// which would run a check before its deadline.
function wholeSecondFrom(ms: number): Date {
  return new Date(Math.ceil(ms / 1000) * 1000);
}

// What one step that can make jobs waiting did beyond its own change: cloud jobs failed or handed over.
type CloudOutcome = { failed: JobRow[]; started: { row: JobRow; agent: CloudAgent } | null };
const NO_CLOUD_OUTCOME: CloudOutcome = { failed: [], started: null };

const BAD_CURSOR: ErrorResponse = { error: "bad_request", detail: "the cursor names no place in this conversation" };

// A question from the UI: a user message the server did not add (server messages carry metadata).
function isQuestion(message: UIMessage): boolean {
  return message.role === "user" && message.metadata === undefined;
}

// A stored message as the session store returns it: its parts are not typed further.
type StoredMessage = { parts: readonly unknown[] };

const TextPart = v.object({ type: v.literal("text"), text: v.string() });

function textOf(message: StoredMessage): string {
  return message.parts.map((part) => (v.is(TextPart, part) ? part.text : "")).join("");
}

// A stored message as a local agent reads it (null for a role the conversation does not hold).
function contextMessage(
  message: StoredMessage & { id: string; role: string; metadata?: unknown },
): ContextMessage | null {
  const { id, role, metadata } = message;
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const read = { id, role, text: textOf(message) } as const;
  return v.is(MessageMetadata, metadata) ? { ...read, metadata } : read;
}

// A stored message as the AI SDK reads it: the session store keeps the UIMessages the SDK and prq wrote, untyped.
function isUIMessage<M extends { role: string }>(message: M): message is M & UIMessage {
  return message.role === "user" || message.role === "assistant" || message.role === "system";
}

// One pull request's conversation (named by sessionName), its owner and its jobs. It is the only place job state
// changes. Its stored history is append-only.
export class PrSession extends AIChatAgent<Env, PrSessionView> {
  readonly #sql: SqlStorage;
  readonly #writes = new SerialQueue("a history write");
  // Arming a delivery retry: a check for a later wake, then a schedule, one failed delivery at a time.
  readonly #retries = new SerialQueue("a delivery retry");
  #retryDelayS = RETRY_FIRST_S;
  // The cloud turns live in this isolate: a running job whose turn is not among them was left by a restart.
  readonly #liveTurns = new Set<string>();
  // The binding a job's turn made in its exclusive slot, until that turn's onChatMessage takes it.
  #bound: Binding | null = null;

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

  // A chat turn. The turn a job's hand-over started finds its binding and streams the job's model call; any other turn
  // (a chat request's) has stored its questions, and each gets a job: no model is called and nothing is streamed, and
  // the SDK then sends its "no response" frame, which ends the request in the client.
  override async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions): Promise<Response | undefined> {
    const bound = this.#bound;
    if (bound === null) {
      await this.#attempt("create_jobs", () => this.createJobs());
      return undefined;
    }
    this.#bound = null;
    bound.outcome.reached = true;
    try {
      return await this.#turnResponse(bound, options?.abortSignal);
    } catch (error) {
      log("prq.turn.failed", { pr: this.name, jobId: bound.jobId, error: errorName(error) }, "error");
      bound.outcome.failure = `the turn failed before the model was called (${errorName(error)})`;
      return undefined;
    }
  }

  // Durable recovery cannot be turned off (agents 0.33), so each interrupted turn it finds is declined: nothing of it is
  // stored and no turn is retried or continued. settle restarts prq's own jobs (docs/design.md, Owner and jobs).
  override async onChatRecovery(): Promise<ChatRecoveryOptions> {
    return { persist: false, continue: false };
  }

  // The SDK's history writes come here: a chat request's, saveMessages', and the streamed, orphaned or repaired
  // messages of its streaming paths. They may add questions only; every other message the server stores is appended
  // by prq itself (insertMessages with results). A chat request passes the client's whole list (asking for stored
  // messages it lacks to be deleted); only questions with new IDs are added, after the stored ones, and the stored
  // history then goes to every connection, the sender included.
  override persistMessages(messages: UIMessage[]): Promise<void> {
    return this.#writes.run(() => this.insertMessages(messages, "questions"));
  }

  // Inside the write queue: decides what is new against the history as it is now, not as it was when the write was
  // requested. What it may add: questions only (the SDK's writes; anything else new is dropped and logged), or the
  // server's results as given. New questions arm the wake first, then get their intake rows, then are stored: a stored
  // question always has its job or its row, and the wake that turns the row into a job is set before either is
  // written.
  protected async insertMessages(messages: UIMessage[], adds: "questions" | "results"): Promise<void> {
    const cached = new Set(this.messages.map((message) => message.id));
    // this.messages holds the most recent history only (hydrationByteBudget); an ID outside it is looked up in storage.
    const session = this.sessions.session();
    const fresh = await addedMessages(
      messages,
      async (id) => cached.has(id) || (await session.getMessage(id)) !== null,
    );
    const added = adds === "questions" ? fresh.filter(isQuestion) : fresh;
    if (adds === "questions") {
      this.#logDropped(fresh.filter((message) => !isQuestion(message)));
    }
    const questions = added.filter(isQuestion).map((message) => message.id);
    if (questions.length > 0) {
      await this.#armWake();
      addIntake(this.#sql, questions);
    }
    await super.persistMessages([...this.messages, ...added]);
    await this.#sendHistory();
  }

  // The messages the SDK tried to add that were not questions, counted by role.
  #logDropped(dropped: readonly UIMessage[]): void {
    for (const role of new Set(dropped.map((message) => message.role))) {
      const count = dropped.filter((message) => message.role === role).length;
      log("prq.chat.dropped", { pr: this.name, role, messages: count });
    }
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
    const now = Date.now();
    return {
      pr: this.#pr(),
      details: readDetails(this.#sql),
      owner: readOwner(this.#sql),
      jobs: allJobs(this.#sql).map((row) => jobView(row, now)),
    };
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
    const set = this.ctx.storage.transactionSync(() => {
      const first = decideOwner(this.#sql, decided);
      if (first) {
        writeLedger(this.#sql);
      }
      return first;
    });
    if (set) {
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

  // The questions waiting for their job, in the order they were stored: their intake rows. Read inside the write queue,
  // where no question is between its row and its insert, so a row whose question is not stored was left by a write
  // that failed or stopped there and is dropped.
  async #intake(): Promise<string[]> {
    const session = this.sessions.session();
    const stored: string[] = [];
    for (const id of intakeIds(this.#sql)) {
      if ((await session.getMessage(id)) === null) {
        removeIntake(this.#sql, [id]);
        log("prq.intake.dropped", { pr: this.name, messageId: id }, "warn");
      } else {
        stored.push(id);
      }
    }
    return stored;
  }

  // A job for every question waiting for one, in one step with what makes it reach an agent (the outbox row of a local
  // session, the cloud seam of a cloud one) and with the removal of its intake row. Called by intake and by settle
  // (spied on in tests).
  protected async createJobs(): Promise<void> {
    // No row, nothing to wait in the queue for: a row written later has its wake armed before it.
    if (intakeIds(this.#sql).length === 0) {
      return;
    }
    const questions = await this.#writes.run(() => this.#intake());
    if (questions.length === 0) {
      return;
    }
    const owner = await this.#decideOwner();
    const now = Date.now();
    const { created, cloud } = this.ctx.storage.transactionSync(() => {
      // A question another step gave a job meanwhile keeps that one.
      const rows = createAnswerJobs(this.#sql, questions, now);
      removeIntake(this.#sql, questions);
      if (rows.length === 0) {
        return { created: rows, cloud: NO_CLOUD_OUTCOME };
      }
      recordEvent(this.#sql, "question", now);
      writeLedger(this.#sql);
      return { created: rows, cloud: this.#newWork(owner, now) };
    });
    for (const row of created) {
      log("prq.job.created", { ...this.#jobFields(row), to: this.#stateAfter(row, cloud) });
    }
    this.#afterNewWork(cloud);
    if (created.length > 0) {
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

  // The cloud seam: with no agent, every waiting job fails; with one, the next waiting job becomes running under a new
  // turn unless one is running already.
  #cloudSeam(now: number): CloudOutcome {
    const agent = this.cloudAgent();
    if (agent === undefined) {
      return { failed: failPending(this.#sql, CLOUD_NOT_CONFIGURED, now), started: null };
    }
    const row = startNext(this.#sql, crypto.randomUUID(), now);
    return { failed: [], started: row === undefined ? null : { row, agent } };
  }

  // The cloud agent of a cloud session (spied on in tests): the built-in one, once a model is configured.
  protected cloudAgent(): CloudAgent | undefined {
    const model = this.cloudModel();
    if (model === undefined) {
      return undefined;
    }
    // The turn is not awaited: the hand-over can run inside a chat request's turn, and a turn queued behind it would
    // wait for it.
    return { start: (job, turnId) => void this.keepAliveWhile(() => this.#runTurn(job.jobId, turnId, model)) };
  }

  // The model cloud turns run on (spied on in tests); none until a provider is configured.
  protected cloudModel(): CloudModel | undefined {
    return undefined;
  }

  // The workspace a job with a workspace commit reads its code from (spied on in tests); none until the Sandbox exists,
  // so such a job fails rather than producing a result without the code it is about.
  protected workspaceFor(_job: Job): Workspace | null {
    return null;
  }

  // A job that has just become running reaches its agent: its turn is live in this isolate from here.
  #handOver(row: JobRow, agent: CloudAgent): void {
    if (row.turn_id === null) {
      throw new Error("a running job has its turn");
    }
    this.#liveTurns.add(row.turn_id);
    agent.start(this.#job(row), row.turn_id);
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
      this.#handOver(row, agent);
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
    const fields = { pr: this.name, jobId: row.job_id, kind: row.kind };
    return row.kind === "analysis" ? { ...fields, headSha: row.target } : fields;
  }

  // --- Webhooks ---

  // A verified delivery (/webhook). It is stored in the inbox as this call's first step, before anything awaits, so a
  // delivery the route acknowledges is never lost; the wake that takes it in is armed before the call returns. A
  // delivery whose ID is stored already is a duplicate and is not stored again. Taking it in is settle's.
  async receive(delivery: Delivery): Promise<"received" | "duplicate"> {
    const stored = addInbox(this.#sql, delivery);
    if (stored !== "processed") {
      await this.#armWake();
    }
    return stored === "new" ? "received" : "duplicate";
  }

  // Takes in each stored delivery, in the order stored; the order of heads comes from GitHub (moveHead), not from
  // this one, except within a second. A delivery whose step fails stays stored for the next settle, which settle's
  // retry wake runs.
  async #drainInbox(): Promise<void> {
    for (const delivery of pendingInbox(this.#sql)) {
      await (delivery.push ? this.#takePush(delivery) : this.#takeUpdate(delivery));
    }
  }

  // A push (opened, reopened, synchronize), taken in once: its details, and its head when GitHub's order makes it the
  // current head (docs/design.md, Intake). Every other head's waiting analysis is then superseded; the head's own job
  // is created if it has none, revived if it was superseded, and otherwise left as it is, so a push of the current head
  // changes no job. A new or revived analysis reaches an agent in the same step, as a question's job does.
  async #takePush(delivery: Delivery): Promise<void> {
    await this.#armWake();
    const owner = await this.#decideOwner();
    const now = Date.now();
    const change = this.ctx.storage.transactionSync(() => {
      if (!takeInbox(this.#sql, delivery.deliveryId)) {
        return null;
      }
      const before = readHead(this.#sql);
      const moved = moveHead(this.#sql, delivery);
      // A push is an event when it changes the head: the first push, or a newer head. A push of the current head is
      // not one.
      if (moved && (!before.pushed || before.headSha !== delivery.details.headSha)) {
        recordEvent(this.#sql, "push", now);
      }
      writeDetails(this.#sql, delivery);
      writeLedger(this.#sql);
      const jobs = moved
        ? ingestHeadJobs(this.#sql, delivery.details.headSha, now)
        : { folded: [], created: undefined, revived: undefined };
      const waiting = jobs.created ?? jobs.revived;
      return { moved, ...jobs, waiting, cloud: waiting === undefined ? NO_CLOUD_OUTCOME : this.#newWork(owner, now) };
    });
    if (change === null) {
      return;
    }
    this.#logTaken(delivery, change.moved);
    for (const row of change.folded) {
      log("prq.job.superseded", { ...this.#jobFields(row), from: "pending", to: "superseded" });
    }
    if (change.created !== undefined) {
      log("prq.job.created", {
        ...this.#jobFields(change.created),
        to: this.#stateAfter(change.created, change.cloud),
      });
    }
    if (change.revived !== undefined) {
      const to = this.#stateAfter(change.revived, change.cloud);
      log("prq.job.revived", { ...this.#jobFields(change.revived), from: "superseded", to });
    }
    this.#afterNewWork(change.cloud);
    await this.#deliverOutbox();
  }

  // An edit or a close, taken in once: the pull request's details, when no later webhook has given them. No job. Its
  // ledger entry goes with the delivery at the end of the settle that takes it in.
  #takeUpdate(delivery: Delivery): void {
    const taken = this.ctx.storage.transactionSync(() => {
      const fresh = takeInbox(this.#sql, delivery.deliveryId);
      if (fresh) {
        writeDetails(this.#sql, delivery);
        writeLedger(this.#sql);
      }
      return fresh;
    });
    if (taken) {
      this.#logTaken(delivery, false);
      this.#publishView();
    }
  }

  #logTaken(delivery: Delivery, headMoved: boolean): void {
    const { deliveryId, action, details } = delivery;
    log("prq.inbox.taken", { pr: this.name, deliveryId, action, headSha: details.headSha, headMoved });
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
  // A job claimed by one agent ID is never returned to another. attempt: the Hub's number for this claim call; an
  // attempt older than one the agent has claimed under here claims nothing. A claim that will likely take a job arms
  // the wake first, so the claim's ledger entry and its claimAged check are finished by settle if this call stops after
  // the claim.
  async claim(agentId: string, mode: "resume" | "fresh", attempt: number): Promise<ClaimResponse> {
    if ((await this.ownerOf()) !== "local") {
      return { job: null };
    }
    const peek = peekJobs(this.#sql, agentId);
    if (mode === "resume" ? peek.resume : peek.fresh) {
      await this.#armWake();
    }
    const claimId = crypto.randomUUID();
    const now = Date.now();
    const row = this.ctx.storage.transactionSync(() => {
      const claimed =
        mode === "resume"
          ? resumeClaim(this.#sql, agentId, claimId, attempt, now)
          : freshClaim(this.#sql, agentId, claimId, attempt, now);
      if (claimed !== undefined) {
        recordAttempt(this.#sql, agentId, attempt);
        writeLedger(this.#sql);
      }
      return claimed;
    });
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
    await this.#attempt("claim_aged", () => this.#armClaimAged(row));
    await this.#deliverOutbox();
    return { job: this.#job(row), claimId, resumed: mode === "resume" };
  }

  // Schedules a held job's claimAged check at the first whole second at or after its deadline. A row for the same claim
  // is not added twice.
  async #armClaimAged(row: JobRow): Promise<void> {
    if (row.claim_id === null) {
      return;
    }
    const payload: ClaimRef = { jobId: row.job_id, claimId: row.claim_id };
    await this.schedule(wholeSecondFrom(stallDeadline(row)), "claimAged", payload, { idempotent: true });
  }

  // A claim's 60-minute check (docs/design.md, PR ledger). With the claim still held and its deadline passed, the
  // ledger entry and the view now show the job possibly stalled. Run before the deadline, it schedules itself again
  // (a new row: an idempotent one would match this running one). For a claim that has ended, or whose stall settle has
  // published already, nothing changes.
  async claimAged(payload: ClaimRef): Promise<void> {
    const row = jobById(this.#sql, payload.jobId);
    if (row === undefined || row.claim_id !== payload.claimId || !isHeld(row)) {
      return;
    }
    const deadline = stallDeadline(row);
    if (Date.now() < deadline) {
      await this.schedule(wholeSecondFrom(deadline), "claimAged", payload, { idempotent: false });
      return;
    }
    if (stallMarked(this.#sql, payload.claimId)) {
      return;
    }
    await this.#armWake();
    if (this.#publishStalls()) {
      await this.#deliverOutbox();
    }
  }

  // Publishes the stall of every held claim past its deadline that the ledger has not been told of: a new ledger
  // revision, written in the step that marks them, once per claim. claimAged runs it at a claim's deadline, and settle
  // for a claim whose check was lost. Returns whether it marked any.
  #publishStalls(): boolean {
    const marked = this.ctx.storage.transactionSync(() => {
      const rows = markStalls(this.#sql, Date.now());
      if (rows.length > 0) {
        writeLedger(this.#sql);
      }
      return rows;
    });
    for (const row of marked) {
      log("prq.job.stalled", { ...this.#jobFields(row), agentId: row.agent_id });
    }
    if (marked.length > 0) {
      this.#publishView();
    }
    return marked.length > 0;
  }

  // What a local agent works on its claimed job from (/cli/context): the pull request, its details, the job as its claim
  // fixed it, and a page of the conversation from the cursor (the start when there is none), the whole response within
  // CONTEXT_PAGE_BYTES. Only the job's current claim, held by the agent, gets it. The claim is checked before the
  // conversation is read, to size the page around the job, and again after it, in the step that answers, so the answer
  // never carries a claim that had already ended.
  async context(
    agentId: string,
    jobId: string,
    claimId: string,
    cursor?: string,
  ): Promise<ContextResponse | ErrorResponse> {
    const start = cursor === undefined ? { id: null, offset: 0 } : parseCursor(cursor);
    if (start === null) {
      return BAD_CURSOR;
    }
    const before = this.#heldJob(agentId, jobId, claimId);
    if ("error" in before) {
      return before;
    }
    const page = await this.#contextPage(start.id, start.offset, { pr: this.#pr(), job: this.#job(before) });
    if ("error" in page) {
      return page;
    }
    const row = this.#heldJob(agentId, jobId, claimId);
    if ("error" in row) {
      return row;
    }
    return {
      pr: this.#pr(),
      details: readDetails(this.#sql),
      job: this.#job(row),
      messages: page.messages,
      nextCursor: page.next === null ? null : cursorText(page.next),
    };
  }

  // The job, while the claim is its current one and held by the agent. A claim that holds has not changed the job since
  // it was taken: a retry or a resume ends it.
  #heldJob(agentId: string, jobId: string, claimId: string): JobRow | ErrorResponse {
    const row = jobById(this.#sql, jobId);
    if (row === undefined) {
      return { error: "unknown_job" };
    }
    if (!isHeld(row) || row.claim_id !== claimId || row.agent_id !== agentId) {
      return { error: "stale_claim", detail: "the claim is not the job's current one" };
    }
    return row;
  }

  // The messages from a place in the conversation (null for the start) that fit in the room the rest of the response
  // leaves (messageRoom), and where the next page starts; BAD_CURSOR when the place is not in the conversation. The
  // messages' IDs are read without their content, and only the page's messages are read whole, one at a time. A page
  // holds at least part of a message. One that cannot, because the rest of the response or the first character of its
  // first message does not fit, is refused rather than sent over the budget; bounded IDs and details keep that from
  // happening but to rows stored before the bounds.
  async #contextPage(
    id: string | null,
    offset: number,
    around: Pick<ContextResponse, "pr" | "job">,
  ): Promise<{ messages: ContextMessage[]; next: Cursor | null } | ErrorResponse> {
    const session = this.sessions.session();
    const ids = (await session.getHistoryRowStats()).map((stat) => stat.id);
    let index = id === null ? 0 : ids.indexOf(id);
    if (index < 0) {
      return BAD_CURSOR;
    }
    const messages: ContextMessage[] = [];
    let left = messageRoom(around, ids);
    if (left < 0) {
      return this.#pageOverflow(around.job);
    }
    for (let from = offset; index < ids.length; index += 1, from = 0) {
      const stored = await session.getMessage(ids[index] ?? "");
      const message = stored === null ? null : contextMessage(stored);
      if (message === null) {
        continue;
      }
      if (from > 0 && from >= message.text.length) {
        return BAD_CURSOR;
      }
      // A comma before each message but the first, counted for all.
      left -= 1;
      const taken = take(message, from, left, messages.length === 0);
      if (taken === null) {
        return messages.length === 0
          ? this.#pageOverflow(around.job)
          : { messages, next: { id: message.id, offset: from } };
      }
      messages.push(taken);
      const end = (taken.part?.offset ?? 0) + taken.text.length;
      if (end < message.text.length) {
        return { messages, next: { id: message.id, offset: end } };
      }
      left -= jsonBytes(taken);
    }
    return { messages, next: null };
  }

  #pageOverflow(job: Job): ErrorResponse {
    log("prq.context.overflow", { pr: this.name, jobId: job.jobId }, "error");
    return { error: "internal", detail: "the conversation from this place does not fit in a context page" };
  }

  #job(row: JobRow): Job {
    return { jobId: row.job_id, pr: this.#pr(), run: row.run, target: jobTarget(row), workspaceSha: row.workspace_sha };
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
    let response: SubmitResponse | ErrorResponse;
    try {
      if (!(await this.waitUntilStable({ timeout: STABLE_WAIT_MS }))) {
        throw new WaitTimeout(`the conversation did not settle within ${STABLE_WAIT_MS} ms`);
      }
      // The ledger entry of the completed job is written in the queue; the wake delivers it if this call stops first.
      await this.#armWake();
      response = await this.#writes.run(() => this.#finalize(submission));
    } catch (error) {
      log("prq.job.submit_failed", { pr: this.name, jobId: submission.jobId, error: errorName(error) }, "error");
      return { error: "internal" };
    }
    await this.#deliverOutbox();
    return response;
  }

  async #finalize(submission: Submission): Promise<SubmitResponse | ErrorResponse> {
    const { agentId, jobId, claimId, run, target, text } = submission;
    const row = jobById(this.#sql, jobId);
    if (row === undefined) {
      return this.#reject(submission, null, { error: "unknown_job" });
    }
    const wanted = target.kind === "answer" ? target.messageId : target.headSha;
    if (target.kind !== row.kind || wanted !== row.target) {
      return this.#reject(submission, row, { error: "target_mismatch" });
    }
    // A done job answers the submit that finished it, by the claim, run and agent that held it, with its result again.
    if (row.state === "done") {
      const same = row.done_claim_id === claimId && row.run === run && row.agent_id === agentId;
      if (same && row.result_message_id !== null) {
        log("prq.job.duplicate", { ...this.#jobFields(row), agentId });
        return { status: "duplicate", messageId: row.result_message_id };
      }
      return this.#reject(submission, row, { error: "stale_claim", detail: "the job is done under another claim" });
    }
    // The reservation is the claim check: only the job's current claim, held by this agent, under the job's current
    // run, moves it.
    const reserved = reserve(this.#sql, jobId, claimId, agentId, run, Date.now());
    if (reserved === undefined) {
      return this.#reject(submission, row, {
        error: "stale_claim",
        detail: "the claim or the run is not the job's current one",
      });
    }
    this.#publishView();
    const by = { kind: "local", agentId } as const;
    const metadata: MessageMetadata =
      reserved.kind === "answer"
        ? { kind: "answer", jobId, questionId: reserved.target, sha: reserved.workspace_sha, by }
        : { kind: "analysis", jobId, headSha: reserved.target, by };
    const messageId = resultMessageId(reserved);
    try {
      await this.insertMessages(
        [{ id: messageId, role: "assistant", metadata, parts: [{ type: "text", text }] }],
        "results",
      );
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

  // Inside the history queue: a finalizing job becomes done when its message is stored, else claimed again. A done job
  // is the session's latest event (a summary or an answer completed) and changes its ledger entry.
  async #endFinalizing(row: JobRow, event: "prq.job.submitted" | "prq.job.swept"): Promise<void> {
    const stored = (await this.#message(resultMessageId(row))) !== undefined;
    const now = Date.now();
    const ended = this.ctx.storage.transactionSync(() => {
      const next = endFinalizing(this.#sql, row, stored, now);
      if (next?.state === "done") {
        recordEvent(this.#sql, next.kind === "analysis" ? "summary" : "answer", now);
        writeLedger(this.#sql);
      }
      return next;
    });
    if (ended !== undefined) {
      log(event, { ...this.#jobFields(ended), from: "finalizing", to: ended.state, agentId: ended.agent_id });
      this.#publishView();
    }
  }

  // The host's retry of a claimed or failed job: back to waiting with the claim cleared, so the earlier claimId is
  // rejected from now on. The analysis of a head that is no longer current is superseded instead (its claim cleared as
  // well), decided in the retry's statement against the head as it is then. expectedRev: the job's revision in the
  // view the retry was made from. The retry's statement applies it only while the job is still at it, so a retry never
  // undoes a change made after that view (a claim, another retry, a new failure) however late it lands. A refused one
  // changes no job state; any wake it armed only settles.
  async retryJob(jobId: string, expectedRev: number): Promise<RetryResponse | ErrorResponse> {
    const before = jobById(this.#sql, jobId);
    if (before === undefined) {
      return { error: "unknown_job" };
    }
    if (before.state !== "claimed" && before.state !== "failed") {
      return { error: "not_retryable", detail: `the job is ${jobView(before, Date.now()).state}` };
    }
    await this.#armWake();
    const owner = this.#storedOwner();
    const now = Date.now();
    const change = this.ctx.storage.transactionSync(() => {
      const from = jobById(this.#sql, jobId)?.state;
      const row = retry(this.#sql, jobId, expectedRev, now);
      if (row === undefined) {
        return null;
      }
      writeLedger(this.#sql);
      return { from, row, cloud: row.state === "pending" ? this.#newWork(owner, now) : NO_CLOUD_OUTCOME };
    });
    if (change === null) {
      return { error: "stale_job", detail: "the job changed since the view the retry was made from" };
    }
    const waiting = change.row.state === "pending";
    log("prq.job.retried", {
      ...this.#jobFields(change.row),
      from: change.from,
      to: this.#stateAfter(change.row, change.cloud),
    });
    this.#afterNewWork(change.cloud);
    await this.#deliverOutbox();
    return { status: waiting ? "retried" : "superseded" };
  }

  // --- Cloud turns ---

  // A job's turn: an SDK chat turn started with saveMessages, bound to the job inside its exclusive slot (the function
  // runs there, right before the same turn's onChatMessage), so no other turn can take the binding. It stores no request
  // message, as a local analysis stores none. When the SDK's turn has ended, prq commits it in the history queue.
  async #runTurn(jobId: string, turnId: string, model: CloudModel): Promise<void> {
    const binding: Binding = { jobId, turnId, model, outcome: newOutcome() };
    const { outcome } = binding;
    try {
      const result = await this.saveMessages((messages) => {
        this.#bound = binding;
        return [...messages];
      });
      // An ending the turn's own callbacks did not see (the SDK failed or aborted the reply around them).
      if (outcome.reached && result.status === "error") {
        outcome.error ??= reasonText(result.error ?? "the turn failed");
      } else if (outcome.reached && result.status === "aborted") {
        outcome.aborted = true;
      }
    } catch (error) {
      log("prq.turn.failed", { pr: this.name, jobId, error: errorName(error) }, "error");
    } finally {
      // A turn that ended before its onChatMessage leaves no binding for a later turn to find.
      if (this.#bound === binding) {
        this.#bound = null;
      }
    }
    try {
      await this.#writes.run(() => this.#commitTurn(binding));
    } catch (error) {
      // The job stays running under this turn, which is no longer live: settle's retry wake recovers it.
      log("prq.turn.commit_failed", { pr: this.name, jobId, error: errorName(error) }, "error");
      await this.#armRetry();
    } finally {
      this.#liveTurns.delete(turnId);
    }
    await this.#deliverOutbox();
  }

  // The bound turn's model call, streamed: the job must still be running under this turn. A job with a workspace commit
  // needs its workspace. The outcome is recorded as the stream ends, whatever ends it.
  async #turnResponse(binding: Binding, abortSignal?: AbortSignal): Promise<Response | undefined> {
    const { jobId, turnId, model, outcome } = binding;
    const row = jobById(this.#sql, jobId);
    if (row?.state !== "running" || row.turn_id !== turnId) {
      return undefined;
    }
    const job = this.#job(row);
    if (job.workspaceSha !== null && this.workspaceFor(job) === null) {
      outcome.failure = WORKSPACE_NOT_AVAILABLE;
      return undefined;
    }
    const messages = await this.#turnMessages(row);
    if (messages === null) {
      outcome.failure = "the question is not stored";
      return undefined;
    }
    const result = streamText({
      model,
      system: systemPrompt({ pr: this.#pr(), details: readDetails(this.#sql), job }),
      messages: await convertToModelMessages(messages),
      ...(abortSignal === undefined ? {} : { abortSignal }),
      onError: ({ error }) => {
        outcome.error ??= errorReason(error);
      },
      onAbort: () => {
        outcome.aborted = true;
      },
      onFinish: ({ finishReason, rawFinishReason }) => {
        outcome.finishReason = finishReason;
        outcome.rawFinishReason = rawFinishReason;
      },
      onStepFinish: ({ usage }) => {
        addStep(this.#sql, row, stepTokens(usage));
      },
    });
    const metadata = this.#resultMetadata(row, { kind: "cloud", model: model.modelId });
    return result.toUIMessageStreamResponse({
      generateMessageId: () => resultMessageId(row),
      messageMetadata: ({ part }) => (part.type === "start" ? metadata : undefined),
      onFinish: ({ responseMessage, isAborted }) => {
        outcome.message = responseMessage;
        outcome.aborted ||= isAborted;
      },
      onError: (error) => {
        outcome.error ??= errorReason(error);
        return outcome.error;
      },
    });
  }

  // What the job's model reads after the system prompt: the projection, then its own question (by the job's target)
  // or an analysis's task. Null when the question is not stored.
  async #turnMessages(row: JobRow): Promise<UIMessage[] | null> {
    const session = this.sessions.session();
    const projected = (await projection(session.history())).filter(isUIMessage);
    if (row.kind === "analysis") {
      return [...projected, { id: "task", role: "user", parts: [{ type: "text", text: analysisTask(row.target) }] }];
    }
    const question = await session.getMessage(row.target);
    return question === null || !isUIMessage(question) ? null : [...projected, question];
  }

  #resultMetadata(row: JobRow, by: MessageMetadata["by"], usage?: JobUsage): MessageMetadata {
    const used = usage === undefined ? {} : { usage: usageMetadata(usage) };
    return row.kind === "answer"
      ? { kind: "answer", jobId: row.job_id, questionId: row.target, sha: row.workspace_sha, by, ...used }
      : { kind: "analysis", jobId: row.job_id, headSha: row.target, by, ...used };
  }

  // Inside the history queue, once the SDK's turn has ended. A turn whose job has moved on (another turn, a retry)
  // changes nothing. A turn that ended normally appends its result and marks the job done; any other ending keeps the
  // text it produced as incomplete and fails the job. A turn that never reached its model call is an interruption.
  async #commitTurn({ jobId, turnId, model, outcome }: Binding): Promise<void> {
    const row = jobById(this.#sql, jobId);
    if (row?.state !== "running" || row.turn_id !== turnId) {
      log("prq.turn.stale", { pr: this.name, jobId, state: row?.state ?? null });
      return;
    }
    if (!outcome.reached) {
      await this.#recoverTurn(row);
      return;
    }
    const failure = turnFailure(outcome);
    const metadata = this.#resultMetadata(row, { kind: "cloud", model: model.modelId }, jobUsage(this.#sql, row));
    const parts = resultParts(outcome.message?.parts ?? []);
    if (failure === null) {
      const id = resultMessageId(row);
      await this.insertMessages([{ id, role: "assistant", metadata, parts }], "results");
      this.#endRun(row, { done: id }, model.modelId);
      return;
    }
    if (hasText(parts)) {
      const incomplete = { ...metadata, incomplete: { reason: failure } };
      await this.insertMessages(
        [{ id: incompleteMessageId(row), role: "assistant", metadata: incomplete, parts }],
        "results",
      );
    }
    this.#endRun(row, { failed: failure }, model.modelId);
  }

  // A running job whose turn is not live (the object restarted, or the turn ended before its model call): done when its
  // result is stored (a commit stopped between its append and its statement), started again under a new turn while
  // its run has starts left, else failed. Each is one statement guarded by the turn it found.
  async #recoverTurn(row: JobRow): Promise<void> {
    const model = this.cloudModel()?.modelId ?? null;
    const id = resultMessageId(row);
    if ((await this.#message(id)) !== undefined) {
      this.#endRun(row, { done: id }, model);
      return;
    }
    const agent = this.cloudAgent();
    if (agent === undefined) {
      this.#endRun(row, { failed: CLOUD_NOT_CONFIGURED }, null);
      return;
    }
    if ((jobUsage(this.#sql, row)?.starts ?? 0) >= MAX_STARTS) {
      this.#endRun(row, { failed: TURN_INTERRUPTED }, model);
      return;
    }
    const restarted = restartTurn(this.#sql, row, crypto.randomUUID(), Date.now());
    if (restarted !== undefined) {
      log("prq.job.restarted", { ...this.#jobFields(restarted), run: restarted.run });
      this.#handOver(restarted, agent);
      this.#publishView();
    }
  }

  // Ends a running job's run in one step: its guarded statement, its event and ledger entry, and the seam's hand-over
  // of the next job. Logs the run's usage.
  #endRun(row: JobRow, end: TurnEnd, model: string | null): void {
    const now = Date.now();
    const change = this.ctx.storage.transactionSync(() => {
      const ended = endTurn(this.#sql, row, end, now);
      if (ended === undefined) {
        return null;
      }
      if ("done" in end) {
        recordEvent(this.#sql, ended.kind === "analysis" ? "summary" : "answer", now);
      }
      writeLedger(this.#sql);
      return { ended, usage: jobUsage(this.#sql, ended), cloud: this.#cloudSeam(now) };
    });
    if (change === null) {
      log("prq.turn.stale", { pr: this.name, jobId: row.job_id, state: jobById(this.#sql, row.job_id)?.state ?? null });
      return;
    }
    const { ended, usage } = change;
    if ("done" in end) {
      log("prq.job.done", { ...this.#jobFields(ended), from: "running", to: "done" });
    } else {
      log("prq.job.failed", { ...this.#jobFields(ended), from: "running", to: "failed", reason: end.failed }, "warn");
    }
    log("prq.job.usage", {
      ...this.#jobFields(ended),
      run: ended.run,
      outcome: ended.state,
      model,
      steps: usage?.steps ?? 0,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cachedInputTokens: usage?.cached_input_tokens ?? 0,
      wallMs: usage === undefined ? 0 : Math.max(0, now - usage.started_at),
      starts: usage?.starts ?? 0,
    });
    this.#afterNewWork(change.cloud);
  }

  // --- The wake, settle and the outbox ---

  // A new schedule row each time, never deduplicated: an idempotent one-shot would match the row of a settle that is
  // running and vanish when that run ends.
  async #armWake(delayS = WAKE_S): Promise<void> {
    await this.schedule(delayS, "settle", undefined, { idempotent: false });
  }

  // Run by the wake and at every start: takes in the stored webhook deliveries, and finishes what a stop or a failure
  // left. Each step is idempotent, and a failing step does not stop the others.
  async settle(): Promise<void> {
    await this.#attempt("inbox", () => this.#drainInbox());
    await this.#attempt("create_jobs", () => this.createJobs());
    await this.#attempt("sweep", () => this.#writes.run(() => this.#sweepFinalizing()));
    await this.#attempt("cloud", () => this.#settleCloud());
    await this.#attempt("claim_aged", () => this.#rearmClaimAged());
    await this.#attempt("stalls", () => void this.#publishStalls());
    await this.#deliverOutbox();
  }

  // Every held job whose claim has not reached its deadline has its claimAged check (one a stop between the claim and
  // its schedule left without). A claim past its deadline gets no check again: settle publishes its stall once
  // (#publishStalls), so a lost check costs no repeated alarm or settle work.
  async #rearmClaimAged(): Promise<void> {
    const now = Date.now();
    for (const row of heldJobs(this.#sql)) {
      if (stallDeadline(row) > now) {
        await this.#armClaimAged(row);
      }
    }
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

  // A cloud session's running jobs whose turn is not live here are recovered, then the seam hands over the next job.
  // Inside the history queue, so no commit is between its result's append and its statement.
  async #settleCloud(): Promise<void> {
    if (readOwner(this.#sql) !== "cloud") {
      return;
    }
    await this.#writes.run(async () => {
      for (const row of runningJobs(this.#sql)) {
        if (row.turn_id === null || !this.#liveTurns.has(row.turn_id)) {
          await this.#recoverTurn(row);
        }
      }
      const cloud = this.ctx.storage.transactionSync(() => {
        const outcome = this.#cloudSeam(Date.now());
        if (outcome.failed.length > 0 || outcome.started !== null) {
          writeLedger(this.#sql);
        }
        return outcome;
      });
      this.#afterNewWork(cloud);
    });
  }

  // Delivers the outbox rows to the Hub (spied on in tests), each on its own: a failed one does not keep the other
  // back, and the first failure is thrown once both were tried. A row is deleted only if it is still the generation
  // that was read, so a row written again during the call stays for the next delivery.
  protected async deliver(): Promise<void> {
    const failures: unknown[] = [];
    for (const kind of ["notify", "ledger"] as const) {
      try {
        await this.#deliverRow(kind);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  }

  // notify is idempotent. A ledger row's generation is the entry's revision: the entry is built from the session as it
  // is when the row is read, in the same synchronous step, and the Hub keeps only an entry newer than the one it has.
  async #deliverRow(kind: OutboxKind): Promise<void> {
    const row = outboxRow(this.#sql, kind);
    if (row === undefined) {
      return;
    }
    const entry = kind === "ledger" ? ledgerEntry(this.#sql, Date.now()) : null;
    const hub = await hubStub(this.env);
    await (entry === null
      ? withTimeout(hub.notify(this.name), HUB_CALL_MS, "the Hub's notify")
      : withTimeout(hub.upsertLedger(this.name, row.gen, entry), HUB_CALL_MS, "the Hub's ledger"));
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
