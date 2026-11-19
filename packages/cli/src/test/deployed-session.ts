// The deployed checks of the agent pool and the cloud agent (deployed-check.ts; docs/operations.md, The deployed
// checks): pool waits until no local agent is present; summary takes the first pull request opened after that,
// requires the cloud agent to own it and decides by its stored analysis at GitHub's head; ask asks a question and
// decides by the stored answer to it, not by the chat request's acknowledgement; jobs lists a session's jobs, and
// retry retries one from the revision it lists.
//
// A session is read as the UI reads it: its Agent state from the first cf_agent_state frame of a new WebSocket, its
// stored conversation raw from get-messages, with each result's metadata; a job's result is the assistant message its
// resultMessageId names. Every wait has a bound and ends with the run's signal, and a read that ends after its wait's
// bound does not count. What a line says of a job, a message or an agent comes from deployed-report.ts's helpers.

import { setTimeout as sleep } from "node:timers/promises";

import {
  ErrorResponse,
  type JobView,
  type LedgerRow,
  MessageMetadata,
  type PrRef,
  type PrSessionView,
  RetryResponse,
  Sha,
  sessionName,
} from "@prq/protocol";
import * as v from "valibot";

import { runTool } from "./deployed-edge.ts";
import { agentOf, failureOf, jobIdOf, messageIdOf, type Report, type Verdict } from "./deployed-report.ts";
import {
  agentRows,
  CheckError,
  jsonOf,
  ledgerRows,
  type Origin,
  postRetry,
  readMessages,
  sendQuestion,
  sessionState,
} from "./origin.ts";

// How long and how often each wait reads. A present agent stays present 10 minutes after its last contact, and one
// holding a claim up to 70 minutes after the claim (docs/design.md, Presence); an analysis may wait for a new
// container application's provisioning.
export type Pace = {
  pollMs: number;
  poolMs: number;
  poolReportMs: number;
  newRowMs: number;
  jobMs: number;
};

export const PACE: Pace = {
  pollMs: 5_000,
  poolMs: 75 * 60_000,
  poolReportMs: 60_000,
  newRowMs: 30 * 60_000,
  jobMs: 30 * 60_000,
};

export type SessionContext = { origin: Origin; report: Report; signal: AbortSignal; pace: Pace };

