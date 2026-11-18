import { describe, expect, it } from "vitest";

import { inLanguage, promptsHeld, proseLetters, startedAfterCompaction } from "./compaction.ts";

// How the compaction check (compaction.ts) decides that the questions asked during a compaction started after it
// ended, from log lines as the Worker's log prints them; which prompts the requests it recorded hold; and the language
// of an answer's prose.

const STARTED =
  "{ event: 'prq.compaction.started', pr: 'acme~widgets~7', jobId: 'job-16', notesRev: 1, cutMessageId: 'answer-9', cutStep: 0, summarizedSteps: 22, turnPrefixSteps: 1 }";
const DONE =
  "{ event: 'prq.compaction.done', pr: 'acme~widgets~7', jobId: 'job-16', notesRev: 1, rev: 2, cutMessageId: 'answer-9', cutStep: 0, calls: 2 }";
const OTHER_DONE =
  "{ event: 'prq.compaction.done', pr: 'acme~widgets~7', jobId: 'job-4', notesRev: 0, rev: 1, cutMessageId: 'analysis-1', cutStep: 4, calls: 1 }";

function jobStarted(jobId: string): string {
  return `{ event: 'prq.job.started', pr: 'acme~widgets~7', jobId: '${jobId}', kind: 'answer', from: 'pending', to: 'running' }`;
}

describe("questions started after the compaction", () => {
  it("holds when the compaction's own end comes before both jobs' starts", () => {
    const lines = ["before", STARTED, DONE, jobStarted("job-q1"), jobStarted("job-q2")];

    expect(startedAfterCompaction(lines, 1, STARTED, ["job-q1", "job-q2"])).toEqual({
      doneAt: 2,
      startedAt: [3, 4],
      after: true,
    });
  });

  it.for([
    ["its end was not logged", [STARTED, jobStarted("job-q1"), jobStarted("job-q2")]],
    ["only another compaction's end was logged", [STARTED, OTHER_DONE, jobStarted("job-q1"), jobStarted("job-q2")]],
    ["a job started before its end", [STARTED, jobStarted("job-q1"), DONE, jobStarted("job-q2")]],
  ] as const)("does not hold when %s", ([, lines]) => {
    expect(startedAfterCompaction(lines, 0, STARTED, ["job-q1", "job-q2"]).after).toBe(false);
  });
});

function block(prompt: string): string {
  return `\n<host-instructions>\n${prompt}\n</host-instructions>\n`;
}

// A recorded request with this system message and one user message.
function request(system: string, user = "") {
  return {
    url: "https://provider.example/v1/chat/completions",
    body: JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  };
}

describe("the prompts each recorded request holds", () => {
  const prompts = { analysis: "Write the summary in Japanese.", answer: 'Answer "briefly".' };
  const analysis = `You work on one GitHub pull request.${block(prompts.analysis)}Your job: summarize the pull request at head 1.`;
  const answer = `You work on one GitHub pull request.${block(prompts.answer)}Your job: answer the last question.`;
  const summary = "You are a context summarization assistant. Your task is to read a conversation.";

  it("holds when each turn holds its own prompt and no request holds the other", () => {
    expect(promptsHeld([request(analysis), request(answer), request(summary, "the conversation")], prompts)).toEqual({
      counts: { analysis: 1, answer: 1, summary: 1, other: 0 },
      wrong: [],
    });
  });

  it("names each request that holds the other prompt, misses its own, or is neither kind", () => {
    const { counts, wrong } = promptsHeld(
      [
        request(analysis, prompts.answer),
        request("You work on one GitHub pull request.\nYour job: answer the last question."),
        request(summary, `notes: ${prompts.analysis}`),
        { url: "https://provider.example/v1/models", body: "" },
      ],
      prompts,
    );
    expect(counts).toEqual({ analysis: 1, answer: 1, summary: 1, other: 1 });
    expect(wrong).toEqual([
      "request 1 (analysis): holds the answer prompt",
      "request 2 (answer): its system message does not hold the answer prompt",
      "request 3 (summary): holds the analysis prompt",
      "request 4: neither a turn nor a summary request",
    ]);
  });
});

describe("an answer's prose", () => {
  it("counts letters outside code, headings, link targets and markup", () => {
    const text = [
      "# Heading words",
      "変更は**設定**を[読む](https://example.com/path)。",
      "```ts",
      "const ignored = 1;",
      "```",
      "- `code` and text",
    ].join("\n");
    expect(proseLetters(text)).toEqual({ letters: 15, japanese: 8, latin: 7 });
  });

  it("is in a language from 200 letters at its share", () => {
    expect(inLanguage("a".repeat(199), "english").ok).toBe(false);
    expect(inLanguage("a".repeat(200), "english").ok).toBe(true);
    expect(inLanguage(`${"あ".repeat(100)}${"a".repeat(100)}`, "japanese").ok).toBe(true);
    expect(inLanguage(`${"あ".repeat(99)}${"a".repeat(101)}`, "japanese").ok).toBe(false);
    expect(inLanguage(`${"a".repeat(180)}${"あ".repeat(20)}`, "english").ok).toBe(true);
    expect(inLanguage(`${"a".repeat(179)}${"あ".repeat(21)}`, "english").ok).toBe(false);
  });
});
