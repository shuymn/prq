// What the PR detail shows of a session (plan §1.6, §1.7, §1.9, §1.10): the header, the versions and the shown
// summary with a newer analysis's stall or failure, the conversation with each question's state and answers, the
// rail's jobs, each job's Retry, the composer's hold and context line, and the connection. Pure: the screen and the
// gallery derive the same page from the same inputs.

import type { HubView, JobView, MessageMetadata, Owner, PrDetails, PrRef, PrSessionView } from "@prq/protocol";

import type { ComposerDown, ComposerHeld } from "../components/Composer.tsx";
import type { ConnectionState } from "../components/ConnectionBanner.tsx";
import type { JobRowState, JobTargetLabel } from "../components/JobRow.tsx";
import type { AnswerState, QuestionState } from "../components/Message.tsx";
import type { PrState } from "../components/PrStateLabel.tsx";
import type { RetryState } from "../components/retry.tsx";
import type { VersionStatus } from "../components/VersionItem.tsx";
import type { Version } from "../components/VersionMenu.tsx";
import type { Connection, RunText, Session, StoredMessage } from "../session.ts";
import { failureOf, type Slot } from "../slots.ts";

// A job's Retry: the job and the revision shown, which the retry names, and its state.
export type RetryControl = { jobId: string; rev: number; state: RetryState };

export type DetailInput = {
  session: Session;
  slot: Slot | null;
  hub: HubView | null;
  // The version the host picked, by its job.
  picked: string | null;
  // The pull request before the session's first view: the page's reference and the details the PR list last read of
  // it, if any, which the header shows meanwhile.
  known?: { pr: PrRef; details: PrDetails | null } | undefined;
};

type Header = { state: PrState | null; repository: string; number: number; title: string; url: string };

type SummaryModel =
  | { state: "empty"; waiting: string }
  | { state: "ready" | "streaming"; text: string; meta: string | null; running: string | null };

export type QuestionItem = {
  kind: "question";
  id: string;
  text: string;
  state: QuestionState;
  at: number | null;
  waiting?: string;
  failure?: "not-sent" | "unconfirmed";
};

// `run`: the job run it is the text of, when known. `stalled`: a claim past the stall mark, its agent and its start.
export type AnswerItem = {
  kind: "answer";
  id: string;
  run: number | null;
  state: AnswerState;
  text: string;
  running: string | null;
  stalled: { agent: string; since: number } | null;
  reason?: string;
  retry: RetryControl | null;
  sha: string | null;
  model: string | null;
  tokens: number | null;
};

// `since`: a running or possibly stalled job's start, from which the rail gives its elapsed time.
export type JobItem = {
  jobId: string;
  state: JobRowState;
  target: JobTargetLabel;
  meta: string;
  since: number | null;
  at: string | null;
  retry: RetryControl | null;
};

export type DetailContent = {
  versions: Version[];
  shown: Version | null;
  // A newer head being analyzed while another version is shown.
  summarizing: string | null;
  // The current head's analysis, possibly stalled: its head, its agent and the claim's start.
  stalled: { sha: string; agent: string; since: number } | null;
  // The Retry of the claimed analysis the summary's line is about: the stalled one, the newer one summarized, or the
  // shown one being written.
  claimRetry: RetryControl | null;
  // The current head's analysis, failed: its head, why, and the head of the summary shown instead of it.
  failed: { sha: string; reason: string; shown: string | null; retry: RetryControl | null } | null;
  summary: SummaryModel;
  conversation: (QuestionItem | AnswerItem)[];
  jobs: { active: JobItem[]; done: JobItem[] };
  // An analysis (the current head's, though another version is shown, or the one shown) or a question waits for a local
  // agent, which the panel's pool line explains.
  waitsForAgent: boolean;
};

type DetailBody =
  | { kind: "loading" }
  | { kind: "load-failed" }
  | { kind: "unknown" }
  | ({ kind: "ready"; refreshFailed: boolean } & DetailContent);

export type DetailModel = {
  header: Header | null;
  body: DetailBody;
  banner: ConnectionState | null;
  // Send waits for the first view and history read (loading), the connection (down) and a held question (held).
  composer: { loading: boolean; down: ComposerDown | null; held: ComposerHeld | null; answeredAt: string | null };
};

