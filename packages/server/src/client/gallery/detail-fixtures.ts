// The gallery's PR detail data (plan §1.17), checked against the protocol's schemas: the sessions of the detail.* and
// panel.* frames in design/prq.pen, as the session store would hold them. Times are relative to when the gallery
// renders.

import { HubView, type JobView, MessageMetadata, PrSessionView } from "@prq/protocol";
import * as v from "valibot";

import type { RunText, Session, StoredMessage } from "../session.ts";
import type { Slot } from "../slots.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The heads the frames name, as full SHAs.
export const HEADS = {
  latest: "e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3",
  superseded: "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
  older: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  newer: "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7",
} as const;

const PR = {
  pr: { owner: "shuymn", repo: "prq", number: 42 },
  details: {
    fullName: "shuymn/prq",
    title: "Add retry to stalled jobs",
    state: "open",
    url: "https://github.com/shuymn/prq/pull/42",
    headSha: HEADS.latest,
    baseSha: "0123456789abcdef0123456789abcdef01234567",
  },
};

const LONG_PR = {
  pr: { owner: "shuymn", repo: "zenith", number: 87 },
  details: {
    fullName: "shuymn/zenith",
    title: "Stream tokens to the summary view and keep the previous version listed",
    state: "open",
    url: "https://github.com/shuymn/zenith/pull/87",
    headSha: HEADS.superseded,
    baseSha: "0123456789abcdef0123456789abcdef01234567",
  },
};

export const SUMMARY = `## What changed

Jobs that an agent claimed but never finished can now be retried from the UI. A retry puts the job back to pending and issues a new claim ID, so a late result from the old claim is dropped.

Retries go through \`resetClaim()\` as described in [the design doc](https://github.com/shuymn/prq/blob/main/docs/design.md)

### Risks

- A retry while the first agent is still working costs one extra run.
- The stalled mark starts after 60 minutes; Retry is available before that.

\`\`\`ts
export function retry(job: Job) {
  job.state = "pending";
  job.claimId = crypto.randomUUID();
}
\`\`\`

| File | Change |
| --- | --- |
| session.ts | Adds the retry transition |
| JobRow.tsx | Shows Retry on claimed jobs |

> A result submitted with an old claim ID is discarded.`;

const OLDER_SUMMARY = `## What changed

Jobs that an agent claimed but never finished can be retried by hand. The first version kept the claim ID.`;

const Q1 = "Why does a retry issue a new claim ID instead of reusing the old one?";
const A1 = `A new claim ID lets the session drop a late result from the old claim. If the first agent submits after the retry, its claim ID no longer matches and the result is discarded.

\`\`\`ts
if (submit.claimId !== job.claimId) {
  return { status: "discarded" };
}
\`\`\``;
const Q2 = "Can I retry before the 60-minute stalled mark?";
const A2 =
  "Yes. Retry is available on any claimed or failed job at any time. The stalled mark only tells you that a claimed job has had no result for 60 minutes.";
const A2_PARTIAL =
  "Yes. Retry is available on any claimed or failed job at any time.\n\nThe stalled mark only tells you that";
const Q_OLDER = `What did ${HEADS.older.slice(0, 7)} do with a late result?`;
const A_OLDER = `At ${HEADS.older.slice(0, 7)} a late result was still accepted: the claim ID stayed the same across a retry. Since ${HEADS.latest.slice(0, 7)} it is discarded.`;
const Q_UNSENT = "Does the retry route reset the attempt counter as well?";

type JobSpec = {
  id: string;
  target: { kind: "analysis"; headSha: string } | { kind: "answer"; messageId: string };
  state: JobView["state"];
  ago: number;
  agentId?: string;
  failure?: string;
};

function job(spec: JobSpec, now: number) {
  const claimed = spec.state === "claimed" || spec.state === "running";
  return {
    jobId: spec.id,
    target: spec.target,
    state: spec.state,
    agentId: spec.agentId ?? null,
    since: claimed && spec.agentId !== undefined ? now - spec.ago : null,
    stalled: false,
    failure: spec.failure ?? null,
    resultMessageId: spec.state === "done" ? `${spec.target.kind}-${spec.id}` : null,
    createdAt: now - spec.ago - MINUTE,
    updatedAt: now - spec.ago,
    rev: 1,
  };
}

const CLOUD = { kind: "cloud", model: "deepseek-chat" } as const;
const usage = (tokens: number) => ({ inputTokens: tokens - 400, outputTokens: 400, cachedInputTokens: 0 });

