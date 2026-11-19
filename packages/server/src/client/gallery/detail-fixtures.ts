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

// The heads of the failed frames' pull request.
const WEBHOOK_HEADS = {
  failed: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
  latest: "7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b",
  superseded: "5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c",
  first: "0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c",
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

const WEBHOOK_PR = {
  pr: { owner: "shuymn", repo: "prq", number: 41 },
  details: {
    fullName: "shuymn/prq",
    title: "Split the webhook handler by event type",
    state: "open",
    url: "https://github.com/shuymn/prq/pull/41",
    headSha: WEBHOOK_HEADS.failed,
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
const WEBHOOK_SUMMARY = `## What changed

The webhook handler is split into one module per event type. pull_request, issue_comment and installation events each get their own handler, and unknown events are acknowledged and ignored.

Routing lives in \`routeEvent()\` as described in [the design doc](https://github.com/shuymn/prq/blob/main/docs/design.md)`;
const Q_EVENTS = "Why are unknown events acknowledged instead of rejected?";
const A_EVENTS = `GitHub redelivers an event whose delivery got an error response. Acknowledging unknown events keeps those redeliveries from piling up.

\`\`\`ts
default:
  return new Response(null, { status: 202 });
\`\`\``;
const Q_TOKEN = "Walk me through every handler that reads the installation token.";
const A_TOKEN_PARTIAL =
  "The installation token is read in installation.ts when the app is installed, and in pull_request.ts before the checkout. The comment handler then";
const SPEND_LIMIT = "the provider refused the call: spend limit reached";

type JobSpec = {
  id: string;
  target: { kind: "analysis"; headSha: string } | { kind: "answer"; messageId: string };
  state: JobView["state"];
  ago: number;
  agentId?: string;
  failure?: string;
  stalled?: boolean;
};

function job(spec: JobSpec, now: number) {
  const claimed = spec.state === "claimed" || spec.state === "running";
  return {
    jobId: spec.id,
    target: spec.target,
    state: spec.state,
    agentId: spec.agentId ?? null,
    since: claimed && spec.agentId !== undefined ? now - spec.ago : null,
    stalled: spec.stalled ?? false,
    failure: spec.failure ?? null,
    resultMessageId: spec.state === "done" ? `${spec.target.kind}-${spec.id}` : null,
    createdAt: now - spec.ago - MINUTE,
    updatedAt: now - spec.ago,
    rev: 1,
    run: 1,
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

// A run's text that stopped, stored with the reason.
function incomplete(jobId: string, questionId: string, text: string, reason: string, sha: string): StoredMessage {
  const metadata = v.parse(MessageMetadata, {
    kind: "answer",
    jobId,
    questionId,
    sha,
    run: 1,
    by: CLOUD,
    incomplete: { reason },
  });
  return { id: `answer-${jobId}-r1-incomplete`, role: "assistant", text, metadata };
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
  railCollapsed?: boolean;
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
  const { slot = null, hub: hubView = hub(true), picked = null, draft, newVersion, railCollapsed, ...session } = change;
  return {
    session: {
      view: v.parse(PrSessionView, { ...(view.pr ?? PR), owner: view.owner, jobs: view.jobs }),
      history: "ready",
      refreshFailed: false,
      messages,
      runs: [],
      connection: "open",
      serverVersion: null,
      retries: {},
      ...session,
    },
    slot,
    hub: hubView,
    picked,
    ...(draft === undefined ? {} : { draft }),
    ...(newVersion === undefined ? {} : { newVersion }),
    ...(railCollapsed === undefined ? {} : { railCollapsed }),
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

// The failed frames' pull request: its versions (the latest analysis failed, when `analysisFailed`), a done question and a
// failed one whose text stopped.
function failedSession(now: number, analysisFailed: boolean) {
  const jobs = [
    job({ id: "a-first", target: { kind: "analysis", headSha: WEBHOOK_HEADS.first }, state: "done", ago: DAY }, now),
    job(
      {
        id: "a-superseded",
        target: { kind: "analysis", headSha: WEBHOOK_HEADS.superseded },
        state: "superseded",
        ago: 3 * HOUR,
      },
      now,
    ),
    job(
      { id: "a-latest", target: { kind: "analysis", headSha: WEBHOOK_HEADS.latest }, state: "done", ago: 2 * HOUR },
      now,
    ),
    job({ id: "j-events", target: { kind: "answer", messageId: "q-events" }, state: "done", ago: 59 * MINUTE }, now),
    ...(analysisFailed
      ? [
          job(
            {
              id: "a-failed",
              target: { kind: "analysis", headSha: WEBHOOK_HEADS.failed },
              state: "failed",
              ago: 10 * MINUTE,
              failure: SPEND_LIMIT,
            },
            now,
          ),
        ]
      : []),
    job(
      {
        id: "j-token",
        target: { kind: "answer", messageId: "q-token" },
        state: "failed",
        ago: 5 * MINUTE,
        failure: analysisFailed ? SPEND_LIMIT : "step limit reached",
      },
      now,
    ),
  ];
  return fixture({ pr: WEBHOOK_PR, owner: "cloud", jobs }, [
    analysis("a-first", WEBHOOK_HEADS.first, WEBHOOK_SUMMARY, 9_870),
    analysis("a-latest", WEBHOOK_HEADS.latest, WEBHOOK_SUMMARY, 10_214),
    question("q-events", Q_EVENTS),
    answer("j-events", "q-events", A_EVENTS, 2_310, WEBHOOK_HEADS.latest),
    question("q-token", Q_TOKEN),
    incomplete(
      "j-token",
      "q-token",
      A_TOKEN_PARTIAL,
      analysisFailed ? SPEND_LIMIT : "step limit reached",
      WEBHOOK_HEADS.latest,
    ),
  ]);
}

export const DETAIL_FIXTURES: Record<string, (now: number) => DetailFixture> = {
  default: (now) => answeredSession(now, { railCollapsed: true }),
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
  // The latest head's analysis claimed by an agent with no result for 64 minutes, the version before it shown.
  stalled: (now) =>
    fixture(
      {
        owner: "local",
        jobs: [
          job({ id: "a-older", target: { kind: "analysis", headSha: HEADS.older }, state: "done", ago: DAY }, now),
          job({ id: "j-q1", target: { kind: "answer", messageId: "q1" }, state: "done", ago: DAY }, now),
          job(
            {
              id: "a-latest",
              target: { kind: "analysis", headSha: HEADS.latest },
              state: "claimed",
              ago: 64 * MINUTE,
              agentId: "mbp-office",
              stalled: true,
            },
            now,
          ),
        ],
      },
      [
        analysis("a-older", HEADS.older, SUMMARY, 11_902),
        question("q1", Q1),
        answer("j-q1", "q1", A1, 2_310, HEADS.older),
      ],
      { railCollapsed: true },
    ),
  failed: (now) => failedSession(now, true),
  "panel-failed": (now) => failedSession(now, false),
  "send-failed": (now) => sendFailed(now, "not-sent"),
  "panel-send-failed": (now) => sendFailed(now, "unconfirmed"),
  "panel-default": (now) => panelDefault(now),
  "panel-new-version": (now) => ({ ...panelDefault(now), newVersion: true }),
  "panel-summary-streaming": (now) => summaryStreaming(now, { picked: "a-newer" }),
};