// A bound as a line names it.
function duration(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

// A read within a wait: its result, or null when the wait's deadline passed first (the read is then ended) or before
// the result came. The run's signal ends it with the signal's reason.
export async function readBefore<T>(
  deadline: number,
  signal: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  const left = deadline - performance.now();
  if (left <= 0) {
    return null;
  }
  const bound = AbortSignal.timeout(Math.ceil(left));
  try {
    const value = await read(AbortSignal.any([signal, bound]));
    signal.throwIfAborted();
    return performance.now() <= deadline ? value : null;
  } catch (error) {
    signal.throwIfAborted();
    if (bound.aborted) {
      return null;
    }
    throw error;
  }
}

// Sleeps the poll interval, or what is left of the wait if less.
function pause(pace: Pace, deadline: number, signal: AbortSignal): Promise<void> {
  return sleep(Math.max(0, Math.min(pace.pollMs, deadline - performance.now())), undefined, { signal });
}

const Stored = v.array(
  v.looseObject({
    id: v.string(),
    role: v.string(),
    parts: v.array(v.looseObject({ type: v.string() })),
    metadata: v.optional(v.unknown()),
  }),
);
type Stored = v.InferOutput<typeof Stored>[number];

// A stored message's text: its text parts, joined. Its other parts (tool calls and results) stay in the raw parts.
function textOf(message: Stored): string {
  return message.parts
    .map((part) => (part.type === "text" && typeof part["text"] === "string" ? part["text"] : ""))
    .join("");
}

async function storedMessages(origin: Origin, pr: PrRef, signal: AbortSignal): Promise<Stored[]> {
  return v.parse(Stored, await readMessages(origin, pr, signal));
}

// A done job's result: the message its resultMessageId names, with its metadata, when that message is a complete
// result of the job; else why not.
function resultOf(
  job: JobView,
  messages: readonly Stored[],
): { message: Stored; metadata: MessageMetadata } | { problem: string } {
  const message = job.resultMessageId === null ? undefined : messages.find((entry) => entry.id === job.resultMessageId);
  if (message === undefined) {
    return { problem: `${jobIdOf(job.jobId)} is done, but no message stores its result` };
  }
  if (message.role !== "assistant") {
    return { problem: `${jobIdOf(job.jobId)}'s result ${messageIdOf(message.id)} is not the assistant's message` };
  }
  const metadata = v.safeParse(MessageMetadata, message.metadata);
  if (!metadata.success || metadata.output.jobId !== job.jobId) {
    return { problem: `${jobIdOf(job.jobId)}'s result ${messageIdOf(message.id)} has no metadata of the job` };
  }
  if (metadata.output.incomplete !== undefined) {
    return { problem: `${jobIdOf(job.jobId)}'s result ${messageIdOf(message.id)} is incomplete` };
  }
  return { message, metadata: metadata.output };
}

function tokensOf(metadata: MessageMetadata): string {
  const { usage } = metadata;
  return usage === undefined
    ? "no usage"
    : `${usage.inputTokens} input (${usage.cachedInputTokens} cached), ${usage.outputTokens} output tokens`;
}

// --- pool ---

function describeAgents(rows: Awaited<ReturnType<typeof agentRows>>): string {
  return rows
    .map(
      (row) =>
        `${agentOf(row.agentId)} (last contact ${row.lastSeenAt === null ? "none" : new Date(row.lastSeenAt).toISOString()}, ${row.waiting ? "waiting" : "not waiting"}, ${row.holdsJob ? "holding a job" : "holding no job"})`,
    )
    .join("; ");
}

// Waits until GET /api/agents lists no agent, naming the ones left every poolReportMs. True once the pool is empty.
export async function waitForEmptyPool({ origin, report, signal, pace }: SessionContext): Promise<boolean> {
  const deadline = performance.now() + pace.poolMs;
  let reported = -Infinity;
  let present = "";
  for (;;) {
    const rows = await readBefore(deadline, signal, (bounded) => agentRows(origin, bounded));
    if (rows?.length === 0) {
      report.add({ id: "S0", what: "the agent pool", verdict: "pass", observed: "no agent is present" });
      return true;
    }
    if (rows !== null) {
      present = `${rows.length} agents still present after ${duration(pace.poolMs)}: ${describeAgents(rows)}`;
    }
    const now = performance.now();
    if (rows === null || now >= deadline) {
      report.add({
        id: "S0",
        what: "the agent pool",
        verdict: "fail",
        observed: present === "" ? `no agent list within ${duration(pace.poolMs)}` : present,
      });
      return false;
    }
    if (now - reported >= pace.poolReportMs) {
      reported = now;
      report.note(`waiting for an empty pool; present: ${describeAgents(rows)}`);
    }
    await pause(pace, deadline, signal);
  }
}

// --- summary ---

// GitHub's head of the pull request (gh pr view in the check; a stand-in in its tests).
type HeadOf = (pr: PrRef, signal: AbortSignal) => Promise<string>;

// A gh read's bound.
const GH_MS = 30_000;

// GitHub's head by gh; withheld names the deployment's hostnames, which gh's environment does not hold.
export async function githubHead(pr: PrRef, signal: AbortSignal, withheld: readonly string[] = []): Promise<string> {
  const stdout = await runTool(
    "gh",
    [
      "pr",
      "view",
      String(pr.number),
      "--repo",
      `${pr.owner}/${pr.repo}`,
      "--json",
      "headRefOid",
      "--jq",
      ".headRefOid",
    ],
    { timeoutMs: GH_MS, signal, withheld, keepStdout: true },
  );
  const head = stdout.trim();
  if (!v.is(Sha, head)) {
    throw new CheckError(`gh pr view gave no head for ${pr.owner}/${pr.repo}#${pr.number}`);
  }
  return head;
}

// The verdict on a session at GitHub's head: the analysis job of that head, and its result. Done with a complete cloud
// analysis of that head with text: pass; failed or superseded: fail with its reason; otherwise still waiting.
export function analysisVerdict(
  view: PrSessionView,
  messages: readonly Stored[],
  head: string,
): { done: true; ok: boolean; observed: string; job: JobView } | { done: false } {
  const job = analysisJob(view, head);
  if (job === undefined || !ended(job)) {
    return { done: false };
  }
  if (job.state === "failed") {
    return {
      done: true,
      ok: false,
      observed: `the analysis ${jobIdOf(job.jobId)} failed: ${failureOf(job.failure)}`,
      job,
    };
  }
  if (job.state === "superseded") {
    return { done: true, ok: false, observed: `the analysis ${jobIdOf(job.jobId)} was superseded`, job };
  }
  const result = resultOf(job, messages);
  if ("problem" in result) {
    return { done: true, ok: false, observed: `the analysis ${result.problem}`, job };
  }
  const { message, metadata } = result;
  const text = textOf(message);
  const problems = [
    ...(metadata.kind === "analysis" && metadata.headSha === head ? [] : [`it is not the analysis of ${head}`]),
    ...(metadata.by.kind === "cloud" ? [] : ["a local agent wrote it"]),
    ...(text.trim() === "" ? ["it has no text"] : []),
  ];
  if (problems.length > 0 || metadata.by.kind !== "cloud") {
    return {
      done: true,
      ok: false,
      observed: `the analysis ${jobIdOf(job.jobId)}'s result: ${problems.join("; ")}`,
      job,
    };
  }
  return {
    done: true,
    ok: true,
    observed: `analysis ${jobIdOf(job.jobId)} done at ${head} by the cloud agent (model named in its metadata), ${tokensOf(metadata)}, ${text.length} characters`,
    job,
  };
}

// The session's latest analysis job of the head, and its latest answer job of the question.
function analysisJob(view: PrSessionView, head: string): JobView | undefined {
  return view.jobs.findLast((entry) => entry.target.kind === "analysis" && entry.target.headSha === head);
}

function answerJob(view: PrSessionView, questionId: string): JobView | undefined {
  return view.jobs.findLast((entry) => entry.target.kind === "answer" && entry.target.messageId === questionId);
}

function ended(job: JobView): boolean {
  return job.state === "done" || job.state === "failed" || job.state === "superseded";
}

// Reads the view until decide decides, within the bound; notes each change of what it waits for. Null at the bound.
async function untilDecided<T>(
  { origin, report, signal, pace }: SessionContext,
  pr: PrRef,
  decide: (view: PrSessionView, signal: AbortSignal) => Promise<T | null>,
  describeWaiting: (view: PrSessionView) => string,
): Promise<T | null> {
  const deadline = performance.now() + pace.jobMs;
  let last = "";
  for (;;) {
    const read = await readBefore(deadline, signal, async (bounded) => {
      const view = await sessionState(origin, pr, bounded);
      return { view, decided: await decide(view, bounded) };
    });
    if (read === null) {
      return null;
    }
    if (read.decided !== null) {
      return read.decided;
    }
    const waiting = describeWaiting(read.view);
    if (waiting !== last) {
      last = waiting;
      report.note(waiting);
    }
    if (performance.now() >= deadline) {
      return null;
    }
    await pause(pace, deadline, signal);
  }
}

function jobLine(job: JobView | undefined): string {
  if (job === undefined) {
    return "no job yet";
  }
  return `job ${jobIdOf(job.jobId)} ${job.state}${job.failure === null ? "" : ` (${failureOf(job.failure)})`}`;
}

export type SummaryOptions = { repo: string; headOf: HeadOf };

// S2: the first pull request of the repository seen after the pool emptied, cloud-owned, with a done cloud analysis at
// GitHub's head.
export async function checkSummary(context: SessionContext, { repo, headOf }: SummaryOptions): Promise<void> {
  const { origin, report, signal, pace } = context;
  if (!(await waitForEmptyPool(context))) {
    return;
  }
  const known = new Set((await ledgerRows(origin, { state: "all", repo }, signal)).map((row) => sessionName(row.pr)));
  report.note(`${known.size} pull requests of ${repo} are in the ledger`);
  report.note(`open a new pull request in ${repo} now; this waits up to ${duration(pace.newRowMs)}`);
  const deadline = performance.now() + pace.newRowMs;
  // The first new pull request seen (the oldest, when several come in one read) stays the one taken while its
  // owner is decided.
  let candidate: string | undefined;
  let row: LedgerRow | undefined;
  for (;;) {
    const rows = await readBefore(deadline, signal, (bounded) => ledgerRows(origin, { state: "all", repo }, bounded));
    const first = rows?.findLast((entry) => !known.has(sessionName(entry.pr)));
    candidate ??= first === undefined ? undefined : sessionName(first.pr);
    row = candidate === undefined ? undefined : rows?.find((entry) => sessionName(entry.pr) === candidate);
    if (row !== undefined && row.owner !== null) {
      break;
    }
    if (rows === null || performance.now() >= deadline) {
      report.add({
        id: "S2",
        what: `a new pull request in ${repo}`,
        verdict: "fail",
        observed:
          candidate === undefined
            ? "no new pull request reached the ledger. If the App's Recent deliveries show no event for it, the Pull request event was not subscribed when it was opened: confirm it, and open a new pull request once the pool is empty"
            : `${candidate} reached the ledger, but no job decided its owner`,
      });
      return;
    }
    await pause(pace, deadline, signal);
  }
  const pr = row.pr;
  const name = `${pr.owner}/${pr.repo}#${pr.number}`;
  if (row.owner !== "cloud") {
    report.add({
      id: "S2",
      what: `the owner of ${name}`,
      verdict: "fail",
      observed: "a local agent owns it: open another pull request once the pool is empty",
    });
    return;
  }
  report.add({ id: "S2", what: `the owner of ${name}`, verdict: "pass", observed: "the cloud agent" });
  let head = await headOf(pr, signal);
  report.note(`GitHub's head of ${name}: ${head}`);
  // GitHub is read again whenever the session names another head than GitHub's last read, and before a verdict.
  const reread = async (bounded: AbortSignal) => {
    const now = await headOf(pr, bounded);
    if (now !== head) {
      report.note(`GitHub's head moved to ${now}; deciding by its analysis`);
      head = now;
    }
  };
  const verdict = await untilDecided(
    context,
    pr,
    async (view, bounded) => {
      const named = view.details?.headSha ?? null;
      if (named !== null && named !== head) {
        await reread(bounded);
      }
      const decided = analysisVerdict(view, await storedMessages(origin, pr, bounded), head);
      if (!decided.done) {
        return null;
      }
      const before = head;
      await reread(bounded);
      return head === before ? decided : null;
    },
    (view) => `the analysis of ${head}: ${jobLine(analysisJob(view, head))}`,
  );
  report.add({
    id: "S2",
    what: `the analysis of ${name}`,
    verdict: verdict?.ok === true ? "pass" : "fail",
    observed:
      verdict === null
        ? `no analysis of ${head} ended within ${duration(pace.jobMs)}`
        : verdict.ok || verdict.job.state !== "failed"
          ? verdict.observed
          : `${verdict.observed}; once the cause is fixed: check:deployed retry ${name} ${jobIdOf(verdict.job.jobId)}`,
  });
  if (verdict?.ok === true) {
    report.note(
      "read in the Worker's logs: prq.workspace.prepared (its plan and duration) and prq.job.usage for this job; in the App's Recent deliveries: the delivery answered received",
    );
  }
}

// --- ask ---

// The commit an answer job is worked at, as the Hub fixes it when the job starts (packages/server/src/pr-session/jobs.ts,
// WORKSPACE_SHA): the head of the latest completed analysis, else the session's head, or none before any push.
export function answerWorkspace(view: PrSessionView): string | null {
  let latest: JobView | undefined;
  // The jobs come oldest first, so a later one wins a tie, as the Hub's order does.
  for (const entry of view.jobs) {
    if (
      entry.target.kind === "analysis" &&
      entry.state === "done" &&
      (latest === undefined || entry.updatedAt >= latest.updatedAt)
    ) {
      latest = entry;
    }
  }
  return latest?.target.kind === "analysis" ? latest.target.headSha : (view.details?.headSha ?? null);
}

// The verdict on a session for the question: its answer job, and the job's result naming the question and the commit
// it was written at, which must be the workspace when the question was asked (asked). When the workspace moved while
// the question waited (in this view, or in an earlier read: moved), the job may have started at any of them, and the
// view does not say which, so the commit is not decided: unexercised.
export function answerVerdict(
  view: PrSessionView,
  messages: readonly Stored[],
  questionId: string,
  asked: string | null,
  moved = false,
): { done: true; verdict: Verdict; observed: string } | { done: false } {
  const job = answerJob(view, questionId);
  if (job === undefined || !ended(job)) {
    return { done: false };
  }
  if (job.state !== "done") {
    return {
      done: true,
      verdict: "fail",
      observed: `the answer job ${jobIdOf(job.jobId)} ${job.state}: ${failureOf(job.failure)}`,
    };
  }
  const result = resultOf(job, messages);
  if ("problem" in result) {
    return { done: true, verdict: "fail", observed: `the answer job ${result.problem}` };
  }
  const { message, metadata } = result;
  if (metadata.kind !== "answer") {
    return {
      done: true,
      verdict: "fail",
      observed: `the answer job ${jobIdOf(job.jobId)}'s result ${messageIdOf(message.id)} is no answer`,
    };
  }
  const { questionId: answered, sha, by } = metadata;
  const now = answerWorkspace(view);
  const undecided = moved || now !== asked;
  const problems = [
    ...(answered === questionId ? [] : [`it answers ${messageIdOf(answered)}`]),
    ...(undecided || sha === asked
      ? []
      : [`it was written at ${sha ?? "no commit"}, not at ${asked ?? "no commit"}, the workspace when it was asked`]),
    ...(textOf(message).trim() === "" ? ["it has no text"] : []),
  ];
  if (problems.length > 0) {
    return {
      done: true,
      verdict: "fail",
      observed: `the stored answer ${messageIdOf(message.id)}: ${problems.join("; ")}`,
    };
  }
  const author = by.kind === "cloud" ? "the cloud agent (model named in its metadata)" : "a local agent";
  const tokens = metadata.usage === undefined ? "" : `, ${tokensOf(metadata)}`;
  const observed = `answer ${messageIdOf(message.id)} to ${questionId} by ${author} at ${sha ?? "no commit"}${tokens}, ${textOf(message).length} characters`;
  return undecided
    ? {
        done: true,
        verdict: "unexercised",
        observed: `${observed}; the workspace moved from ${asked ?? "no commit"} while it waited (now ${now ?? "no commit"}), so the commit it should be at is not decided`,
      }
    : { done: true, verdict: "pass", observed };
}

// S4: a question over the session's WebSocket, decided by its stored answer at the workspace the question was asked at.
export async function checkAsk(context: SessionContext, pr: PrRef, text: string): Promise<void> {
  const { origin, report, pace, signal } = context;
  const name = `${pr.owner}/${pr.repo}#${pr.number}`;
  const before = await sessionState(origin, pr, signal);
  if (before.owner === null) {
    report.note(`${name} has no owner yet: this question's job decides it`);
  }
  const asked = answerWorkspace(before);
  const questionId = `check-${crypto.randomUUID()}`;
  const { acknowledgedAt } = await sendQuestion(origin, pr, { id: questionId, text }, { signal });
  report.note(
    `question ${questionId} acknowledged at ${acknowledgedAt}, at ${asked ?? "no commit"}; the acknowledgement is not the answer`,
  );
  // Whether any read showed the workspace other than when the question was asked.
  let moved = false;
  const verdict = await untilDecided(
    context,
    pr,
    async (view, bounded) => {
      moved ||= answerWorkspace(view) !== asked;
      const decided = answerVerdict(view, await storedMessages(origin, pr, bounded), questionId, asked, moved);
      return decided.done ? decided : null;
    },
    (view) => `the answer to ${questionId}: ${jobLine(answerJob(view, questionId))}`,
  );
  report.add({
    id: "S4",
    what: `the answer to a question on ${name}`,
    verdict: verdict === null ? "fail" : verdict.verdict,
    observed: verdict === null ? `no answer job ended within ${duration(pace.jobMs)}` : verdict.observed,
  });
}

// --- jobs, retry ---

function target(job: JobView): string {
  return job.target.kind === "analysis"
    ? `analysis of ${job.target.headSha}`
    : `answer to ${messageIdOf(job.target.messageId)}`;
}

// The session's jobs as its Agent state lists them, oldest first.
export async function listJobs({ origin, report, signal }: SessionContext, pr: PrRef): Promise<void> {
  const view = await sessionState(origin, pr, signal);
  report.note(
    `${pr.owner}/${pr.repo}#${pr.number}: owner ${view.owner ?? "none yet"}, head ${view.details?.headSha ?? "none yet"}, ${view.jobs.length} jobs`,
  );
  for (const job of view.jobs) {
    report.note(
      `${jobIdOf(job.jobId)} ${target(job)}: ${job.state}, rev ${job.rev}${job.agentId === null ? "" : `, by ${agentOf(job.agentId)}`}${job.failure === null ? "" : `, ${failureOf(job.failure)}`}`,
    );
  }
}

// The host's retry of a claimed or failed job, from the revision the session's state lists.
export async function retryJob({ origin, report, signal }: SessionContext, pr: PrRef, jobId: string): Promise<void> {
  const name = `${pr.owner}/${pr.repo}#${pr.number}`;
  const job = (await sessionState(origin, pr, signal)).jobs.find((entry) => entry.jobId === jobId);
  if (job === undefined) {
    report.add({
      id: "retry",
      what: `${jobIdOf(jobId)} on ${name}`,
      verdict: "fail",
      observed: "the session lists no such job",
    });
    return;
  }
  report.note(`${jobIdOf(jobId)} ${target(job)}: ${job.state}, rev ${job.rev}`);
  const answer = await postRetry(origin, pr, jobId, job.rev, signal);
  const retried = v.safeParse(RetryResponse, jsonOf(answer));
  const refused = v.safeParse(ErrorResponse, jsonOf(answer));
  report.add({
    id: "retry",
    what: `${jobIdOf(jobId)} on ${name} from rev ${job.rev}`,
    verdict: answer.status === 200 && retried.success ? "pass" : "fail",
    observed:
      answer.status === 200 && retried.success
        ? retried.output.status === "retried"
          ? "retried: the job waits again"
          : "superseded: the analysis of a head that is no longer current; the current head's analysis replaces it"
        : `HTTP ${answer.status}${refused.success ? ` ${refused.output.error}` : ""}`,
  });
}
