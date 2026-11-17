import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  findCut,
  keptPart,
  notesRequest,
  partsChars,
  projectionSteps,
  serializeSteps,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  TURN_PREFIX_SUMMARIZATION_PROMPT,
  turnPrefixRequest,
  UPDATE_SUMMARIZATION_PROMPT,
} from "./pr-session/compaction.ts";
import { contextBudget } from "./pr-session/context-budget.ts";
import { question } from "./test/chat.ts";
import { cloudAnswer, sized, WINDOW } from "./test/compaction.ts";

// The cut over built projections, with the kept tail of the test window (6,000 estimated tokens).

const { keptTail } = contextBudget(WINDOW);

function answer(questionId: string, tokens: number): UIMessage {
  return cloudAnswer(questionId, [
    { type: "step-start" },
    { type: "text", text: sized(`answer ${questionId}`, tokens) },
  ]);
}

// A cloud answer in steps: each a tool call with its result of the given size, then the answer's text.
function steppedAnswer(questionId: string, toolTokens: number[], textTokens: number): UIMessage {
  const steps = toolTokens.flatMap((tokens, index): UIMessage["parts"] => [
    { type: "step-start" },
    {
      type: "tool-read_file",
      toolCallId: `call-${index}`,
      state: "output-available",
      input: { path: `src/${index}.ts` },
      output: sized(`file ${index}`, tokens),
    },
  ]);
  return cloudAnswer(questionId, [
    ...steps,
    { type: "step-start" },
    { type: "text", text: sized(`answer ${questionId}`, textTokens) },
  ]);
}

function analysis(headSha: string, toolTokens: number[], textTokens: number): UIMessage {
  const { parts } = steppedAnswer("analysis", toolTokens, textTokens);
  return {
    id: `analysis-job-${headSha}`,
    role: "assistant",
    metadata: { kind: "analysis", jobId: `job-${headSha}`, headSha, by: { kind: "cloud", model: "scripted-model" } },
    parts,
  };
}

// The estimated tokens of the projection kept from a cut.
function keptTokens(projection: UIMessage[], cut: { messageId: string; step: number }): number {
  return Math.ceil(keptPart(projection, cut).reduce((chars, message) => chars + partsChars(message.parts), 0) / 3);
}

const HEAD = "a".repeat(40);
const Q1 = question("q1");
const Q2 = question("q2");
const Q3 = question("q3");