const clock = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// A time of day as the running and waiting lines and a saved prompt give it ("10:14").
export const clockTime = (at: number): string => clock.format(at);

const RUNNING = new Set<JobView["state"]>(["claimed", "running"]);

const waitingForAgent = (since: number) => `Waiting for a local agent since ${clockTime(since)}`;

const isCloud = (job: JobView, owner: Owner | null) => owner === "cloud" || job.agentId === null;

// When a running job started: a cloud turn at the job's last change, a local claim when its agent claimed it.
const startOf = (job: JobView, owner: Owner | null) =>
  isCloud(job, owner) ? job.updatedAt : (job.since ?? job.updatedAt);

// Who runs a job and since when.
function runningLine(job: JobView, owner: Owner | null): string {
  const at = clockTime(startOf(job, owner));
  return isCloud(job, owner) ? `cloud · started ${at}` : `${job.agentId} · running since ${at}`;
}

// A pending job of a local session waits for an agent when none is present.
const agentAbsent = (view: PrSessionView, hub: HubView | null) =>
  view.owner === "local" && hub !== null && !hub.localAgentPresent;

// Retry on a claimed job (before and after the stall mark) and a failed one, none on any other: busy while its request
// is out; after a 409, none until a view of the job's newer revision; after another failure, with the retry error until
// then (the session ends a mark at that view).
function retryOf(job: JobView, session: Session): RetryControl | null {
  if (job.state !== "claimed" && job.state !== "failed") {
    return null;
  }
  const mark = session.retries[job.jobId];
  if (mark?.phase === "withdrawn") {
    return null;
  }
  return { jobId: job.jobId, rev: job.rev, state: mark?.phase ?? "ready" };
}

// A cloud result's usage and model; a local agent's result reports neither.
const tokensOf = (metadata: MessageMetadata | null) => {
  const usage = metadata?.by.kind === "cloud" ? metadata.usage : undefined;
  return usage === undefined ? null : usage.inputTokens + usage.outputTokens;
};

const modelOf = (metadata: MessageMetadata | null) => (metadata?.by.kind === "cloud" ? metadata.by.model : null);

const count = new Intl.NumberFormat("en");

// A cloud result's model and tokens ("deepseek-chat · 12,480 tokens"); the model alone while it streams.
function usageLine(metadata: MessageMetadata | null): string | null {
  const model = modelOf(metadata);
  const tokens = tokensOf(metadata);
  if (model === null) {
    return null;
  }
  return tokens === null ? model : `${model} · ${count.format(tokens)} tokens`;
}

function versionStatus(job: JobView): VersionStatus {
  switch (job.state) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "superseded":
      return "superseded";
    case "pending":
      return "waiting";
    default:
      return "running";
  }
}

// An analysis job, its head and its position in the view.
type Indexed = { job: JobView; sha: string; index: number };

const versionOf = ({ job, sha }: Indexed): Version => ({
  jobId: job.jobId,
  status: versionStatus(job),
  sha,
  at: job.updatedAt,
});

// The analyses newest first; the default is the latest completed one by completion (updatedAt, then position), the
// order the workspace SHA follows; a picked one stays picked.
function versionsOf(view: PrSessionView, picked: string | null) {
  const analyses = view.jobs.flatMap((job, index): Indexed[] =>
    job.target.kind === "analysis" ? [{ job, sha: job.target.headSha, index }] : [],
  );
  const newest = analyses.toSorted((a, b) => b.job.createdAt - a.job.createdAt || b.index - a.index);
  const completed = analyses
    .filter(({ job }) => job.state === "done")
    .toSorted((a, b) => b.job.updatedAt - a.job.updatedAt || b.index - a.index)[0];
  const shown = newest.find(({ job }) => job.jobId === picked) ?? completed ?? newest[0];
  return { newest, completed, shown };
}

const resultsOf = (messages: readonly StoredMessage[], kind: MessageMetadata["kind"]) =>
  messages.filter((message) => message.role === "assistant" && message.metadata?.kind === kind);

