import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, type LanguageModelMiddleware, RetryError, StreamProviderError, wrapLanguageModel } from "ai";
import * as v from "valibot";

import type { ModelConfig } from "../config.ts";
import type { CloudModel } from "./turn.ts";

// The cloud agent's model: an OpenAI-compatible provider behind prq's response bound, and how its errors become a
// job's failure reason (docs/design.md, Billing limits).

// How long a model request waits for its response (the headers) once sent. The AI SDK's own bounds start only at the
// response, so a provider that never answers is ended here.
export const RESPONSE_BOUND_MS = 120_000;
// How long a model stream may go without output, before its first chunk and between chunks (the AI SDK's `timeout`).
export const OUTPUT_STALL_MS = 120_000;

// The AI SDK's stream bounds for every streamText call on the cloud model.
export const STREAM_TIMEOUT = { firstChunkMs: OUTPUT_STALL_MS, chunkMs: OUTPUT_STALL_MS };

export const NO_RESPONSE = `the provider sent no response for ${RESPONSE_BOUND_MS / 1000} s`;
export const OUTPUT_STALLED = `the provider stopped sending output for ${OUTPUT_STALL_MS / 1000} s`;

// A request whose response did not arrive within the bound. Not an APICallError, so the AI SDK does not retry it.
class ProviderNoResponseError extends Error {
  override name = "ProviderNoResponseError";

  constructor() {
    super(NO_RESPONSE);
  }
}

// Bounds the wait for each request's response. The middleware makes the request itself, with a signal that also aborts
// at the bound (the doStream it is handed takes no arguments, so it cannot carry one); once the response has arrived
// the timer is cleared and the AI SDK's output bounds take over. At the bound, or at the caller's abort, it rejects at
// once, whether or not the request honours the abort; every ending clears the timer and the abort listener.
const responseBound: LanguageModelMiddleware = {
  wrapStream: async ({ params, model }) => {
    params.abortSignal?.throwIfAborted();
    const bound = new AbortController();
    const abortSignal =
      params.abortSignal === undefined ? bound.signal : AbortSignal.any([params.abortSignal, bound.signal]);
    const listening = new AbortController();
    const aborted = new Promise<never>((_, reject) => {
      abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true, signal: listening.signal });
    });
    const timer = setTimeout(() => bound.abort(new ProviderNoResponseError()), RESPONSE_BOUND_MS);
    const request = Promise.resolve(model.doStream({ ...params, abortSignal }));
    try {
      return await Promise.race([request, aborted]);
    } finally {
      clearTimeout(timer);
      listening.abort();
      // A request left at an abort rejects when the abort lands, or never; nothing waits for it.
      request.catch(() => undefined);
    }
  },
};

// The cloud model of a configuration. Every request a turn makes, each step and each AI SDK retry, passes the bound.
export function createModel(config: ModelConfig): CloudModel {
  const provider = createOpenAICompatible({
    name: "model",
    baseURL: config.MODEL_BASE_URL,
    apiKey: config.MODEL_API_KEY,
    // Usage in the stream's last chunk, which the usage log needs.
    includeUsage: true,
  });
  return wrapLanguageModel({ model: provider.chatModel(config.MODEL_ID), middleware: responseBound });
}

const models = new WeakMap<object, CloudModel>();

// One model per env object, so once per isolate in production.
export function modelFor(env: object, config: ModelConfig): CloudModel {
  let model = models.get(env);
  if (model === undefined) {
    model = createModel(config);
    models.set(env, model);
  }
  return model;
}

// The longest failure reason kept: the job's failure and an incomplete message's reason.
const MAX_REASON_CHARS = 500;

// Text with every occurrence of the API key replaced.
export function redact(text: string, secret?: string): string {
  return secret === undefined || secret === "" ? text : text.replaceAll(secret, "[redacted]");
}

// A failure reason as stored and shown: the API key replaced first, then cut, so a cut never leaves a fragment of the
// key the replacement would miss.
export function reasonText(text: string, secret?: string): string {
  const redacted = redact(text, secret);
  return redacted.length > MAX_REASON_CHARS ? redacted.slice(0, MAX_REASON_CHARS) : redacted;
}

export type ModelFailure = {
  reason: string;
  // The provider refused the request for the context's length (compaction re-runs it once, from PR 6).
  contextLength: boolean;
};

const CONTEXT_LENGTH_CODE = "context_length_exceeded";
const CONTEXT_LENGTH_MESSAGE = /context[ _-]?(length|window)/i;

// An API error's body as the adapter parsed it: the provider's own message and code.
const ErrorBody = v.object({ error: v.object({ message: v.string(), code: v.nullish(v.unknown()) }) });

function bodyError(error: APICallError): { message?: string; code?: unknown } {
  const parsed = v.safeParse(ErrorBody, error.data);
  return parsed.success ? parsed.output.error : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyCause(cause: unknown): ModelFailure {
  if (cause instanceof ProviderNoResponseError) {
    return { reason: cause.message, contextLength: false };
  }
  if (APICallError.isInstance(cause)) {
    const body = bodyError(cause);
    const message = body.message ?? (cause.responseBody || cause.message);
    const reason =
      cause.statusCode === undefined
        ? `provider request failed: ${message}`
        : `provider refused the request (HTTP ${cause.statusCode}): ${message}`;
    return {
      reason,
      contextLength: body.code === CONTEXT_LENGTH_CODE || CONTEXT_LENGTH_MESSAGE.test(body.message ?? cause.message),
    };
  }
  if (StreamProviderError.isInstance(cause)) {
    const label = cause.code ?? cause.type;
    return {
      reason: `provider error during the answer${label === undefined ? "" : ` (${label})`}: ${cause.message}`,
      contextLength: cause.code === CONTEXT_LENGTH_CODE || CONTEXT_LENGTH_MESSAGE.test(cause.message),
    };
  }
  return { reason: errorMessage(cause), contextLength: false };
}

// Every error a turn sees, as the reason its job fails with. The AI SDK's RetryError is unwrapped first: after a retry
// it carries the error that ended the call as its last.
export function classifyModelError(error: unknown, secret?: string): ModelFailure {
  const retried = RetryError.isInstance(error);
  const failure = classifyCause(retried ? error.lastError : error);
  const reason = retried ? `${failure.reason} (after ${error.errors.length} attempts)` : failure.reason;
  return { reason: reasonText(reason, secret), contextLength: failure.contextLength };
}
