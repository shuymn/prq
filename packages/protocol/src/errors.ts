import * as v from "valibot";

// What went wrong, one code per HTTP status: 400 bad_request, 401 unauthorized, 404 not_found, 500 internal, 503
// unavailable. 503 means the server could not check the caller (Access's keys could not be fetched) and is never an
// authentication failure.
export const ErrorCode = v.picklist(["unauthorized", "bad_request", "not_found", "internal", "unavailable"]);
export type ErrorCode = v.InferOutput<typeof ErrorCode>;

// The body of every error response. detail is human text: never a token, a request body or a stack.
export const ErrorResponse = v.object({ error: ErrorCode, detail: v.optional(v.string()) });
export type ErrorResponse = v.InferOutput<typeof ErrorResponse>;