function summaryOf(
  shown: Indexed | undefined,
  session: Session,
  view: PrSessionView,
  hub: HubView | null,
): SummaryModel {
  if (shown === undefined) {
    return { state: "empty", waiting: "No summary yet" };
  }
  const { job } = shown;
  const stored = resultsOf(session.messages, "analysis").findLast((message) => message.metadata?.jobId === job.jobId);
  const streamed = session.runs.filter((run) => run.jobId === job.jobId).toSorted((a, b) => b.run - a.run)[0];
  const live = RUNNING.has(job.state) && streamed?.done !== true;
  const running = live ? runningLine(job, view.owner) : null;
  if (
    streamed !== undefined &&
    (stored === undefined || (streamed.run > (stored.metadata?.run ?? 0) && streamed.text !== ""))
  ) {
    return { state: live ? "streaming" : "ready", text: streamed.text, meta: modelOf(streamed.metadata), running };
  }
  if (stored !== undefined) {
    return { state: "ready", text: stored.text, meta: usageLine(stored.metadata), running: null };
  }
  if (RUNNING.has(job.state)) {
    return { state: "streaming", text: "", meta: null, running };
  }
  if (job.state === "pending" && agentAbsent(view, hub)) {
    return { state: "empty", waiting: `${waitingForAgent(job.updatedAt)} — continues when it returns` };
  }
  return { state: "empty", waiting: job.state === "pending" ? "Waiting to start" : "No summary yet" };
}

// A streamed run is live while its job runs that run: an earlier run's text, whose end the page missed, is not.
function streamedAnswer(run: RunText, job: JobView | undefined, owner: Owner | null): AnswerItem {
  const live = !run.done && job !== undefined && RUNNING.has(job.state) && job.run === run.run;
  return {
    kind: "answer",
    id: `${run.jobId}:${run.run}`,
    run: run.run,
    state: live ? "streaming" : "complete",
    text: run.text,
    running: live ? runningLine(job, owner) : null,
    stalled: null,
    retry: null,
    sha: null,
    model: null,
    tokens: null,
  };
}

function storedAnswer(message: StoredMessage): AnswerItem {
  const reason = message.metadata?.incomplete?.reason;
  return {
    kind: "answer",
    id: message.id,
    run: message.metadata?.run ?? null,
    state: reason === undefined ? "complete" : "incomplete",
    text: message.text,
    running: null,
    stalled: null,
    ...(reason === undefined ? {} : { reason }),
    retry: null,
    sha: message.metadata?.kind === "answer" ? message.metadata.sha : null,
    model: modelOf(message.metadata),
    tokens: tokensOf(message.metadata),
  };
}

// What a question's job adds to its answers, by the job's current run. While it runs and that run has neither streamed
// nor left a stored row (a turn before its first text, or a local claim, which streams nothing), the answering row, a
// claim's with its Retry and, past the stall mark, its agent; an earlier run's text does not end it, and the view may
// still say running once the run's row is stored. Once it failed, its reason and Retry on that run's text, or where the
// answer would be when the run left none.
function addJobAnswer(job: JobView, answers: AnswerItem[], session: Session, owner: Owner | null): void {
  const current = answers.findLast((answer) => answer.run === job.run);
  const row = (change: Partial<AnswerItem>): AnswerItem => ({
    kind: "answer",
    id: job.jobId,
    run: job.run,
    state: "streaming",
    text: "",
    running: null,
    stalled: null,
    retry: null,
    sha: null,
    model: null,
    tokens: null,
    ...change,
  });
  if (RUNNING.has(job.state)) {
    if (current === undefined) {
      const stalled =
        job.state === "claimed" && job.stalled ? { agent: job.agentId ?? "cloud", since: startOf(job, owner) } : null;
      answers.push(row({ running: runningLine(job, owner), stalled, retry: retryOf(job, session) }));
    }
    return;
  }
  if (job.state !== "failed") {
    return;
  }
  const failure = { state: "incomplete", reason: job.failure ?? "failed", retry: retryOf(job, session) } as const;
  if (current === undefined) {
    answers.push(row(failure));
  } else {
    Object.assign(current, { ...failure, reason: current.reason ?? failure.reason, running: null });
  }
}

const answerJob = (view: PrSessionView, questionId: string) =>
  view.jobs.find((job) => job.target.kind === "answer" && job.target.messageId === questionId);

