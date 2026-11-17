import { APICallError, RetryError, StreamProviderError } from "ai";
import { describe, expect, it } from "vitest";

import { classifyModelError } from "./pr-session/model.ts";

// How an error a turn sees becomes its job's failure reason, and which errors are context-length refusals (which
// compaction re-runs from PR 6; until then they fail the job with the provider's reason like any refusal).

function refusal(status: number, error: Record<string, unknown>): APICallError {
  const body = { error };
  return new APICallError({
    message: typeof error["message"] === "string" ? error["message"] : "refused",
    url: "https://provider.example/v1/chat/completions",
    requestBodyValues: {},
    statusCode: status,
    responseBody: JSON.stringify(body),
    data: body,
    isRetryable: status === 429 || status >= 500,
  });
}

describe("classifyModelError", () => {
  it.for([
    ["an HTTP refusal by its code", refusal(400, { message: "too long", code: "context_length_exceeded" })],
    [
      "an HTTP refusal by its message",
      refusal(400, { message: "This model's maximum context length is 131072 tokens.", type: "invalid_request_error" }),
    ],
    [
      "an error inside the stream by its code",
      new StreamProviderError({ message: "too long", code: "context_length_exceeded" }),
    ],
    [
      "an error inside the stream by its message",
      new StreamProviderError({ message: "the input exceeds the context window", type: "invalid_request" }),
    ],
    [
      "a refusal after a retry",
      new RetryError({
        message: "failed",
        reason: "errorNotRetryable",
        errors: [
          refusal(503, { message: "busy" }),
          refusal(400, { message: "too long", code: "context_length_exceeded" }),
        ],
      }),
    ],
  ] as const)("recognises a context-length refusal in %s", ([, error]) => {
    expect(classifyModelError(error).contextLength).toBe(true);
  });

  it("keeps the provider's reason for a context-length refusal", () => {
    expect(classifyModelError(refusal(400, { message: "too long", code: "context_length_exceeded" }))).toEqual({
      reason: "provider refused the request (HTTP 400): too long",
      contextLength: true,
    });
  });

  it("tells other refusals apart", () => {
    expect(classifyModelError(refusal(402, { message: "Insufficient Balance" }))).toEqual({
      reason: "provider refused the request (HTTP 402): Insufficient Balance",
      contextLength: false,
    });
  });

  it("does not take a refusal that only mentions the context length for a context-length refusal", () => {
    const quota = refusal(402, {
      message: "You exceeded your current quota for this model (context length: 131072). Check your plan.",
      type: "insufficient_quota",
      code: "insufficient_quota",
    });
    expect(classifyModelError(quota).contextLength).toBe(false);
  });

  it("names the last error and the attempts after a retry", () => {
    const error = new RetryError({
      message: "Failed after 3 attempts. Last error: busy",
      reason: "maxRetriesExceeded",
      errors: [refusal(503, { message: "busy" }), refusal(503, { message: "busy" }), refusal(503, { message: "busy" })],
    });
    expect(classifyModelError(error).reason).toBe("provider refused the request (HTTP 503): busy (after 3 attempts)");
  });

  it("names a request that got no status", () => {
    const error = new APICallError({
      message: "Cannot connect to API: connection reset",
      url: "https://provider.example/v1/chat/completions",
      requestBodyValues: {},
      isRetryable: true,
    });
    expect(classifyModelError(error).reason).toBe("provider request failed: Cannot connect to API: connection reset");
  });
});
