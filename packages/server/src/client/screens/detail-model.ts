// What the PR detail shows of a session (plan §1.6, §1.7, §1.10): the header, the versions and the shown summary, the
// conversation with each question's state and answers, the rail's jobs, the composer's hold and context line, and the
// connection. Pure: the screen and the gallery derive the same page from the same inputs.

import type { HubView, JobView, MessageMetadata, Owner, PrSessionView } from "@prq/protocol";

import type { ComposerDown, ComposerHeld } from "../components/Composer.tsx";
import type { ConnectionState } from "../components/ConnectionBanner.tsx";
import type { JobRowState, JobTargetLabel } from "../components/JobRow.tsx";
import type { AnswerState, QuestionState } from "../components/Message.tsx";
import type { PrState } from "../components/PrStateLabel.tsx";
import type { VersionStatus } from "../components/VersionItem.tsx";
import type { Version } from "../components/VersionMenu.tsx";
import type { Connection, RunText, Session, StoredMessage } from "../session.ts";
import { failureOf, type Slot } from "../slots.ts";

export type DetailInput = {
  session: Session;
  slot: Slot | null;
  hub: HubView | null;
  // The version the host picked, by its job.
  picked: string | null;
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

export type AnswerItem = {
  kind: "answer";
  id: string;
  state: AnswerState;
  text: string;
  running: string | null;
  reason?: string;
  sha: string | null;
  model: string | null;
  tokens: number | null;
};

export type JobItem = { jobId: string; state: JobRowState; target: JobTargetLabel; meta: string; at: string | null };

export type DetailContent = {
  versions: Version[];
  shown: Version | null;
  // A newer head being analyzed while another version is shown.
  summarizing: string | null;
  summary: SummaryModel;
  conversation: (QuestionItem | AnswerItem)[];
  jobs: { active: JobItem[]; done: JobItem[] };
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
  composer: { down: ComposerDown | null; held: ComposerHeld | null; answeredAt: string | null };
};

const clock = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// A time of day as the running and waiting lines give it ("10:14").
const clockTime = (at: number): string => clock.format(at);

const RUNNING = new Set<JobView["state"]>(["claimed", "running"]);

const waitingForAgent = (since: number) => `Waiting for a local agent since ${clockTime(since)}`;

// Who runs a job and since when: a cloud turn from its start (the job's last change), a local claim by its agent.
function runningLine(job: JobView, owner: Owner | null): string {
  return owner === "cloud" || job.agentId === null
    ? `cloud · started ${clockTime(job.updatedAt)}`
    : `${job.agentId} · running since ${clockTime(job.since ?? job.updatedAt)}`;
}

// A pending job of a local session waits for an agent when none is present.
const agentAbsent = (view: PrSessionView, hub: HubView | null) =>
  view.owner === "local" && hub !== null && !hub.localAgentPresent;

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

type Indexed = { job: JobView; index: number };

const versionOf = ({ job }: Indexed): Version => ({
  jobId: job.jobId,
  status: versionStatus(job),
  sha: job.target.kind === "analysis" ? job.target.headSha : "",
  at: job.updatedAt,
});

// The analyses newest first; the default is the latest completed one by completion (updatedAt, then position), the
// order the workspace SHA follows; a picked one stays picked.
function versionsOf(view: PrSessionView, picked: string | null) {
  const analyses = view.jobs.flatMap((job, index) => (job.target.kind === "analysis" ? [{ job, index }] : []));
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

function streamedAnswer(run: RunText, job: JobView | undefined, owner: Owner | null): AnswerItem {
  const live = !run.done && job !== undefined && RUNNING.has(job.state);
  return {
    kind: "answer",
    id: `${run.jobId}:${run.run}`,
    state: live ? "streaming" : "complete",
    text: run.text,
    running: live ? runningLine(job, owner) : null,
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
    state: reason === undefined ? "complete" : "incomplete",
    text: message.text,
    running: null,
    ...(reason === undefined ? {} : { reason }),
    sha: message.metadata?.kind === "answer" ? message.metadata.sha : null,
    model: modelOf(message.metadata),
    tokens: tokensOf(message.metadata),
  };
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
    items.push(
      ...answers
        .filter((answer) => answer.metadata?.kind === "answer" && answer.metadata.questionId === question.id)
        .map(storedAnswer),
      ...runs.map((run) => streamedAnswer(run, job, view.owner)),
    );
    // A turn under way before its first text, or a local claim, which streams nothing.
    if (job !== undefined && RUNNING.has(job.state) && runs.every((run) => run.done)) {
      items.push({
        kind: "answer",
        id: job.jobId,
        state: "streaming",
        text: "",
        running: runningLine(job, view.owner),
        sha: null,
        model: null,
        tokens: null,
      });
    }
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
    const running = runningLine(job, view.owner);
    const meta = {
      waiting: job.state === "pending" && agentAbsent(view, hub) ? waitingForAgent(job.updatedAt) : "",
      running,
      stalled: running,
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
        at: answered?.kind === "answer" ? answered.sha : null,
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

function headerOf(view: PrSessionView): Header {
  const { owner, repo, number } = view.pr;
  const details = view.details;
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

export function detailModel({ session, slot, hub, picked }: DetailInput): DetailModel {
  const { view } = session;
  const held: ComposerHeld | null = slot === null ? null : failureOf(slot) === null ? "pending" : "failed";
  const base = {
    header: view === null ? null : headerOf(view),
    banner: BANNER[session.connection],
    composer: { down: DOWN[session.connection], held, answeredAt: null },
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
  const newer = newest.find(
    ({ job }) => RUNNING.has(job.state) && shown !== undefined && job.createdAt > shown.job.createdAt,
  );
  return {
    ...base,
    composer: {
      ...base.composer,
      answeredAt:
        completed !== undefined && shown !== undefined && shown.job.jobId !== completed.job.jobId
          ? versionOf(completed).sha
          : null,
    },
    body: {
      kind: "ready",
      refreshFailed: session.refreshFailed,
      versions: newest.map(versionOf),
      shown: shown === undefined ? null : versionOf(shown),
      summarizing: newer === undefined ? null : versionOf(newer).sha,
      summary: summaryOf(shown, session, view, hub),
      conversation: conversationOf(session, view, slot, hub),
      jobs: jobsOf(session, view, hub),
    },
  };
}