// A stored question: queued while another job runs and its own has yet to start, waiting for an agent while its local
// session has none present, else sent.
function storedQuestion(
  message: StoredMessage,
  job: JobView | undefined,
  view: PrSessionView,
  hub: HubView | null,
): QuestionItem {
  const item: QuestionItem = {
    kind: "question",
    id: message.id,
    text: message.text,
    state: "sent",
    at: job?.createdAt ?? null,
  };
  const busy = view.jobs.some((other) => other !== job && RUNNING.has(other.state));
  if ((job === undefined || job.state === "pending") && busy) {
    return { ...item, state: "queued", waiting: "Queued behind the running answer" };
  }
  if (job?.state === "pending" && agentAbsent(view, hub)) {
    return {
      ...item,
      state: "waiting-agent",
      waiting: `${waitingForAgent(job.updatedAt)} — continues when it returns`,
    };
  }
  return item;
}

function conversationOf(session: Session, view: PrSessionView, slot: Slot | null, hub: HubView | null) {
  const answers = resultsOf(session.messages, "answer");
  const items: (QuestionItem | AnswerItem)[] = [];
  for (const question of session.messages.filter((message) => message.role === "user")) {
    const job = answerJob(view, question.id);
    items.push(storedQuestion(question, job, view, hub));
    const runs = session.runs
      .filter((run) => run.metadata.kind === "answer" && run.metadata.questionId === question.id)
      .toSorted((a, b) => a.run - b.run);
    const stored = answers.filter(
      (answer) => answer.metadata?.kind === "answer" && answer.metadata.questionId === question.id,
    );
    const shown = [...stored.map(storedAnswer), ...runs.map((run) => streamedAnswer(run, job, view.owner))];
    if (job !== undefined) {
      addJobAnswer(job, shown, session, view.owner);
    }
    items.push(...shown);
  }
  if (slot !== null && !session.messages.some((message) => message.id === slot.id)) {
    const failure = failureOf(slot);
    items.push({
      kind: "question",
      id: slot.id,
      text: slot.text,
      state: failure === null ? "sent" : "send-failed",
      at: slot.at,
      ...(failure === null ? {} : { failure }),
    });
  }
  return items;
}

function jobState(job: JobView): JobRowState {
  if (job.state === "pending") {
    return "waiting";
  }
  if (job.state === "failed" || job.state === "done") {
    return job.state;
  }
  return job.stalled ? "stalled" : "running";
}

// The rail's jobs: those not done, oldest first, then the done ones. A superseded analysis is listed as a version only.
function jobsOf(session: Session, view: PrSessionView, hub: HubView | null): DetailContent["jobs"] {
  const items = view.jobs.flatMap((job): JobItem[] => {
    if (job.state === "superseded") {
      return [];
    }
    // The run's stored result, else its incomplete text.
    const result = session.messages.find((message) => message.id === job.resultMessageId);
    const answered = (
      result ??
      session.messages.findLast(
        (message) => message.metadata?.jobId === job.jobId && message.metadata.incomplete !== undefined,
      )
    )?.metadata;
    const by = answered?.by;
    const who = by === undefined ? (job.agentId ?? "cloud") : by.kind === "local" ? by.agentId : "cloud";
    const tokens = tokensOf(result?.metadata ?? null);
    const state = jobState(job);
    // A possibly stalled job names its agent; the rail adds how long the claim has had no result.
    const meta = {
      waiting: job.state === "pending" && agentAbsent(view, hub) ? waitingForAgent(job.updatedAt) : "",
      running: runningLine(job, view.owner),
      stalled: who,
      failed: [job.failure, who].filter((part) => part !== null).join(" · "),
      done: tokens === null ? who : `${who} · ${count.format(tokens)} tokens`,
    }[state];
    const question = job.target.kind === "answer" ? job.target.messageId : null;
    return [
      {
        jobId: job.jobId,
        state,
        target:
          job.target.kind === "analysis"
            ? { kind: "analysis", sha: job.target.headSha }
            : {
                kind: "answer",
                question: session.messages.find((message) => message.id === question)?.text ?? "",
              },
        meta,
        since: state === "running" || state === "stalled" ? startOf(job, view.owner) : null,
        at: answered?.kind === "answer" ? answered.sha : null,
        retry: retryOf(job, session),
      },
    ];
  });
  return { active: items.filter((item) => item.state !== "done"), done: items.filter((item) => item.state === "done") };
}

