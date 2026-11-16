import * as v from "valibot";

// What went wrong. Statuses: 400 bad_request, 401 unauthorized, 404 not_found and unknown_job, 409 stale_claim,
// target_mismatch and not_retryable, 500 internal, 503 unavailable. 503 means the server could not complete the request
// now: Access's keys could not be fetched, or a Durable Object did not answer in time. The caller tries again; it is
// never an authentication failure.
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
]);
export type ErrorCode = v.InferOutput<typeof ErrorCode>;

// The body of every error response. detail is human text: never a token, a request body or a stack.
export const ErrorResponse = v.object({ error: ErrorCode, detail: v.optional(v.string()) });
export type ErrorResponse = v.InferOutput<typeof ErrorResponse>;
