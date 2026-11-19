// The gallery's data (plan §1.17), checked against the protocol's schemas: the Hub's views and the ledger's rows of the
// PR list frames in design/prq.pen. Times are relative to when the gallery renders.

import { HubView, LedgerRow, type Problem } from "@prq/protocol";
import * as v from "valibot";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Spec = {
  owner?: string;
  repo: string;
  number: number;
  title: string;
  state?: "open" | "closed" | "merged";
  kind: "push" | "question" | "summary" | "answer";
  ago: number;
  problem?: Problem;
};

function row(spec: Spec, now: number): LedgerRow {
  const owner = spec.owner ?? "shuymn";
  return v.parse(LedgerRow, {
    pr: { owner, repo: spec.repo, number: spec.number },
    details: {
      fullName: `${owner}/${spec.repo}`,
      title: spec.title,
      state: spec.state ?? "open",
      url: `https://github.com/${owner}/${spec.repo}/pull/${spec.number}`,
      headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      baseSha: "0123456789abcdef0123456789abcdef01234567",
    },
    owner: "local",
    latestEvent: { kind: spec.kind, at: now - spec.ago },
    problem: spec.problem ?? null,
    jobs: { waiting: 0, running: 0, failed: 0 },
    claims: [],
  });
}

const LONG_TITLE =
  "Stream tokens to the summary view over the WebSocket, keep the previous version listed until the new one completes";

// PR list / Default: one row for each problem the list names; most are healthy.
const DEFAULT_ROWS: Spec[] = [
  {
    repo: "prq",
    number: 41,
    title: "Split the webhook handler by event type",
    kind: "push",
    ago: 2 * MINUTE,
    problem: "new_push_not_summarized",
  },
  { repo: "prq", number: 42, title: "Add retry to stalled jobs", kind: "answer", ago: 3 * MINUTE },
  {
    repo: "kopje",
    number: 16,
    title: "Render Markdown tables in answers",
    kind: "question",
    ago: 8 * MINUTE,
    problem: "answer_failed",
  },
  { repo: "zenith", number: 87, title: LONG_TITLE, kind: "summary", ago: 12 * MINUTE },
  {
    repo: "kopje",
    number: 15,
    title: "Pin skill commits on register",
    kind: "question",
    ago: HOUR,
    problem: "possibly_stalled",
  },
  {
    repo: "zenith",
    number: 85,
    title: "Cache installation tokens per repository",
    kind: "push",
    ago: 2 * HOUR,
    problem: "waiting_for_local_agent",
  },
  {
    repo: "zenith",
    number: 84,
    title: "Retry GitHub API calls on secondary rate limits",
    kind: "summary",
    ago: 3 * HOUR,
  },
  { repo: "prq", number: 39, title: "Document the job claim protocol", kind: "answer", ago: DAY },
  { repo: "prq", number: 38, title: "Move settings to their own page", kind: "summary", ago: 2 * DAY },
  { repo: "kopje", number: 14, title: "Show allowed tools in the skill review", kind: "answer", ago: 3 * DAY },
];

// PR list / All: merged and closed pull requests among the open ones.
const ALL_ROWS: Spec[] = [
  ...DEFAULT_ROWS.slice(0, 4),
  { repo: "prq", number: 40, title: "Add the prq wait long-poll", state: "merged", kind: "summary", ago: 40 * MINUTE },
  ...DEFAULT_ROWS.slice(4, 7),
  {
    repo: "zenith",
    number: 83,
    title: "Drop the legacy polling endpoint",
    state: "closed",
    kind: "answer",
    ago: 5 * HOUR,
  },
  ...DEFAULT_ROWS.slice(7, 8),
  {
    repo: "kopje",
    number: 12,
    title: "Register skills from a GitHub URL",
    state: "merged",
    kind: "summary",
    ago: DAY + HOUR,
  },
  ...DEFAULT_ROWS.slice(8),
];

export const defaultRows = (now: number) => DEFAULT_ROWS.map((spec) => row(spec, now));
export const allRows = (now: number) => ALL_ROWS.map((spec) => row(spec, now));

// The Hub's view: no local agent, two jobs running and three waiting, three rows needing attention, one owner.
export const CLOUD_ONLY = v.parse(HubView, {
  localAgentPresent: false,
  presentAgents: 0,
  jobs: { waiting: 3, running: 2, failed: 1 },
  needsAttention: 3,
  owners: 1,
  ledgerVersion: 12,
});

// An empty ledger with one local agent present.
export const EMPTY_LOCAL = v.parse(HubView, {
  localAgentPresent: true,
  presentAgents: 1,
  jobs: { waiting: 0, running: 0, failed: 0 },
  needsAttention: 0,
  owners: 0,
  ledgerVersion: 0,
});
