// Context compaction for a PR Q&A conversation (check 3 prototype).
//
// Algorithm (token accounting, shouldCompact, cut point, split turn, iterative summary update,
// file tracking, summary injection) and the summarization prompts are adapted from Pi
// (@earendil-works/pi-coding-agent v1.5.2: dist/core/compaction/compaction.js,
// dist/core/compaction/utils.js, dist/core/messages.js).
// Pi is Copyright (c) Mario Zechner, licensed under the MIT License
// (https://github.com/earendil-works/pi). The summary sections are changed for the PR domain.
//
// History model: `history` is an append-only array of entries { id, msg: ModelMessage, usage?, gen }.
// It is the display history and is never modified here. Compaction state is kept separately:
// { summary, firstKept, gen, readFiles, historyLenAtCompaction }. The model context is
// [summary message] + history.slice(firstKept).

import { generateText } from "ai";

// ---------------------------------------------------------------------------
// Token estimation (Pi: estimateTokens, chars / 4)
// ---------------------------------------------------------------------------

function contentChars(content) {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const part of content) {
    if (part.type === "text") chars += part.text.length;
    else if (part.type === "reasoning") chars += part.text.length;
    else if (part.type === "tool-call") chars += part.toolName.length + JSON.stringify(part.input ?? {}).length;
    else if (part.type === "tool-result") chars += toolOutputText(part.output).length;
  }
  return chars;
}

export function toolOutputText(output) {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (output.type === "text" || output.type === "error-text") return String(output.value);
  if (output.type === "json" || output.type === "error-json") return JSON.stringify(output.value);
  return JSON.stringify(output);
}

export function estimateTokens(msg) {
  return Math.ceil(contentChars(msg.content) / 4);
}

export function estimateText(text) {
  return Math.ceil(text.length / 4);
}

// Pi: calculateContextTokens — provider total for the last request (input + output).
function usageTokens(usage) {
  return usage.totalTokens || (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

// ---------------------------------------------------------------------------
// Context assembly and token accounting
// ---------------------------------------------------------------------------

// Pi: COMPACTION_SUMMARY_PREFIX / SUFFIX (messages.js)
export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

export function summaryMessage(summary) {
  return { role: "user", content: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}` };
}

export function initialState() {
  return { summary: undefined, firstKept: 0, gen: 0, readFiles: [], historyLenAtCompaction: 0 };
}

export function buildContext(history, state) {
  const kept = history.slice(state.firstKept).map((e) => e.msg);
  return state.summary ? [summaryMessage(state.summary), ...kept] : kept;
}

// Pi: estimateContextTokens + estimateProjectedContextTokens. Use the last provider usage when it was
// measured on the current projection (after the latest compaction), plus chars/4 for later messages.
// Otherwise estimate the whole projection (system prompt included).
export function contextTokens(history, state, systemText) {
  for (let i = history.length - 1; i >= state.firstKept; i--) {
    const e = history[i];
    if (e.usage && usageTokens(e.usage) > 0) {
      if (e.gen !== state.gen) break; // usage measured before a later compaction: not trusted
      let trailing = 0;
      for (let j = i + 1; j < history.length; j++) trailing += estimateTokens(history[j].msg);
      return { tokens: usageTokens(e.usage) + trailing, usageBased: true };
    }
  }
  let tokens = estimateText(systemText);
  for (const m of buildContext(history, state)) tokens += estimateTokens(m);
  return { tokens, usageBased: false };
}

// Pi: shouldCompact
export function shouldCompact(tokens, settings) {
  return tokens > settings.contextWindow - settings.reserveTokens;
}

// ---------------------------------------------------------------------------
// Cut point (Pi: findCutPoint / findProjectedCutPoint)
// ---------------------------------------------------------------------------

const isCutPoint = (msg) => msg.role === "user" || msg.role === "assistant"; // never a tool result
const isTurnStart = (msg) => msg.role === "user";

export function findCutPoint(history, start, end, keepRecentTokens) {
  const cutPoints = [];
  for (let i = start; i < end; i++) if (isCutPoint(history[i].msg)) cutPoints.push(i);
  if (cutPoints.length === 0) return { firstKept: start, turnStart: -1, isSplitTurn: false };
  let acc = 0;
  let cut = cutPoints[0];
  for (let i = end - 1; i >= start; i--) {
    acc += estimateTokens(history[i].msg);
    if (acc >= keepRecentTokens) {
      cut = cutPoints.find((c) => c >= i) ?? cutPoints[cutPoints.length - 1];
      break;
    }
  }
  const startsTurn = isTurnStart(history[cut].msg);
  let turnStart = -1;
  if (!startsTurn) {
    for (let i = cut; i >= start; i--) if (isTurnStart(history[i].msg)) { turnStart = i; break; }
  }
  return { firstKept: cut, turnStart, isSplitTurn: !startsTurn && turnStart !== -1 };
}

// ---------------------------------------------------------------------------
// Serialization and file tracking (Pi: utils.js)
// ---------------------------------------------------------------------------

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[... ${text.length - max} more characters truncated]`;
}

// Pi: serializeConversation. Reasoning is omitted; tool results are truncated.
export function serializeConversation(msgs) {
  const parts = [];
  for (const m of msgs) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join("");
      if (text) parts.push(`[User]: ${text}`);
    } else if (m.role === "assistant") {
      const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      const text = content.filter((p) => p.type === "text").map((p) => p.text).join("");
      const calls = content
        .filter((p) => p.type === "tool-call")
        .map((p) => `${p.toolName}(${Object.entries(p.input ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})`);
      if (text) parts.push(`[Assistant]: ${text}`);
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    } else if (m.role === "tool") {
      for (const p of m.content) {
        if (p.type !== "tool-result") continue;
        const text = toolOutputText(p.output);
        if (text) parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
      }
    }
  }
  return parts.join("\n\n");
}

