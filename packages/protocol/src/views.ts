import * as v from "valibot";

import { JobTarget } from "./cli.ts";
import { PrRef } from "./pr.ts";

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
// claimed or running job), failure the reason a failed job gives.
export const JobView = v.object({
  jobId: v.string(),
  target: JobTarget,
  state: v.picklist(["pending", "claimed", "running", "done", "failed", "superseded"]),
  agentId: v.nullable(v.string()),
  since: v.nullable(v.number()),
  failure: v.nullable(v.string()),
  resultMessageId: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});
export type JobView = v.InferOutput<typeof JobView>;

// A PrSession's Agent state, synced to the UI by useAgent: the pull request, its owner (null until the first job) and
// its jobs, oldest first. Only the server sets it.
export const PrSessionView = v.object({ pr: PrRef, owner: v.nullable(Owner), jobs: v.array(JobView) });
export type PrSessionView = v.InferOutput<typeof PrSessionView>;

// The answer to a retry.
export const RetryResponse = v.object({ status: v.literal("retried") });
export type RetryResponse = v.InferOutput<typeof RetryResponse>;
