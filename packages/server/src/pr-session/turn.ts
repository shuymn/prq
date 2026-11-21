import { MessageMetadata } from "@prq/protocol";
import {
  type FinishReason,
  getToolName,
  isToolUIPart,
  type LanguageModel,
  type LanguageModelUsage,
  type UIMessageChunk,
  type UIMessage,
} from "ai";
import * as v from "valibot";

import type { JobRow, JobUsage } from "./jobs.ts";
import { reasonText } from "./model.ts";
import type { Prefix } from "./prefix.ts";
import { PUBLISH } from "./turn-tools.ts";
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
  // The turn's instruction prefix, once it was read.
  prefix?: Prefix;
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
  // The tokens of the turn's latest model call (input and output), when the provider reported them, and the fingerprint
  // of the prefix its request carried (without the tool definitions once the tools were withdrawn).
  contextTokens?: number | undefined;
  contextFingerprint?: string | null;
};

export function newOutcome(): TurnOutcome {
  return { reached: false, aborted: false, contextLength: false };
}

// The reason a turn fails when it published blank text: as done it would leave the author nothing, and a done job
// cannot be retried.
export const NO_ANSWER_TEXT = "the model returned no answer text";

// The reason a turn fails when the model stopped without calling publish, told to once and stopping again.
export const NO_PUBLISH = "the model did not call publish: it ended its turn twice without delivering an answer";

// What the model is told, once, when it stops without calling publish. It goes to the model only: the turn continues
// with it, and it is neither stored nor shown.
export const PUBLISH_NUDGE =
  "You ended your turn without calling publish, so nothing was delivered. Call publish now with your complete answer.";

// Why a turn that reached the model failed, or null when it ended normally. Only a turn whose publish call ran, with
// text that is not blank, commits a result: one that stopped without it (twice, the nudge between), a cut-short answer
// (the output limit, the content filter) or any other ending is not stored as done. A finish reason the provider sent
// is reason text like any other: the API key (`secret`) is replaced before the cut.
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
  const published = publishedText(outcome.message?.parts ?? []);
  if (published !== null) {
    return published.trim() === "" ? NO_ANSWER_TEXT : null;
  }
  switch (outcome.finishReason) {
    case "stop":
      return NO_PUBLISH;
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

// A turn's UI stream as the client is sent it: without text, which is not the answer (publish's input is, and the
// result stored at the commit holds it as text), and without the nudge, which is the model's alone.
export function withoutText(): TransformStream<UIMessageChunk, UIMessageChunk> {
  return new TransformStream({
    transform(chunk, controller) {
      if (
        chunk.type !== "text-start" &&
        chunk.type !== "text-delta" &&
        chunk.type !== "text-end" &&
        chunk.type !== "steering-message"
      ) {
        controller.enqueue(chunk);
      }
    },
  });
}

type Part = UIMessage["parts"][number];

function isPublishPart(part: Part): boolean {
  return isToolUIPart(part) && getToolName(part) === PUBLISH;
}

const PublishedInput = v.object({ text: v.string() });

// The text the turn's last publish call that ran delivered, or null when none ran.
function publishedText(parts: UIMessage["parts"]): string | null {
  for (const part of parts.toReversed()) {
    if (isToolUIPart(part) && getToolName(part) === PUBLISH && part.state === "output-available") {
      const input: unknown = part.input;
      return v.is(PublishedInput, input) ? input.text : null;
    }
  }
  return null;
}

// The parts of a cloud result as stored: no reasoning (it leaves the context when the turn ends) and no nudge (it was
// the model's alone), of tool parts only those with a settled result, and text as final (a cut turn's last text was
// still streaming). Once publish ran, the turn's own text and the publish call give way to the published text as the
// last part: the answer is that text, which every reader of a result (the UI, a local agent's context, compaction)
// reads as text, and a later turn's model sees its earlier answer as its own text after its tool calls.
export function resultParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  const published = publishedText(parts);
  const kept = parts
    .filter(
      (part) =>
        part.type !== "reasoning" &&
        part.type !== "reasoning-file" &&
        part.type !== "steering-message" &&
        (!isToolUIPart(part) ||
          part.state === "output-available" ||
          part.state === "output-error" ||
          part.state === "output-denied"),
    )
    .map((part) => (part.type === "text" && part.state === "streaming" ? { ...part, state: "done" as const } : part));
  if (published === null) {
    return kept;
  }
  return [
    ...kept.filter((part) => part.type !== "text" && !isPublishPart(part)),
    { type: "text", text: published, state: "done" },
  ];
}

// Whether parts hold text that is not blank: text worth keeping as incomplete.
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
