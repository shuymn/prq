// Long conversations for the compaction tests: text of a given estimated size, the summary calls a scripted model gets,
// and the notes and the context count as the session stores them.

import type { AIChatAgent } from "@cloudflare/ai-chat";
import type { MessageMetadata } from "@prq/protocol";
import type { UIMessage } from "ai";
import { runInDurableObject } from "cloudflare:test";

import { SUMMARIZATION_SYSTEM_PROMPT } from "../pr-session/compaction.ts";
import type { PrSession } from "../pr-session/index.ts";
import { CHARS_PER_TOKEN } from "../pr-session/room.ts";
import type { CallOptions } from "./model.ts";

// The window the compaction tests run at (docs/design.md, Model context): reserve 2,500, kept tail 6,000, notes output
// 4,000, so the context is compacted above 17,500 tokens.
export const WINDOW = 20_000;

// Text of the label, padded to the characters of `tokens` estimated tokens.
export function sized(label: string, tokens: number): string {
  return label.padEnd(tokens * CHARS_PER_TOKEN, ".");
}

export function isSummaryCall(call: CallOptions): boolean {
  return call.prompt[0]?.role === "system" && call.prompt[0].content === SUMMARIZATION_SYSTEM_PROMPT;
}

// The prompt a summary call was given (its one user message).
export function summaryPrompt(call: CallOptions): string {
  const message = call.prompt[1];
  if (message?.role !== "user") {
    throw new Error("a summary call holds one user message");
  }
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

export type NotesRow = {
  text: string | null;
  history: string | null;
  turn_context: string | null;
  rev: number;
  cut_message_id: string | null;
  cut_step: number | null;
  read_files: string;
};

export async function notesRow(stub: DurableObjectStub<PrSession>): Promise<NotesRow> {
  return runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<NotesRow>(
        "SELECT text, history, turn_context, rev, cut_message_id, cut_step, read_files FROM prq_notes WHERE id = 1",
      )
      .one(),
  );
}

export type ContextRow = {
  context_tokens: number | null;
  context_through: string | null;
  context_notes_rev: number | null;
  compaction_failed_through: string | null;
};

export async function contextRow(stub: DurableObjectStub<PrSession>): Promise<ContextRow> {
  return runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<ContextRow>(
        `SELECT context_tokens, context_through, context_notes_rev, compaction_failed_through FROM prq_session
         WHERE id = 1`,
      )
      .one(),
  );
}

// A cloud answer as a commit stores it.
export function cloudAnswer(questionId: string, parts: UIMessage["parts"]): UIMessage {
  const metadata: MessageMetadata = {
    kind: "answer",
    jobId: `job-${questionId}`,
    questionId,
    sha: null,
    by: { kind: "cloud", model: "scripted-model" },
  };
  return { id: `answer-job-${questionId}`, role: "assistant", metadata, parts };
}

// A read of 9,000 characters (3,000 estimated tokens), settled.
function fileRead(index: number) {
  return {
    type: "tool-read_file" as const,
    toolCallId: `call-${index}`,
    state: "output-available" as const,
    input: { path: `src/${index}.ts` },
    output: "x".repeat(9000),
  };
}

// A cloud answer to Q1 in four steps: a read, a read, two reads in one step, then its text of 9,000 characters. The
// kept tail of the test window reaches into it at its third step.
export function fourStepAnswer(): UIMessage {
  return cloudAnswer("q1", [
    { type: "step-start" },
    fileRead(0),
    { type: "step-start" },
    fileRead(1),
    { type: "step-start" },
    fileRead(2),
    fileRead(3),
    { type: "step-start" },
    { type: "text", text: "y".repeat(9000) },
  ]);
}

// Messages stored as they are, without intake or jobs: a conversation the commits made earlier.
export async function seedHistory(stub: DurableObjectStub<PrSession>, messages: UIMessage[]): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    const base: AIChatAgent<Env> = Object.getPrototypeOf(Object.getPrototypeOf(instance));
    await base.persistMessages.call(instance, [...instance.messages, ...messages]);
  });
}
