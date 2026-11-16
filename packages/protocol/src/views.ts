import * as v from "valibot";

import { JobTarget } from "./cli.ts";
import { AgentId, PrDetails, PrRef } from "./pr.ts";

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
// session took it in (whole epoch ms, which a ledger page's cursor carries).
export const LatestEvent = v.object({
  kind: v.picklist(["push", "question", "summary", "answer"]),
  at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
export type LatestEvent = v.InferOutput<typeof LatestEvent>;

// The most claims a ledger row lists; its jobs' running count counts them all.
export const MAX_ROW_CLAIMS = 8;

// A claim held in a pull request's session: the agent, the job, and the claim's time by the session's clock.
export const LedgerClaim = v.object({
  agentId: AgentId,
  jobId: v.pipe(v.string(), v.maxLength(64)),
  since: v.number(),
});
export type LedgerClaim = v.InferOutput<typeof LedgerClaim>;

// A pull request as the list shows it: its details (null until its first webhook), its owner (null until its first
// job), its latest event, its problem, its jobs by state (running counts claimed jobs), and the claims held in it, at
// most MAX_ROW_CLAIMS, those of the earliest jobs first.
export const LedgerRow = v.object({
  pr: PrRef,
  details: v.nullable(PrDetails),
  owner: v.nullable(Owner),
  latestEvent: v.nullable(LatestEvent),
  problem: v.nullable(Problem),
  jobs: v.object({ waiting: v.number(), running: v.number(), failed: v.number() }),
  claims: v.pipe(v.array(LedgerClaim), v.maxLength(MAX_ROW_CLAIMS)),
});
export type LedgerRow = v.InferOutput<typeof LedgerRow>;

// The most present agents the Hub view lists; presentAgents counts them all.
export const MAX_VIEW_AGENTS = 32;

// A present local agent, and whether it holds a claim.
export const PoolAgent = v.object({ agentId: AgentId, holdsJob: v.boolean() });
export type PoolAgent = v.InferOutput<typeof PoolAgent>;

// The Hub's Agent state, synced to the UI by useAgent, and bounded whatever the number of pull requests or agents:
// whether a local agent is present, how many are, the first MAX_VIEW_AGENTS of them by ID, the ledger's version, and how
// many rows need attention. It changes only when presence, a held claim or the ledger changes, never on a contact
// alone. The rows themselves are read in pages (LedgerPage); the UI reads them again when ledgerVersion or
// localAgentPresent changes (a row's problem depends on presence). Only the server sets it.
export const HubView = v.object({
  localAgentPresent: v.boolean(),
  presentAgents: v.number(),
  agents: v.pipe(v.array(PoolAgent), v.maxLength(MAX_VIEW_AGENTS)),
  ledgerVersion: v.number(),
  needsAttention: v.number(),
});
export type HubView = v.InferOutput<typeof HubView>;

// A page of the ledger's rows takes at most this many bytes as UTF-8 JSON, and holds at most LEDGER_PAGE_ROWS rows.
export const LEDGER_PAGE_BYTES = 256 * 1024;
export const LEDGER_PAGE_ROWS = 500;
export const MAX_LEDGER_CURSOR_CHARS = 512;

// GET /api/ledger: the rows after the cursor (from the first when there is none), in the list's order.
export const LedgerQuery = v.object({
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_LEDGER_CURSOR_CHARS))),
});
export type LedgerQuery = v.InferOutput<typeof LedgerQuery>;

// A page of rows by latest event, newest first and rows without one last, then by session name. nextCursor names the
// last row's place (null on the last page); a page read with it starts after that row however rows change meanwhile, so
// a row moved by a newer event may be left out of the pass that is under way, which the changed ledgerVersion tells.
export const LedgerPage = v.object({ rows: v.array(LedgerRow), nextCursor: v.nullable(v.string()) });
export type LedgerPage = v.InferOutput<typeof LedgerPage>;

// A retry's body: the job's rev in the view the host retried from.
export const RetryRequest = v.object({ expectedRev: v.pipe(v.number(), v.safeInteger(), v.minValue(0)) });
export type RetryRequest = v.InferOutput<typeof RetryRequest>;

// The answer to a retry: retried when the job waits again; superseded when it is the analysis of a head that is no
// longer current, which only the current head's analysis replaces (its claim ended all the same).
export const RetryResponse = v.object({ status: v.picklist(["retried", "superseded"]) });
export type RetryResponse = v.InferOutput<typeof RetryResponse>;
