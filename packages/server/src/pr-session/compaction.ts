// The method (the token count, the cut point, the split turn, the summary updated rather than rewritten, the list of
// files read, the summary's insertion) and the summarization prompts are adapted from Pi (pi-coding-agent 1.5.2:
// dist/core/compaction/compaction.js, dist/core/compaction/utils.js, dist/core/messages.js). The summary's sections are
// changed for pull requests, and the prompts ask for no language.
//
// Copyright (c) Mario Zechner
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
// WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { MessageMetadata } from "@prq/protocol";
import {
  type DynamicToolUIPart,
  getToolName,
  isToolUIPart,
  type LanguageModelUsage,
  streamText,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import * as v from "valibot";

import { STREAM_TIMEOUT } from "./model.ts";
import type { ContextState, Notes } from "./notes.ts";
import { analysisTask } from "./prompt.ts";
import { CHARS_PER_TOKEN } from "./room.ts";
import { NO_ROOM, TWO_TIPS } from "./tools.ts";
import type { CloudModel } from "./turn.ts";

// Context compaction (docs/design.md, Model context): the projection before a cut point is summarized into the notes,
// which the model then reads in its place. The stored history is never changed; the notes are kept apart (prq_notes).

// --- The prompts (Pi's, with the sections for a pull request and no language asked for) ---

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant about a GitHub pull request, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const NOTES_FORMAT = `## Purpose
[What the user wants from this pull request. Can be several items.]

## Overview of the change
- [The pull request's changes as understood so far, grouped by area, with exact file paths]

## Decisions
- **[A decision, in the user's own words]**: [The reason, only if the user gave one]
- [Scope, naming, accepted risks, dates. When a later message changed a decision, keep only the current one and say what it replaced.]

## The user's interests and preferences
- [Only what the user said: the form of answers they asked for, the areas they care about, what to avoid. Add no guesses.]
- [Or "(none)" if the user stated none]

## Open questions
- [Questions not answered yet, or "(none)"]

## Key facts
- [Facts about the code found with the tools: exact file paths, function, class and option names, signatures, conditions, error names]`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the conversation about the pull request.

Use this EXACT format:

${NOTES_FORMAT}

Keep each section concise. Preserve exact file paths, function names, option names, error names, numbers and dates. Every decision or preference the user stated must appear.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary, especially every item under Decisions, The user's interests and preferences, and Key facts
- ADD new decisions, preferences, facts and context from the new messages
- UPDATE a decision when the new messages change it: keep the current one and say what it replaced
- UPDATE Open questions: remove the questions that were answered
- PRESERVE exact file paths, function names, option names, error names, numbers and dates
- If something is no longer relevant, you may remove it

Use this EXACT format:

${NOTES_FORMAT}

Keep each section concise.`;

const TURN_PREFIX_FORMAT = `## Original Request
[What did the user ask for? Keep any decision or preference the user stated, in the user's own words.]

## Progress So Far
- [Files read and facts found in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]`;

export const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

${TURN_PREFIX_FORMAT}

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

// The same turn's checkpoint, updated when a later cut falls further inside that turn (Pi has no such prompt: its
// update prompt, applied to a turn's checkpoint).
export const TURN_PREFIX_UPDATE_PROMPT = `The messages above are more of the same turn's earlier context, to incorporate into the existing checkpoint provided in <previous-summary> tags. Later messages are stored separately and do not need to be reconstructed.

Update the checkpoint with the new messages. RULES:
- PRESERVE everything in the existing checkpoint, especially the user's request and every decision or preference the user stated
- ADD the files read, facts found and context from the new messages
- PRESERVE exact file paths, function names, option names, error names, numbers and dates

Use this EXACT format:

${TURN_PREFIX_FORMAT}

Only summarize information explicitly present above or in the existing checkpoint. Do not infer or recreate later messages.`;

// How the model is told that the notes stand for the conversation before the kept part (Pi's notice).
const NOTES_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const NOTES_SUFFIX = "\n</summary>";

export function notesText(notes: string): string {
  return `${NOTES_PREFIX}${notes}${NOTES_SUFFIX}`;
}

// --- The projection in steps ---

// A message of the projection: a question, or a result (an answer or an analysis) with its metadata.
export type Projected = UIMessage;

// Where a cut falls: a message of the projection and the step within it (0: the whole message).
export type CutPosition = { messageId: string; step: number };

// One step of the projection: a question, or one model call of a result (its text and its settled tool calls, a tool
// call and its result being one part). Every step can start the kept part; a turn starts at a question, or at an
// analysis's first step (an analysis stores no request).
export type Step = {
  message: Projected;
  step: number;
  parts: UIMessage["parts"];
  turnStart: boolean;
};

function analysisHead(message: Projected): string | null {
  const metadata = v.safeParse(MessageMetadata, message.metadata);
  return metadata.success && metadata.output.kind === "analysis" ? metadata.output.headSha : null;
}

// A message's parts by step: a step-start part after the first part begins a new step, so a message without step
// boundaries (a local agent's answer) is one step.
function stepsOf(parts: UIMessage["parts"]): UIMessage["parts"][] {
  const steps: UIMessage["parts"][] = [[]];
  for (const [index, part] of parts.entries()) {
    if (part.type === "step-start" && index > 0) {
      steps.push([]);
    }
    steps.at(-1)?.push(part);
  }
  return steps;
}

export function projectionSteps(projection: readonly Projected[]): Step[] {
  return projection.flatMap((message) =>
    message.role === "user"
      ? [{ message, step: 0, parts: message.parts, turnStart: true }]
      : stepsOf(message.parts).map((parts, step) => ({
          message,
          step,
          parts,
          turnStart: step === 0 && analysisHead(message) !== null,
        })),
  );
}

// --- Counting ---

// A settled tool call's result as text: its output, or its error; empty while it has neither.
function resultText(part: ToolUIPart | DynamicToolUIPart): string {
  if (part.state === "output-available") {
    return typeof part.output === "string" ? part.output : (JSON.stringify(part.output) ?? "");
  }
  return part.state === "output-error" ? part.errorText : "";
}

// The characters of parts as the model reads them: text, and each tool call's name, input and result.
export function partsChars(parts: UIMessage["parts"]): number {
  let chars = 0;
  for (const part of parts) {
    if (part.type === "text") {
      chars += part.text.length;
    } else if (isToolUIPart(part)) {
      chars += getToolName(part).length + (JSON.stringify(part.input) ?? "").length + resultText(part).length;
    }
  }
  return chars;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function messagesChars(messages: readonly Projected[]): number {
  return messages.reduce((chars, message) => chars + partsChars(message.parts), 0);
}

// The context's tokens from a measurement (docs/design.md, Model context: Token count): the last committed turn's last
// model call, plus characters ÷ 3 of the projection after its result and of `ownChars` (the job's own question or task,
// at a turn's start). Null without a measurement taken on the current notes.
export function measuredCount(
  state: Pick<ContextState, "tokens" | "through" | "notesRev">,
  notes: Pick<Notes, "rev">,
  projection: readonly Projected[],
  ownChars = 0,
): number | null {
  const through = state.through === null ? -1 : projection.findIndex((message) => message.id === state.through);
  if (state.tokens === null || state.notesRev !== notes.rev || through < 0) {
    return null;
  }
  return state.tokens + estimateTokens(messagesChars(projection.slice(through + 1)) + ownChars);
}

// The context's tokens as the model would read it now: the measured count, or, without one, the estimate of the notes
// and the projection's kept part.
export function contextCount(
  state: Pick<ContextState, "tokens" | "through" | "notesRev">,
  notes: Pick<Notes, "text" | "rev" | "cut">,
  projection: readonly Projected[],
  ownChars = 0,
): number {
  const measured = measuredCount(state, notes, projection, ownChars);
  if (measured !== null) {
    return measured;
  }
  const notesChars = notes.text === null ? 0 : notesText(notes.text).length;
  return estimateTokens(notesChars + messagesChars(keptPart(projection, notes.cut)) + ownChars);
}

// --- The cut (Pi: findCutPoint, prepareCompaction) ---

export type Cut = {
  // The step the kept part starts at.
  cut: CutPosition;
  // The steps summarized into the notes' history, from the previous cut on.
  toSummarize: Step[];
  // A turn the cut falls inside: its steps before the cut not yet summarized, summarized apart into the turn's
  // checkpoint (empty when the cut is at a turn's start).
  turnPrefix: Step[];
  // Whether the previous cut fell inside the same turn: its checkpoint is then updated with turnPrefix, and the
  // history is left as it was.
  turnContinues: boolean;
};

function stepIndex(steps: readonly Step[], at: CutPosition | null): number {
  if (at === null) {
    return 0;
  }
  const found = steps.findIndex((step) => step.message.id === at.messageId && step.step === at.step);
  return found < 0 ? 0 : found;
}

// The cut over the projection from the previous cut on: going back from the newest step, at least keptTail estimated
// tokens are kept (the characters summed, then rounded once, as the context count is), and the cut falls at the start
// of the step where they are reached (a question, or a step of a result). A cut inside a turn sets the turn's earlier
// steps apart, and while later cuts stay inside that turn, its newly removed steps go to its checkpoint too; they reach
// the history only once a cut leaves the turn. Null when nothing before the cut is left to summarize. The cut never
// moves back: the walk starts at the previous cut, and the projection only grows at its end.
export function findCut(projection: readonly Projected[], previous: CutPosition | null, keptTail: number): Cut | null {
  const steps = projectionSteps(projection);
  const start = stepIndex(steps, previous);
  let cut = start;
  let keptChars = 0;
  for (let index = steps.length - 1; index >= start; index -= 1) {
    const step = steps[index];
    keptChars += step === undefined ? 0 : partsChars(step.parts);
    if (estimateTokens(keptChars) >= keptTail) {
      cut = index;
      break;
    }
  }
  const at = steps[cut];
  if (at === undefined || cut <= start) {
    return null;
  }
  const position = { messageId: at.message.id, step: at.step };
  // The start of the turn the cut falls inside, searched before the previous cut too: a turn the previous cut also
  // fell inside started before it.
  let turnStart = -1;
  if (!at.turnStart) {
    for (let index = cut; index >= 0; index -= 1) {
      if (steps[index]?.turnStart === true) {
        turnStart = index;
        break;
      }
    }
  }
  if (turnStart < 0) {
    return { cut: position, toSummarize: steps.slice(start, cut), turnPrefix: [], turnContinues: false };
  }
  if (turnStart < start) {
    return { cut: position, toSummarize: [], turnPrefix: steps.slice(start, cut), turnContinues: true };
  }
  return {
    cut: position,
    toSummarize: steps.slice(start, turnStart),
    turnPrefix: steps.slice(turnStart, cut),
    turnContinues: false,
  };
}

// The projection from a cut on: the cut's message from its step on (a split turn's kept steps, as a partial assistant
// message), then every later message. The whole projection without a cut, or with a cut it does not hold.
export function keptPart(projection: readonly Projected[], cut: CutPosition | null): Projected[] {
  if (cut === null) {
    return [...projection];
  }
  const index = projection.findIndex((message) => message.id === cut.messageId);
  const message = projection[index];
  if (message === undefined) {
    return [...projection];
  }
  const first = cut.step === 0 ? message : { ...message, parts: stepsOf(message.parts).slice(cut.step).flat() };
  return [first, ...projection.slice(index + 1)];
}

// --- Serialization (Pi: serializeConversation, extractFileOpsFromMessage) ---

// The most characters of one tool result a summary request carries.
const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n\n[... ${text.length - max} more characters truncated]`;
}

// Between the serialized steps of a request.
const STEP_SEPARATOR = "\n\n";

// One step as text the summarizer reads, so it does not continue it as a conversation (empty when it holds neither
// text nor a tool call). An analysis's first step is preceded by its task, which is not stored.
function serializeStep({ message, parts, turnStart }: Step): string {
  const lines: string[] = [];
  const head = turnStart && message.role === "assistant" ? analysisHead(message) : null;
  if (head !== null) {
    lines.push(`[User]: ${analysisTask(head)}`);
  }
  const text = parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  if (text.trim() !== "") {
    lines.push(`[${message.role === "user" ? "User" : "Assistant"}]: ${text}`);
  }
  const tools = parts.filter(isToolUIPart);
  if (tools.length > 0) {
    const calls = tools.map((part) => {
      const input = typeof part.input === "object" && part.input !== null ? Object.entries(part.input) : [];
      return `${getToolName(part)}(${input.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")})`;
    });
    lines.push(`[Assistant tool calls]: ${calls.join("; ")}`);
  }
  for (const part of tools) {
    const result = resultText(part);
    if (result !== "") {
      lines.push(`[Tool result]: ${truncateForSummary(result, TOOL_RESULT_MAX_CHARS)}`);
    }
  }
  return lines.join(STEP_SEPARATOR);
}

export function serializeSteps(steps: readonly Step[]): string {
  return steps
    .map(serializeStep)
    .filter((text) => text !== "")
    .join(STEP_SEPARATOR);
}

// Whether a tool call's result holds what it read: not an error, and not the note that the context had no room for it,
// after the line diff puts first when it compares the two tips.
function readSomething(part: ToolUIPart | DynamicToolUIPart): boolean {
  if (part.state !== "output-available" || typeof part.output !== "string") {
    return false;
  }
  const header = `${TWO_TIPS}\n`;
  const output = part.output.startsWith(header) ? part.output.slice(header.length) : part.output;
  return output !== NO_ROOM && !output.startsWith("error:");
}

// The files the steps read (read_file, and diff of one file, whose result holds what it read), added to the ones read
// before, sorted.
export function readFiles(steps: readonly Step[], before: readonly string[]): string[] {
  const files = new Set(before);
  for (const { parts } of steps) {
    for (const part of parts.filter(isToolUIPart)) {
      const name = getToolName(part);
      const path: unknown =
        typeof part.input === "object" && part.input !== null ? Reflect.get(part.input, "path") : undefined;
      if ((name === "read_file" || name === "diff") && typeof path === "string" && readSomething(part)) {
        files.add(path);
      }
    }
  }
  return [...files].toSorted();
}

// The file list prq puts at the notes' end, on lines of its own: only the last block, so a tag named earlier stays.
const TRAILING_READ_FILES = /(?:^|\n)\s*<read-files>[^<]*<\/read-files>\s*$/;
// A tag prq wraps a summary's input or the notes in, echoed around a whole summary.
const ENCLOSING_WRAPPER = /^<(summary|previous-summary|conversation)>([\s\S]*)<\/\1>$/;

function withoutReadFiles(text: string): string {
  return text.replace(TRAILING_READ_FILES, "").trimEnd();
}

// A summary without what prq generates where prq puts it (the file list at the end, which is made again, and a wrapper
// around the whole reply); a tag the summary names in its body is kept.
function cleanSummary(text: string): string {
  const unwrapped = withoutReadFiles(text.trim()).replace(ENCLOSING_WRAPPER, "$2");
  return withoutReadFiles(unwrapped.trim());
}

// --- The summary requests (Pi: generateSummary, compact) ---

// Why a summary attempt was not adopted.
class SummaryFailure extends Error {
  override name = "SummaryFailure";
}

// The history's summary, or a split turn's checkpoint.
export type SummaryKind = "notes" | "turn-prefix";
export type SummaryRequest = { kind: SummaryKind; prompt: string };

// A request for serialized steps: a new summary, or an update of `previous`.
function summaryRequest(kind: SummaryKind, conversation: string, previous: string | null): SummaryRequest {
  const earlier = previous === null ? "" : `<previous-summary>\n${previous}\n</previous-summary>\n\n`;
  if (kind === "notes") {
    const prompt = previous === null ? SUMMARIZATION_PROMPT : UPDATE_SUMMARIZATION_PROMPT;
    return { kind, prompt: `<conversation>\n${conversation}\n</conversation>\n\n${earlier}${prompt}` };
  }
  const prompt = previous === null ? TURN_PREFIX_SUMMARIZATION_PROMPT : TURN_PREFIX_UPDATE_PROMPT;
  return { kind, prompt: `# Conversation\n${conversation}\n\n${earlier}# Instructions\n${prompt}` };
}

export function notesRequest(toSummarize: readonly Step[], previous: string | null): SummaryRequest {
  return summaryRequest("notes", serializeSteps(toSummarize), previous);
}

// A split turn's first steps, summarized into its checkpoint, or added to the checkpoint `previous` when a later cut
// falls further inside the same turn.
export function turnPrefixRequest(turnPrefix: readonly Step[], previous: string | null = null): SummaryRequest {
  return summaryRequest("turn-prefix", serializeSteps(turnPrefix), previous);
}

// A summary request's tokens as a turn's requests are estimated (characters ÷ 3, its system prompt included), with
// its output allowance.
export function requestTokens(request: SummaryRequest, maxOutputTokens: number): number {
  return estimateTokens(SUMMARIZATION_SYSTEM_PROMPT.length + request.prompt.length) + maxOutputTokens;
}

// The request for the steps from `from` on that fit one summary call: as many as fit, oldest first, so that the request
// with its output allowance is within the window (requestTokens). A step that alone does not fit fails the compaction:
// cutting it would drop its end from both the summary and the kept part. `end` is the index after the last step taken;
// the request is null when those steps hold nothing to summarize.
export function nextBatch(
  kind: SummaryKind,
  steps: readonly Step[],
  from: number,
  previous: string | null,
  window: number,
  maxOutputTokens: number,
): { request: SummaryRequest | null; end: number } {
  const limit = (window - maxOutputTokens) * CHARS_PER_TOKEN - SUMMARIZATION_SYSTEM_PROMPT.length;
  let room = limit - summaryRequest(kind, "", previous).prompt.length;
  const texts: string[] = [];
  let end = from;
  for (; end < steps.length; end += 1) {
    const step = steps[end];
    const text = step === undefined ? "" : serializeStep(step);
    if (text === "") {
      continue;
    }
    const cost = text.length + (texts.length > 0 ? STEP_SEPARATOR.length : 0);
    if (cost <= room) {
      texts.push(text);
      room -= cost;
      continue;
    }
    if (texts.length === 0) {
      throw new SummaryFailure("a step does not fit in one summary request within the window");
    }
    break;
  }
  return { request: texts.length === 0 ? null : summaryRequest(kind, texts.join(STEP_SEPARATOR), previous), end };
}

// The notes from the summaries: the history's, a split turn's checkpoint after it, and the list of files read, made
// again each time.
export function assembleNotes(history: string, turnContext: string | null, files: readonly string[]): string {
  const body = withoutReadFiles(history);
  const summary =
    turnContext === null
      ? body
      : `${body}\n\n---\n\n**Turn Context (split turn):**\n\n${withoutReadFiles(turnContext)}`;
  const list = files.length === 0 ? "" : `\n\n<read-files>\n${files.join("\n")}\n</read-files>`;
  return `${summary}${list}`;
}

// --- One summary call ---

// One summary, streamed and consumed whole, under the turn's output bounds (firstChunkMs, chunkMs) and, through the
// model, the response bound, and with the notes' output limit. A summary that stalled, errored, ended other than
// `stop`, or is empty once what prq generates is removed is a failed attempt, which rejects; each model call's usage is
// reported either way.
export async function summarize(
  model: CloudModel,
  request: SummaryRequest,
  maxOutputTokens: number,
  signal: AbortSignal | undefined,
  onUsage: (usage: LanguageModelUsage) => void,
): Promise<string> {
  let failure: unknown;
  let ended: { text: string; finishReason: string } | undefined;
  const result = streamText({
    model,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    prompt: request.prompt,
    maxOutputTokens,
    timeout: STREAM_TIMEOUT,
    ...(signal === undefined ? {} : { abortSignal: signal }),
    onError: ({ error }) => {
      failure ??= error;
    },
    onAbort: ({ reason }) => {
      failure ??= reason instanceof DOMException && reason.name === "TimeoutError" ? reason : new Error("aborted");
    },
    onStepFinish: ({ usage }) => {
      onUsage(usage);
    },
    onFinish: ({ text, finishReason }) => {
      ended = { text, finishReason };
    },
  });
  await result.consumeStream({
    onError: (error) => {
      failure ??= error;
    },
  });
  if (failure !== undefined) {
    throw failure;
  }
  if (ended === undefined) {
    throw new SummaryFailure("the summary ended without finishing");
  }
  if (ended.finishReason !== "stop") {
    throw new SummaryFailure(`the summary ended with finish reason ${ended.finishReason}`);
  }
  const text = cleanSummary(ended.text);
  if (text === "") {
    throw new SummaryFailure("the summary is empty");
  }
  return text;
}
