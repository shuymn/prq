import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  findCut,
  keptPart,
  nextBatch,
  partsChars,
  projectionSteps,
  readFiles,
  serializeSteps,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  type SummaryKind,
  TURN_PREFIX_SUMMARIZATION_PROMPT,
  TURN_PREFIX_UPDATE_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
} from "./pr-session/compaction.ts";
import { contextBudget } from "./pr-session/context-budget.ts";
import { ContextRoom } from "./pr-session/room.ts";
import { NO_ROOM, TWO_TIPS, workspaceTools } from "./pr-session/tools.ts";
import type { WorkspaceTarget } from "./pr-session/workspace.ts";
import { question } from "./test/chat.ts";
import { cloudAnswer, fourStepAnswer, sized, WINDOW } from "./test/compaction.ts";
import { sha } from "./test/webhook.ts";
import { FakeWorkspace } from "./test/workspace.ts";

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

  it("keeps a split turn's checkpoint while later cuts stay inside the turn, and folds it into the history once one leaves", () => {
    const a1 = fourStepAnswer();
    const first = findCut([Q1, a1], null, keptTail);
    expect(first?.cut).toEqual({ messageId: a1.id, step: 2 });
    expect(first?.turnPrefix.map((step) => [step.message.id, step.step])).toEqual([
      ["q1", 0],
      [a1.id, 0],
      [a1.id, 1],
    ]);

    const grown = [Q1, a1, Q2, answer("q2", 3334)];
    const second = findCut(grown, first?.cut ?? null, keptTail);
    expect(second?.cut).toEqual({ messageId: a1.id, step: 3 });
    expect(second?.toSummarize).toEqual([]);
    expect(second?.turnPrefix.map((step) => [step.message.id, step.step])).toEqual([[a1.id, 2]]);
    expect(second?.turnContinues).toBe(true);

    const third = findCut([...grown, Q3, answer("q3", 6000)], second?.cut ?? null, keptTail);
    expect(third?.cut).toEqual({ messageId: "answer-job-q3", step: 0 });
    expect(third?.toSummarize.map((step) => [step.message.id, step.step])).toEqual([
      [a1.id, 3],
      ["q2", 0],
      ["answer-job-q2", 0],
    ]);
    expect(third?.turnPrefix.map((step) => step.message.id)).toEqual(["q3"]);
    expect(third?.turnContinues).toBe(false);
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

// A settled tool call of a cloud answer's step, with its result or its error.
function toolCallOf(index: number, name: string, path: string, result: { output: string } | { errorText: string }) {
  return {
    type: `tool-${name}` as const,
    toolCallId: `call-${index}`,
    input: { path },
    ...("output" in result
      ? { state: "output-available" as const, output: result.output }
      : { state: "output-error" as const, errorText: result.errorText }),
  };
}

describe("the files read", () => {
  it("lists a path only when its read_file or diff result holds what it read", () => {
    const reads = cloudAnswer("q1", [
      { type: "step-start" },
      toolCallOf(0, "read_file", "src/read.ts", { output: "1\texport const a = 1;" }),
      toolCallOf(1, "read_file", "src/no-room.ts", { output: NO_ROOM }),
      toolCallOf(2, "diff", "src/missing.ts", { output: "error: path not found" }),
      toolCallOf(3, "diff", "src/changed.ts", { output: "@@ -1 +1 @@\n-a\n+b" }),
      toolCallOf(4, "read_file", "src/failed.ts", { errorText: "the tool failed" }),
    ]);

    expect(readFiles(projectionSteps([Q1, reads]), ["docs/earlier.md"])).toEqual([
      "docs/earlier.md",
      "src/changed.ts",
      "src/read.ts",
    ]);
  });

  it("sees past the line a diff of the two tips starts with, so its error is no read", async () => {
    const target: WorkspaceTarget = {
      fullName: "octo/rates",
      installationId: null,
      sha: sha("head"),
      baseSha: sha("base"),
      seq: 1,
    };
    const workspace = new FakeWorkspace({
      base: { "src/old.ts": "a\n", "src/new.ts": "a\n" },
      head: { "src/old.ts": "b\n", "src/new.ts": "b\n" },
      mergeBase: false,
    });
    const prepared = await workspace.prepare(target, new AbortController().signal);
    const { diff } = workspaceTools({ workspace, target, prepared, room: new ContextRoom(1_048_576) });
    const run = async (input: Record<string, unknown>) =>
      String(await diff?.execute?.(input, { toolCallId: "call", messages: [], context: undefined }));
    const failed = await run({ path: "src/old.ts", startLine: 99 });
    const changed = await run({ path: "src/new.ts" });
    expect(failed.split("\n")).toEqual([TWO_TIPS, expect.stringMatching(/^error: startLine 99 is past the end/)]);
    expect(changed.split("\n")[0]).toBe(TWO_TIPS);

    const diffs = cloudAnswer("q1", [
      { type: "step-start" },
      toolCallOf(0, "diff", "src/old.ts", { output: failed }),
      toolCallOf(1, "diff", "src/new.ts", { output: changed }),
    ]);

    expect(readFiles(projectionSteps([Q1, diffs]), [])).toEqual(["src/new.ts"]);
  });
});

// The prompt of a summary request for Q1, a new summary or an update of `previous`, as compaction builds it.
function promptOf(kind: SummaryKind, previous: string | null): string {
  return nextBatch(kind, projectionSteps([Q1]), 0, previous, 1_048_576, 8192)?.request.prompt ?? "";
}

describe("the prompts", () => {
  it("ask for no language", () => {
    const prompts = [
      SUMMARIZATION_SYSTEM_PROMPT,
      SUMMARIZATION_PROMPT,
      UPDATE_SUMMARIZATION_PROMPT,
      TURN_PREFIX_SUMMARIZATION_PROMPT,
      TURN_PREFIX_UPDATE_PROMPT,
    ];
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/language|japanese|english|日本語/i);
    }
    expect(promptOf("notes", null).endsWith(SUMMARIZATION_PROMPT)).toBe(true);
    expect(promptOf("notes", "earlier")).toContain("<previous-summary>\nearlier\n</previous-summary>");
    expect(promptOf("turn-prefix", null).endsWith(TURN_PREFIX_SUMMARIZATION_PROMPT)).toBe(true);
    const update = promptOf("turn-prefix", "the checkpoint");
    expect(update).toContain("<previous-summary>\nthe checkpoint\n</previous-summary>");
    expect(update.endsWith(TURN_PREFIX_UPDATE_PROMPT)).toBe(true);
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