describe("the cut", () => {
  it("keeps at least the kept tail, cutting at a question, and summarizes everything before it", () => {
    const projection = [Q1, answer("q1", 4000), Q2, answer("q2", 2000), Q3, answer("q3", 5996)];
    const cut = findCut(projection, null, keptTail);

    expect(cut?.cut).toEqual({ messageId: "q3", step: 0 });
    expect(cut?.toSummarize.map((step) => step.message.id)).toEqual(["q1", "answer-job-q1", "q2", "answer-job-q2"]);
    expect(cut?.turnPrefix).toEqual([]);
    expect(keptTokens(projection, { messageId: "q3", step: 0 })).toBeGreaterThanOrEqual(keptTail);
  });

  it("cuts inside a turn at a step boundary, never between a tool call and its result, and sets the turn's first steps apart", () => {
    const a2 = steppedAnswer("q2", [3000, 3000], 3000);
    const projection = [Q1, answer("q1", 4000), Q2, a2];
    const cut = findCut(projection, null, keptTail);

    // Steps of Q2's answer, newest first: its text (3,000), the second read (3,000): the tail is reached there.
    expect(cut?.cut).toEqual({ messageId: a2.id, step: 1 });
    expect(cut?.toSummarize.map((step) => step.message.id)).toEqual(["q1", "answer-job-q1"]);
    expect(cut?.turnPrefix.map((step) => [step.message.id, step.step])).toEqual([
      ["q2", 0],
      [a2.id, 0],
    ]);
    const [kept] = keptPart(projection, { messageId: a2.id, step: 1 });
    expect(kept?.parts.map((part) => part.type)).toEqual(["step-start", "tool-read_file", "step-start", "text"]);
    expect(kept?.parts[1]).toMatchObject({ state: "output-available", input: { path: "src/1.ts" } });
    expect(keptTokens(projection, { messageId: a2.id, step: 1 })).toBeGreaterThanOrEqual(keptTail);
  });

  it("takes an analysis's first step as a turn's start, and gives its summary the analysis's task", () => {
    const summary = analysis(HEAD, [3000, 3000], 3000);
    const projection = [Q1, answer("q1", 4000), summary];
    const cut = findCut(projection, null, keptTail);

    expect(cut?.cut).toEqual({ messageId: summary.id, step: 1 });
    expect(cut?.turnPrefix.map((step) => [step.message.id, step.step])).toEqual([[summary.id, 0]]);
    expect(serializeSteps(cut?.turnPrefix ?? [])).toMatch(
      /^\[User\]: Summarize the pull request at head a{40}\.\n\n\[Assistant tool calls\]: read_file\(path="src\/0\.ts"\)\n\n\[Tool result\]: file 0/,
    );
  });

  it("never moves back: a later cut starts from the previous one, and with too little after it there is none", () => {
    const projection = [Q1, answer("q1", 4000), Q2, answer("q2", 2000), Q3, answer("q3", 5996)];
    const previous = { messageId: "q3", step: 0 };

    expect(findCut(projection, previous, keptTail)).toBeNull();

    const grown = [...projection, question("q4"), answer("q4", 6000)];
    const cut = findCut(grown, previous, keptTail);
    expect(cut?.cut).toEqual({ messageId: "answer-job-q4", step: 0 });
    expect(cut?.toSummarize.map((step) => step.message.id)).toEqual(["q3", "answer-job-q3"]);
    expect(cut?.turnPrefix.map((step) => step.message.id)).toEqual(["q4"]);
  });

  it("sums the kept part's characters and rounds once, as the context count does", () => {
    // Rounded per step, the last answer (17,996 characters: 5,999) and its one-character question (1) would reach 6,000
    // and the cut would keep 17,997 characters, 5,999 estimated tokens.
    const projection = [
      { id: "q1", role: "user", parts: [{ type: "text", text: "x".repeat(10) }] },
      cloudAnswer("q1", [{ type: "step-start" }, { type: "text", text: "y".repeat(10) }]),
      { id: "q2", role: "user", parts: [{ type: "text", text: "x" }] },
      cloudAnswer("q2", [{ type: "step-start" }, { type: "text", text: "y".repeat(17_996) }]),
    ] satisfies UIMessage[];
    const cut = findCut(projection, null, keptTail);

    expect(cut?.cut).toEqual({ messageId: "answer-job-q1", step: 0 });
    expect(keptTokens(projection, { messageId: "answer-job-q1", step: 0 })).toBeGreaterThanOrEqual(keptTail);
  });

  it("makes no cut when the whole projection fits in the kept tail", () => {
    expect(findCut([Q1, answer("q1", 3000), Q2, answer("q2", 2990)], null, keptTail)).toBeNull();
  });

  it("serializes steps as text the summarizer does not continue, with each tool result cut at 2,000 characters", () => {
    const steps = projectionSteps([Q1, steppedAnswer("q1", [1000], 10)]);
    const serialized = serializeSteps(steps);

    expect(serialized.split("\n\n").map((line) => line.slice(0, 40))).toEqual([
      "[User]: question q1",
      '[Assistant tool calls]: read_file(path="',
      `[Tool result]: ${sized("file 0", 1000).slice(0, 25)}`,
      "[... 1000 more characters truncated]",
      `[Assistant]: ${sized("answer q1", 10).slice(0, 27)}`,
    ]);
  });
});

describe("the prompts", () => {
  it("ask for no language", () => {
    const prompts = [
      SUMMARIZATION_SYSTEM_PROMPT,
      SUMMARIZATION_PROMPT,
      UPDATE_SUMMARIZATION_PROMPT,
      TURN_PREFIX_SUMMARIZATION_PROMPT,
    ];
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/language|japanese|english|日本語/i);
    }
    expect(notesRequest(projectionSteps([Q1]), null).prompt.endsWith(SUMMARIZATION_PROMPT)).toBe(true);
    expect(notesRequest(projectionSteps([Q1]), "earlier").prompt).toContain(
      "<previous-summary>\nearlier\n</previous-summary>",
    );
    expect(turnPrefixRequest(projectionSteps([Q1])).prompt.endsWith(TURN_PREFIX_SUMMARIZATION_PROMPT)).toBe(true);
  });

  it("name the six sections, the decisions in the user's own words and only the preferences the user stated", () => {
    for (const prompt of [SUMMARIZATION_PROMPT, UPDATE_SUMMARIZATION_PROMPT]) {
      expect(prompt.match(/^## .+$/gm)).toEqual([
        "## Purpose",
        "## Overview of the change",
        "## Decisions",
        "## The user's interests and preferences",
        "## Open questions",
        "## Key facts",
      ]);
      expect(prompt).toContain("in the user's own words");
      expect(prompt).toContain("Only what the user said");
    }
  });
});