const question = (id: string, text: string): StoredMessage => ({ id, role: "user", text, metadata: null });

function analysis(jobId: string, headSha: string, text: string, tokens: number): StoredMessage {
  const metadata = v.parse(MessageMetadata, {
    kind: "analysis",
    jobId,
    headSha,
    run: 1,
    by: CLOUD,
    usage: usage(tokens),
  });
  return { id: `analysis-${jobId}`, role: "assistant", text, metadata };
}

function answer(jobId: string, questionId: string, text: string, tokens: number, sha: string = HEADS.latest) {
  const metadata = v.parse(MessageMetadata, {
    kind: "answer",
    jobId,
    questionId,
    sha,
    run: 1,
    by: CLOUD,
    usage: usage(tokens),
  });
  return { id: `answer-${jobId}`, role: "assistant", text, metadata } satisfies StoredMessage;
}

function streamed(jobId: string, metadata: unknown, text: string): RunText {
  return { jobId, run: 1, metadata: v.parse(MessageMetadata, metadata), text, done: false };
}

// The versions of the default frame: the latest analysis done, the one before superseded, an older one done.
const versions = (now: number) => [
  job({ id: "a-older", target: { kind: "analysis", headSha: HEADS.older }, state: "done", ago: DAY }, now),
  job(
    { id: "a-superseded", target: { kind: "analysis", headSha: HEADS.superseded }, state: "superseded", ago: HOUR },
    now,
  ),
  job({ id: "a-latest", target: { kind: "analysis", headSha: HEADS.latest }, state: "done", ago: 12 * MINUTE }, now),
];

const SUMMARIES = [
  analysis("a-older", HEADS.older, OLDER_SUMMARY, 9_870),
  analysis("a-latest", HEADS.latest, SUMMARY, 12_480),
];

const CONVERSATION = [
  question("q1", Q1),
  answer("j-q1", "q1", A1, 2_310),
  question("q2", Q2),
  answer("j-q2", "q2", A2, 1_148),
];

const answered = (now: number) => [
  job({ id: "j-q1", target: { kind: "answer", messageId: "q1" }, state: "done", ago: 9 * MINUTE }, now),
  job({ id: "j-q2", target: { kind: "answer", messageId: "q2" }, state: "done", ago: 3 * MINUTE }, now),
];

export type DetailFixture = {
  session: Session;
  slot: Slot | null;
  hub: HubView;
  picked: string | null;
  draft?: string;
  // The new version notice, and whether it warns that reloading loses a question.
  newVersion?: boolean;
};

const hub = (localAgentPresent: boolean) =>
  v.parse(HubView, {
    localAgentPresent,
    presentAgents: localAgentPresent ? 1 : 0,
    jobs: { waiting: 0, running: 0, failed: 0 },
    needsAttention: 0,
    owners: 1,
    ledgerVersion: 3,
  });

function fixture(
  view: { pr?: object; owner: "local" | "cloud"; jobs: unknown[] },
  messages: StoredMessage[],
  change: Partial<Session> & Partial<Omit<DetailFixture, "session">> = {},
): DetailFixture {
  const { slot = null, hub: hubView = hub(true), picked = null, draft, newVersion, ...session } = change;
  return {
    session: {
      view: v.parse(PrSessionView, { ...(view.pr ?? PR), owner: view.owner, jobs: view.jobs }),
      history: "ready",
      refreshFailed: false,
      messages,
      runs: [],
      connection: "open",
      serverVersion: null,
      ...session,
    },
    slot,
    hub: hubView,
    picked,
    ...(draft === undefined ? {} : { draft }),
    ...(newVersion === undefined ? {} : { newVersion }),
  };
}

const answeredSession = (now: number, change: Parameters<typeof fixture>[2] = {}) =>
  fixture({ owner: "cloud", jobs: [...versions(now), ...answered(now)] }, [...SUMMARIES, ...CONVERSATION], change);

// q2's answer streaming under it, its cloud turn started a minute ago; with `asked`, a later question saved meanwhile.
function streaming(now: number, change: Parameters<typeof fixture>[2] = {}, asked: StoredMessage[] = []) {
  const jobs = [
    ...versions(now),
    answered(now)[0],
    job({ id: "j-q2", target: { kind: "answer", messageId: "q2" }, state: "running", ago: MINUTE }, now),
    ...asked.map((message) =>
      job({ id: `j-${message.id}`, target: { kind: "answer", messageId: message.id }, state: "pending", ago: 0 }, now),
    ),
  ];
  return fixture({ owner: "cloud", jobs }, [...SUMMARIES, ...CONVERSATION.slice(0, 3), ...asked], {
    runs: [
      streamed(
        "j-q2",
        { kind: "answer", jobId: "j-q2", questionId: "q2", sha: HEADS.latest, run: 1, by: CLOUD },
        A2_PARTIAL,
      ),
    ],
    ...change,
  });
}

