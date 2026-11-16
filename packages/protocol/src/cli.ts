import * as v from "valibot";

import { MessageId, PrRef, Sha } from "./pr.ts";

// What a job produces: the analysis of a head, or the answer to a question.
export const JobTarget = v.variant("kind", [
  v.object({ kind: v.literal("analysis"), headSha: Sha }),
  v.object({ kind: v.literal("answer"), messageId: MessageId }),
]);
export type JobTarget = v.InferOutput<typeof JobTarget>;

// A job as a local agent receives it. workspaceSha is the commit to work at, fixed when the job was claimed: an
// analysis's head; for an answer the head of the latest completed analysis, or null when there is none. question is
// the question's text, for an answer.
export const Job = v.object({
  jobId: v.pipe(v.string(), v.uuid()),
  pr: PrRef,
  target: JobTarget,
  workspaceSha: v.nullable(Sha),
  question: v.optional(v.string()),
});
export type Job = v.InferOutput<typeof Job>;

// The answer to a claim: a job with the claim's ID, or none. resumed is true when the job was the agent's own claimed
// job, now under a new claimId.
export const ClaimResponse = v.union([
  v.object({ job: Job, claimId: v.pipe(v.string(), v.uuid()), resumed: v.boolean() }),
  v.object({ job: v.null() }),
]);
export type ClaimResponse = v.InferOutput<typeof ClaimResponse>;

// The answer to an accepted submit: accepted when it added the message, duplicate when the same claim had already
// submitted it and nothing was added.
export const SubmitResponse = v.object({ status: v.picklist(["accepted", "duplicate"]), messageId: MessageId });
export type SubmitResponse = v.InferOutput<typeof SubmitResponse>;
