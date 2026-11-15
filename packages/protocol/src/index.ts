// The contract between the Worker and prq (/cli/*). Server-only rules (job state, coalescing) stay in @prq/server.
import * as v from "valibot";

export const AgentId = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

export const JobTarget = v.variant("kind", [
  v.object({ kind: v.literal("answer"), messageId: v.string() }),
  v.object({ kind: v.literal("analysis"), headSha: v.string() }),
]);
export type JobTarget = v.InferOutput<typeof JobTarget>;

export const Job = v.object({
  jobId: v.string(),
  session: v.string(),
  target: JobTarget,
  /** The question text for an answer job. */
  question: v.optional(v.string()),
});
export type Job = v.InferOutput<typeof Job>;

export const WaitRequest = v.object({ agentId: AgentId, timeoutMs: v.optional(v.number()) });
export const WaitResponse = v.variant("status", [
  v.object({ status: v.literal("ready") }),
  v.object({ status: v.literal("timeout") }),
]);
export type WaitResponse = v.InferOutput<typeof WaitResponse>;

export const ClaimRequest = v.object({ agentId: AgentId });
export const ClaimResponse = v.union([
  v.object({ job: Job, claimId: v.string(), resumed: v.boolean() }),
  v.object({ job: v.null() }),
]);
export type ClaimResponse = v.InferOutput<typeof ClaimResponse>;

export const SubmitRequest = v.object({
  agentId: AgentId,
  session: v.string(),
  jobId: v.string(),
  claimId: v.string(),
  target: JobTarget,
  text: v.string(),
});
export type SubmitRequest = v.InferOutput<typeof SubmitRequest>;

export const SubmitResponse = v.object({
  status: v.picklist(["accepted", "duplicate"]),
  messageId: v.string(),
});
export type SubmitResponse = v.InferOutput<typeof SubmitResponse>;

export const ErrorCode = v.picklist([
  "unauthorized",
  "bad_request",
  "unknown_job",
  "stale_claim",
  "target_mismatch",
  "not_local",
]);
export type ErrorCode = v.InferOutput<typeof ErrorCode>;
export const ErrorResponse = v.object({ error: ErrorCode, detail: v.optional(v.string()) });
export type ErrorResponse = v.InferOutput<typeof ErrorResponse>;
