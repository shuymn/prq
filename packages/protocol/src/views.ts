import * as v from "valibot";

import { JobTarget } from "./cli.ts";
import { PrDetails, PrRef } from "./pr.ts";

// Sent on every WebSocket connection to the Hub and to a PrSession: a browser cannot read the Prq-Version header of a
// WebSocket response, so the UI learns the server's version from this message (docs/design.md, Versions).
export const ServerVersionMessage = v.object({ type: v.literal("prq:version"), version: v.string() });
export type ServerVersionMessage = v.InferOutput<typeof ServerVersionMessage>;

// Sent to every connection to a PrSession after a write, in place of the stored history when that is longer than one
// list the server sends: the UI reloads the history through get-messages, which streams all of it.
export const HistoryChangedMessage = v.object({ type: v.literal("prq:history-changed") });
export type HistoryChangedMessage = v.InferOutput<typeof HistoryChangedMessage>;

// Who answers a pull request's questions and analyses: decided at the session's first job, then fixed.
export const Owner = v.picklist(["local", "cloud"]);
export type Owner = v.InferOutput<typeof Owner>;

// A job as the UI shows it. A job being finalized shows as running. since is when its current claim was made (for a
// claimed or running job), stalled whether that claim has had no result for 60 minutes (by the session's clock when
// the view was made), failure the reason a failed job gives. rev is the job's revision, which every change of the job
// advances; a retry names the revision it was made from.
export const JobView = v.object({
  jobId: v.string(),
  target: JobTarget,
  state: v.picklist(["pending", "claimed", "running", "done", "failed", "superseded"]),
  agentId: v.nullable(v.string()),
  since: v.nullable(v.number()),
  stalled: v.boolean(),
  failure: v.nullable(v.string()),
  resultMessageId: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  rev: v.number(),
});
export type JobView = v.InferOutput<typeof JobView>;

// A PrSession's Agent state, synced to the UI by useAgent: the pull request, its details (null until its first
// webhook), its owner (null until the first job) and its jobs, oldest first. Only the server sets it.
export const PrSessionView = v.object({
  pr: PrRef,
  details: v.nullable(PrDetails),
  owner: v.nullable(Owner),
  jobs: v.array(JobView),
});
export type PrSessionView = v.InferOutput<typeof PrSessionView>;

// A pull request's problem in the ledger: at most one, the first that applies in this order (docs/design.md, PR
// ledger). Every label but the last needs the host's attention.
export const Problem = v.picklist([
  "summary_failed",
  "answer_failed",
  "possibly_stalled",
  "waiting_for_local_agent",
  "new_push_not_summarized",
]);
export type Problem = v.InferOutput<typeof Problem>;

// What moves a ledger row: a push that changed the head, a question, a completed summary or answer, with the time its
// session took it in (epoch ms).
export const LatestEvent = v.object({
  kind: v.picklist(["push", "question", "summary", "answer"]),
  at: v.number(),
});
export type LatestEvent = v.InferOutput<typeof LatestEvent>;

// A pull request as the list shows it: its details (null until its first webhook), its owner (null until its first
// job), its latest event, its problem, its jobs by state (running counts claimed jobs), and the claims held in it
// (since: the claim's time by the session's clock).
export const LedgerRow = v.object({
  pr: PrRef,
  details: v.nullable(PrDetails),
  owner: v.nullable(Owner),
  latestEvent: v.nullable(LatestEvent),
  problem: v.nullable(Problem),
  jobs: v.object({ waiting: v.number(), running: v.number(), failed: v.number() }),
  claims: v.array(v.object({ agentId: v.string(), jobId: v.string(), since: v.number() })),
});
export type LedgerRow = v.InferOutput<typeof LedgerRow>;

// A present local agent: its last contact (null when only its claim makes it present), whether it is in a wait, and
// whether it holds a claim.
export const PoolAgent = v.object({
  agentId: v.string(),
  lastSeenAt: v.nullable(v.number()),
  waiting: v.boolean(),
  holdsJob: v.boolean(),
});
export type PoolAgent = v.InferOutput<typeof PoolAgent>;

// The Hub's Agent state, synced to the UI by useAgent: whether a local agent is present, the present agents by ID,
// every pull request's row by latest event (newest first, rows without one last), and how many rows need attention.
// Only the server sets it.
export const HubView = v.object({
  localAgentPresent: v.boolean(),
  agents: v.array(PoolAgent),
  prs: v.array(LedgerRow),
  needsAttention: v.number(),
});
export type HubView = v.InferOutput<typeof HubView>;

// A retry's body: the job's rev in the view the host retried from.
export const RetryRequest = v.object({ expectedRev: v.pipe(v.number(), v.safeInteger(), v.minValue(0)) });
export type RetryRequest = v.InferOutput<typeof RetryRequest>;

// The answer to a retry: retried when the job waits again; superseded when it is the analysis of a head that is no
// longer current, which only the current head's analysis replaces (its claim ended all the same).
export const RetryResponse = v.object({ status: v.picklist(["retried", "superseded"]) });
export type RetryResponse = v.InferOutput<typeof RetryResponse>;