// Pi: extractFileOpsFromMessage. Here the only "read" tool is read_file (a file's diff).
function collectReadFiles(msgs, into) {
  for (const m of msgs) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const p of m.content) {
      if (p.type === "tool-call" && p.toolName === "read_file" && typeof p.input?.path === "string") into.add(p.input.path);
    }
  }
}

function formatReadFiles(files) {
  return files.length ? `\n\n<read-files>\n${files.join("\n")}\n</read-files>` : "";
}

// ---------------------------------------------------------------------------
// Prompts (adapted from Pi; sections replaced for PR review)
// ---------------------------------------------------------------------------

// Pi: SUMMARIZATION_SYSTEM_PROMPT
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant that reviews a pull request, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const FORMAT = `## 目的
[What the user is trying to accomplish with this PR review. Can be multiple items.]

## 変更の全体像
- [The PR's changes as understood so far, grouped by area, with exact file paths]

## 決まったこと
- **[Decision, in the user's own words where possible]**: [Brief rationale]
- [Include scope decisions, naming conventions, accepted risks, schedule/dates. If a later message changed a decision, keep only the current one and note what it replaced.]

## 利用者の関心と好み
- [Answer format and style requested by the user, areas the user cares about, things to avoid]

## 未解決の問い
- [Open questions, or "(none)"]

## 重要な事実
- [Code facts found with tools: exact file paths, function/class/option names, signatures, conditions, error class names]`;

// Pi: SUMMARIZATION_PROMPT
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the PR review conversation.

Use this EXACT format:

${FORMAT}

Write the summary in the user's language (Japanese). Keep each section concise. Preserve exact file paths, function names, option names, error class names, numbers and dates. Every explicit decision or preference stated by the user must appear.`;

// Pi: UPDATE_SUMMARIZATION_INSTRUCTIONS / UPDATE_SUMMARIZATION_PROMPT
const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary, especially every item in 決まったこと, 利用者の関心と好み and 重要な事実
- ADD new decisions, preferences, facts and context from the new messages
- UPDATE a decision when the new messages change it (keep the current one, note what it replaced)
- UPDATE 未解決の問い: remove questions that were answered
- PRESERVE exact file paths, function names, option names, error class names, numbers and dates
- If something is no longer relevant, you may remove it

