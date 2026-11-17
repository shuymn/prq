import { MessageMetadata } from "@prq/protocol";
import { type FinishReason, isToolUIPart, type LanguageModel, type LanguageModelUsage, type UIMessage } from "ai";
import * as v from "valibot";

import type { JobRow, JobUsage } from "./jobs.ts";
import { reasonText } from "./model.ts";
import type { WorkspaceClient } from "./workspace.ts";

// A cloud turn: what it is bound to, and how it ended as its callbacks recorded it in memory. prq commits it when the
// SDK's turn has ended (docs/design.md, Owner and jobs).

// The model a cloud turn runs on, as an object: its ID goes into each result's author.
export type CloudModel = Exclude<LanguageModel, string>;

// The binding of an SDK chat turn to a running job, made inside the turn's exclusive slot; with the workspace the turn
// called, under its turn's sequence number, once it called one.
export type Binding = {
  jobId: string;
  turnId: string;
  model: CloudModel;
  outcome: TurnOutcome;
  workspace?: { client: WorkspaceClient; seq: number };
  // The notes revision the turn's context was built on, once it was built.
  notesRev?: number;
};

export type TurnOutcome = {
  // Whether onChatMessage took the binding; a turn that never reached it ended without an outcome.
  reached: boolean;
  // A failure before any model call (the workspace, the question), or of prq's own code.
  failure?: string;
  // The response message as it was streamed, when the stream ended.
  message?: UIMessage;
  // The final step's finish reason, unified and as the provider sent it.
  finishReason?: FinishReason;
  rawFinishReason?: string | undefined;
  aborted: boolean;
  // The first error the turn saw, and whether it was the provider's refusal of the context's length.
  error?: string;
  contextLength: boolean;
  // The tokens of the turn's latest model call (input and output), when the provider reported them.
  contextTokens?: number | undefined;
};

export function newOutcome(): TurnOutcome {
  return { reached: false, aborted: false, contextLength: false };
}

// The reason a turn that stopped normally fails when its result holds no answer text (reasoning only, or nothing): as
// done it would leave the author nothing, and a done job cannot be retried.
export const NO_ANSWER_TEXT = "the model returned no answer text";

// Why a turn that reached the model failed, or null when it ended normally. Only a final `stop` with answer text
// commits a result: a cut-short answer (the output limit, the content filter) or any other ending is not stored as done.
// A finish reason the provider sent is reason text like any other: the API key (`secret`) is replaced before the cut.
export function turnFailure(outcome: TurnOutcome, secret?: string): string | null {
  if (outcome.failure !== undefined) {
    return outcome.failure;
  }
  if (outcome.error !== undefined) {
    return outcome.error;
  }
  if (outcome.aborted) {
    return "the turn was cancelled";
  }
  switch (outcome.finishReason) {
    case "stop":
      return outcome.message !== undefined && hasText(outcome.message.parts) ? null : NO_ANSWER_TEXT;
    case "length":
      return "the model stopped at its output limit";
    case "content-filter":
      return "the provider's content filter stopped the answer";
    default:
      return reasonText(
        `the model stopped with finish reason ${outcome.rawFinishReason ?? outcome.finishReason}`,
        secret,
      );
  }
}

// A turn's streamed response whose failure carries `reason(error)` in place of the error's own message. A stream that
// fails midway (the provider's response body, a model's stream) ends the SDK's reply, which sends the error's message
// to the client in its terminal frame; the reason is the job's, classified and with the key redacted. The original
// error stays as its cause, where the SDK looks to tell a platform interruption from a failure.
export function failingWith(response: Response, reason: (error: unknown) => string): Response {
  const source = response.body?.getReader();
  if (source === undefined) {
    return response;
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Only a failed read is the stream's failure: a client's cancel cancels this stream first, and what fails after
      // that (a close or enqueue on the cancelled stream) is no turn's failure.
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await source.read();
      } catch (error) {
        controller.error(new Error(reason(error), { cause: error }));
        return;
      }
      if (read.done) {
        controller.close();
      } else {
        controller.enqueue(read.value);
      }
    },
    cancel: (why) => source.cancel(why),
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

// The parts of a cloud result as stored: no reasoning (it leaves the context when the turn ends), of tool parts only
// those with a settled result, and text as final (a cut turn's last text was still streaming).
export function resultParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  return parts
    .filter(
      (part) =>
        part.type !== "reasoning" &&
        part.type !== "reasoning-file" &&
        (!isToolUIPart(part) ||
          part.state === "output-available" ||
          part.state === "output-error" ||
          part.state === "output-denied"),
    )
    .map((part) => (part.type === "text" && part.state === "streaming" ? { ...part, state: "done" } : part));
}

// Whether parts hold text that is not blank: an answer worth committing, or text worth keeping as incomplete.
export function hasText(parts: UIMessage["parts"]): boolean {
  return parts.some((part) => part.type === "text" && part.text.trim().length > 0);
}

// The reason stored with a run's incomplete text.
export function storedFailure(metadata: unknown): string {
  const parsed = v.safeParse(MessageMetadata, metadata);
  return (parsed.success ? parsed.output.incomplete?.reason : undefined) ?? "the turn failed";
}

// The message a failed run's text is kept as. Its own ID per run leaves <kind>-<jobId> for a later success.
export function incompleteMessageId(row: Pick<JobRow, "kind" | "job_id" | "run">): string {
  return `${row.kind}-${row.job_id}-r${row.run}-incomplete`;
}

// One model call's tokens as the usage log counts them. Cached input tokens are the adapter's (from
// prompt_tokens_details); a provider that reports them only as prompt_cache_hit_tokens is read from its raw usage.
export function stepTokens(usage: LanguageModelUsage): { input: number; output: number; cachedInput: number } {
  const cacheRead = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheHit = usage.raw?.["prompt_cache_hit_tokens"];
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cachedInput: cacheRead === 0 && typeof cacheHit === "number" ? cacheHit : cacheRead,
  };
}

// A run's usage as a result's metadata carries it.
export function usageMetadata(usage: JobUsage) {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cached_input_tokens,
  };
}