// A newer head's analysis running in the cloud, its text arriving.
function summaryStreaming(now: number, change: Parameters<typeof fixture>[2] = {}) {
  const jobs = [
    ...versions(now),
    ...answered(now),
    job({ id: "a-newer", target: { kind: "analysis", headSha: HEADS.newer }, state: "running", ago: 0 }, now),
  ];
  return fixture({ owner: "cloud", jobs }, [...SUMMARIES, ...CONVERSATION], {
    runs: [
      streamed(
        "a-newer",
        { kind: "analysis", jobId: "a-newer", headSha: HEADS.newer, run: 1, by: CLOUD },
        "## What changed\n\nFailed webhook deliveries are retried by the job runner instead of the request handler.\n\nA slow endpoint no longer",
      ),
    ],
    ...change,
  });
}

// A question history has yet to hold, which a read decided against, and a newer draft.
const sendFailed = (now: number, phase: "not-sent" | "unconfirmed") =>
  answeredSession(now, {
    messages: [...SUMMARIES, ...CONVERSATION.slice(0, 2)],
    slot: { id: "q-unsent", text: Q_UNSENT, at: now - MINUTE, phase },
    draft: "And is the old claim's heartbeat ignored after that?",
    newVersion: true,
  });

// The panel's default frame: a long title, an answer with a code block and its metadata.
const panelDefault = (now: number) =>
  fixture({ pr: LONG_PR, owner: "cloud", jobs: [...versions(now), ...answered(now)] }, [
    ...SUMMARIES,
    ...CONVERSATION.slice(0, 2),
  ]);

export const DETAIL_FIXTURES: Record<string, (now: number) => DetailFixture> = {
  default: (now) => answeredSession(now),
  empty: (now) =>
    fixture(
      {
        pr: LONG_PR,
        owner: "local",
        jobs: [
          job(
            {
              id: "a-first",
              target: { kind: "analysis", headSha: HEADS.superseded },
              state: "pending",
              ago: 6 * MINUTE,
            },
            now,
          ),
        ],
      },
      [],
      { hub: hub(false) },
    ),
  loading: (now) => answeredSession(now, { history: "loading", messages: [] }),
  streaming,
  "summary-streaming": summaryStreaming,
  "waiting-agent": (now) =>
    fixture(
      {
        owner: "local",
        jobs: [
          ...versions(now),
          answered(now)[0],
          job({ id: "j-q2", target: { kind: "answer", messageId: "q2" }, state: "pending", ago: 4 * MINUTE }, now),
        ],
      },
      [...SUMMARIES, ...CONVERSATION.slice(0, 3)],
      { hub: hub(false) },
    ),
  running: (now) =>
    fixture(
      {
        owner: "local",
        jobs: [
          ...versions(now),
          ...answered(now),
          job(
            {
              id: "a-newer",
              target: { kind: "analysis", headSha: HEADS.newer },
              state: "claimed",
              ago: 10 * MINUTE,
              agentId: "agent-7f3a",
            },
            now,
          ),
        ],
      },
      [...SUMMARIES, ...CONVERSATION],
    ),
  queued: (now) => streaming(now, {}, [question("q3", "Does a retry keep the original delivery ID?")]),
  disconnected: (now) => answeredSession(now, { connection: "reconnecting" }),
  "reconnect-failed": (now) => answeredSession(now, { connection: "failed" }),
  "earlier-version": (now) => {
    const jobs = [
      ...versions(now),
      ...answered(now),
      job({ id: "j-q3", target: { kind: "answer", messageId: "q3" }, state: "done", ago: MINUTE }, now),
    ];
    return fixture(
      { owner: "cloud", jobs },
      [...SUMMARIES, ...CONVERSATION, question("q3", Q_OLDER), answer("j-q3", "q3", A_OLDER, 1_920)],
      { picked: "a-older" },
    );
  },
  "send-failed": (now) => sendFailed(now, "not-sent"),
  "panel-send-failed": (now) => sendFailed(now, "unconfirmed"),
  "panel-default": (now) => panelDefault(now),
  "panel-new-version": (now) => ({ ...panelDefault(now), newVersion: true }),
  "panel-summary-streaming": (now) => summaryStreaming(now, { picked: "a-newer" }),
};