Use this EXACT format:

${FORMAT}

Write the summary in the user's language (Japanese). Keep each section concise.`;

// Pi: TURN_PREFIX_SUMMARIZATION_PROMPT
const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for? Keep any decision or preference the user stated, verbatim.]

## Progress So Far
- [Files read and facts found in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages. Write in Japanese.`;

// ---------------------------------------------------------------------------
// Summarization calls
// ---------------------------------------------------------------------------

async function summarize(model, promptText, maxOutputTokens, onUsage) {
  const t0 = Date.now();
  const res = await generateText({ model, system: SUMMARIZATION_SYSTEM_PROMPT, prompt: promptText, maxOutputTokens });
  onUsage?.(res.totalUsage ?? res.usage);
  // Pi: getSummarizationFailure — a length stop is a partial summary and must not be persisted.
  if (res.finishReason === "length") throw new Error("Summarization hit the output cap; summary is incomplete");
  if (res.finishReason === "error") throw new Error("Summarization failed");
  if (!res.text.trim()) throw new Error("Summarization returned empty text");
  return { text: res.text.trim(), usage: res.totalUsage ?? res.usage, ms: Date.now() - t0 };
}

// Pi: prepareCompaction
export function prepareCompaction(history, state, settings, systemText) {
  const boundaryStart = state.firstKept;
  const cut = findCutPoint(history, boundaryStart, history.length, settings.keepRecentTokens);
  if (cut.firstKept <= boundaryStart && !cut.isSplitTurn) return undefined;
  const historyEnd = cut.isSplitTurn ? cut.turnStart : cut.firstKept;
  const toSummarize = history.slice(boundaryStart, historyEnd).map((e) => e.msg);
  const turnPrefix = cut.isSplitTurn ? history.slice(cut.turnStart, cut.firstKept).map((e) => e.msg) : [];
  if (toSummarize.length === 0 && turnPrefix.length === 0) return undefined;
  const files = new Set(state.readFiles);
  collectReadFiles(toSummarize, files);
  collectReadFiles(turnPrefix, files);
  return {
    ...cut,
    boundaryStart,
    toSummarize,
    turnPrefix,
    previousSummary: state.summary,
    readFiles: [...files].sort(),
    tokensBefore: contextTokens(history, state, systemText).tokens,
  };
}

// Pi: compact. Returns the new state; never mutates history or the old state.
export async function compact(model, history, state, prep, { maxOutputTokens = 8192, onUsage } = {}) {
  const calls = [];
  let summary;
  let historyText = prep.previousSummary ?? "No prior history.";
  if (prep.toSummarize.length > 0) {
    let prompt = `<conversation>\n${serializeConversation(prep.toSummarize)}\n</conversation>\n\n`;
    if (prep.previousSummary) prompt += `<previous-summary>\n${prep.previousSummary}\n</previous-summary>\n\n`;
    prompt += prep.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
    const r = await summarize(model, prompt, maxOutputTokens, onUsage);
    calls.push({ kind: prep.previousSummary ? "update" : "initial", ms: r.ms, usage: r.usage });
    historyText = r.text;
  }
  if (prep.isSplitTurn && prep.turnPrefix.length > 0) {
    const prompt = `# Conversation\n${serializeConversation(prep.turnPrefix)}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
    const r = await summarize(model, prompt, maxOutputTokens, onUsage);
    calls.push({ kind: "turn-prefix", ms: r.ms, usage: r.usage });
    summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${r.text}`;
  } else {
    summary = historyText;
  }
  // The read-files list is re-derived each time (Pi keeps it in details), so strip any old list first.
  summary = summary.replace(/\n*<read-files>[\s\S]*?<\/read-files>\s*/g, "\n").trimEnd() + formatReadFiles(prep.readFiles);
  return {
    state: {
      summary,
      firstKept: prep.firstKept,
      gen: state.gen + 1,
      readFiles: prep.readFiles,
      historyLenAtCompaction: history.length,
    },
    calls,
  };
}
