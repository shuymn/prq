import type { ContextResponse, Job, PrDetails } from "@prq/protocol";
import { describe, expect, it } from "vitest";

import { questionOf, readContext } from "./context.ts";

const JOB_ID = "00000000-0000-4000-8000-000000000001";
const pr = { owner: "acme", repo: "widgets", number: 7 };
const answerJob: Job = {
  jobId: JOB_ID,
  pr,
  run: 1,
  target: { kind: "answer", messageId: "q" },
  workspaceSha: null,
};

type Message = ContextResponse["messages"][number];

function page(messages: Message[], nextCursor: string | null, job: Job = answerJob): ContextResponse {
  return { pr, details: null, job, messages, nextCursor };
}

function user(id: string, text: string): Message {
  return { id, role: "user", text };
}

function part(id: string, text: string, offset: number, length: number): Message {
  return { id, role: "user", text, part: { offset, length } };
}

// Reads the pages in order: the first for no cursor, each next one for the cursor the page before named.
async function read(pages: ContextResponse[]) {
  const asked: (string | undefined)[] = [];
  const context = await readContext(JOB_ID, async (cursor) => {
    asked.push(cursor);
    const next = pages[asked.length - 1];
    if (next === undefined) {
      throw new Error("read past the last page");
    }
    return next;
  });
  return { context, asked };
}

describe("readContext", () => {
  it("follows nextCursor until null and joins a message sent in parts across pages", async () => {
    const { context, asked } = await read([
      page([user("a", "first"), part("q", "ab", 0, 6)], "c1"),
      page([part("q", "cd", 2, 6)], "c2"),
      page([part("q", "ef", 4, 6), user("b", "last")], null),
    ]);
    expect(asked).toEqual([undefined, "c1", "c2"]);
    expect(context.messages).toEqual([user("a", "first"), user("q", "abcdef"), user("b", "last")]);
    expect(questionOf(context)).toBe("abcdef");
  });

  it("keeps the first page's instructions, and empty prompts when a server sends none", async () => {
    const saved = { text: "Answer briefly.", savedAt: 1 };
    const instructions = { prompts: { analysis: saved, answer: saved } };
    const later = { prompts: { analysis: { text: "", savedAt: null }, answer: { text: "", savedAt: null } } };
    const { context } = await read([
      { ...page([user("q", "first")], "c1"), instructions },
      { ...page([], null), instructions: later },
    ]);
    expect(context.instructions).toEqual(instructions);
    expect((await read([page([user("q", "first")], null)])).context.instructions).toEqual(later);
  });

  it("keeps the last page's details", async () => {
    const details: PrDetails = {
      fullName: "acme/widgets",
      title: "a change",
      state: "open",
      url: "https://github.com/acme/widgets/pull/7",
      headSha: "1".repeat(40),
      baseSha: "2".repeat(40),
    };
    const { context } = await read([page([], "c1"), { ...page([], null), details }]);
    expect(context.details).toEqual(details);
  });

  it.each([
    ["a part out of order", [page([part("q", "ab", 0, 4)], "c1"), page([part("q", "d", 3, 4)], null)]],
    ["a part with another length", [page([part("q", "ab", 0, 4)], "c1"), page([part("q", "cd", 2, 5)], null)]],
    ["another message inside a part", [page([part("q", "ab", 0, 4)], "c1"), page([user("x", "cd")], null)]],
    ["a first part past the start", [page([part("q", "cd", 2, 4)], null)]],
    ["a part past its length", [page([part("q", "ab", 0, 3)], "c1"), page([part("q", "cd", 2, 3)], null)]],
    ["pages that end inside a message", [page([part("q", "ab", 0, 4)], null)]],
    ["a cursor read before", [page([], "c1"), page([], "c2"), page([], "c1")]],
    ["a page of another job", [page([], null, { ...answerJob, jobId: "00000000-0000-4000-8000-000000000002" })]],
  ])("refuses %s", async (_, pages) => {
    await expect(read(pages)).rejects.toThrow(/^the context's pages do not join: /);
  });
});

describe("questionOf", () => {
  it("null for an analysis", async () => {
    const analysis: Job = { ...answerJob, target: { kind: "analysis", headSha: "1".repeat(40) } };
    const { context } = await read([page([user("a", "text")], null, analysis)]);
    expect(questionOf(context)).toBeNull();
  });

  it.each([
    ["missing", [user("other", "text")]],
    ["not a user's", [{ id: "q", role: "assistant" as const, text: "text" }]],
  ])("refuses a question %s", async (_, messages) => {
    const { context } = await read([page(messages, null)]);
    expect(() => questionOf(context)).toThrow('the question "q" is not in the conversation');
  });
});
