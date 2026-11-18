import * as v from "valibot";

// What went wrong. Statuses: 400 bad_request, 401 unauthorized, 404 not_found and unknown_job, 409 stale_claim,
// target_mismatch, not_retryable, stale_job, skill_exists and skill_changed, 422 invalid_skill, 500 internal, 503
// unavailable. 503 means the server could not complete the request now: Access's keys could not be fetched, a Durable
// Object or GitHub did not answer in time. The caller tries again; it is never an authentication failure.
export const ErrorCode = v.picklist([
  "unauthorized",
  "bad_request",
  "not_found",
  "internal",
  "unavailable",
  // No job with that jobId in the session.
  "unknown_job",
  // The claimId is not the job's current claim (a retry or a resume replaced it), or the job was finished by another.
  "stale_claim",
  // The submitted target (head SHA or question ID) is not the job's.
  "target_mismatch",
  // Only a claimed or failed job can be retried.
  "not_retryable",
  // The job changed since the view a retry was made from (its rev is not the expected one); the UI reads it again.
  "stale_job",
  // A skill of that name is registered already.
  "skill_exists",
  // The skill's registration is not at the expected revision: it was updated, or removed, since the preview.
  "skill_changed",
  // GitHub's skill is not one prq stores: its frontmatter, a cap, a symlink or submodule, a truncated tree, paths
  // differing only in case, a name other than the expected one, or a blob that does not match its tree.
  "invalid_skill",
]);
export type ErrorCode = v.InferOutput<typeof ErrorCode>;

// The body of every error response. detail is human text: never a token, a request body or a stack.
export const ErrorResponse = v.object({ error: ErrorCode, detail: v.optional(v.string()) });
export type ErrorResponse = v.InferOutput<typeof ErrorResponse>;