const DOWN: Record<Connection, ComposerDown | null> = {
  connecting: null,
  open: null,
  reconnecting: "reconnecting",
  failed: "disconnected",
};

const BANNER: Record<Connection, ConnectionState | null> = {
  connecting: null,
  open: null,
  reconnecting: "reconnecting",
  failed: "failed",
};

// Without details (before the pull request's first webhook, or a page opened directly before the session's first
// view), what the reference gives: the repository and number, the number as the title, and its GitHub address.
function headerOf({ pr, details }: { pr: PrRef; details: PrDetails | null }): Header {
  const { owner, repo, number } = pr;
  return details === null
    ? {
        state: null,
        repository: `${owner}/${repo}`,
        number,
        title: `Pull request #${number}`,
        url: `https://github.com/${owner}/${repo}/pull/${number}`,
      }
    : { state: details.state, repository: details.fullName, number, title: details.title, url: details.url };
}

export function detailModel({ session, slot, hub, picked, known }: DetailInput): DetailModel {
  const { view } = session;
  const held: ComposerHeld | null = slot === null ? null : failureOf(slot) === null ? "pending" : "failed";
  const pr = view ?? known;
  const base = {
    header: pr === undefined ? null : headerOf(pr),
    banner: BANNER[session.connection],
    composer: { loading: true, down: DOWN[session.connection], held, answeredAt: null },
  };
  if (session.history === "failed") {
    return { ...base, body: { kind: "load-failed" } };
  }
  if (view === null || session.history === "loading") {
    return { ...base, body: { kind: "loading" } };
  }
  if (view.details === null && view.jobs.length === 0 && session.messages.length === 0 && slot === null) {
    return { ...base, body: { kind: "unknown" } };
  }
  const { newest, completed, shown } = versionsOf(view, picked);
  // The current head's analysis, which a push back to an earlier head finds among older jobs.
  const head = view.details?.headSha;
  const current = head === undefined ? newest[0] : newest.find(({ sha }) => sha === head);
  const stalled =
    current?.job.state === "claimed" && current.job.stalled
      ? { sha: current.sha, agent: current.job.agentId ?? "cloud", since: startOf(current.job, view.owner) }
      : null;
  const failed =
    current?.job.state === "failed"
      ? {
          sha: current.sha,
          reason: current.job.failure ?? "failed",
          shown: shown === undefined || shown === current ? null : shown.sha,
          retry: retryOf(current.job, session),
        }
      : null;
  // The analysis under way while another version is shown: the current head's whatever its creation order (a push back
  // to an earlier head revives that head's job, older than the summary shown), else one created after the shown one.
  const newer =
    current !== undefined && current !== shown && RUNNING.has(current.job.state)
      ? current
      : newest.find(({ job }) => RUNNING.has(job.state) && shown !== undefined && job.createdAt > shown.job.createdAt);
  const claimed =
    stalled === null ? (newer ?? (shown !== undefined && RUNNING.has(shown.job.state) ? shown : undefined)) : current;
  const conversation = conversationOf(session, view, slot, hub);
  return {
    ...base,
    composer: {
      ...base.composer,
      loading: false,
      answeredAt:
        completed !== undefined && shown !== undefined && shown.job.jobId !== completed.job.jobId
          ? completed.sha
          : null,
    },
    body: {
      kind: "ready",
      refreshFailed: session.refreshFailed,
      versions: newest.map(versionOf),
      shown: shown === undefined ? null : versionOf(shown),
      // The line says a newer head is analyzed, or that the newest analysis is possibly stalled.
      summarizing: stalled === null ? (newer?.sha ?? null) : null,
      stalled,
      claimRetry: claimed === undefined ? null : retryOf(claimed.job, session),
      failed,
      summary: summaryOf(shown, session, view, hub),
      conversation,
      jobs: jobsOf(session, view, hub),
      waitsForAgent:
        ([current, shown].some((analysis) => analysis?.job.state === "pending") && agentAbsent(view, hub)) ||
        conversation.some((item) => item.kind === "question" && item.state === "waiting-agent"),
    },
  };
}
