import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Job } from "@prq/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "./context.ts";
import { publishContext } from "./publish.ts";
import { writeAtomically } from "./state.ts";

const pr = { owner: "acme", repo: "widgets", number: 7 };
const job: Job = {
  jobId: "00000000-0000-4000-8000-000000000001",
  pr,
  run: 1,
  target: { kind: "answer", messageId: "q" },
  workspaceSha: null,
};

function context(answer: string): Context {
  return {
    pr,
    details: null,
    job,
    instructions: {
      prompts: { analysis: { text: "Summarize.", savedAt: 1 }, answer: { text: answer, savedAt: 2 } },
    },
    messages: [{ id: "q", role: "user", text: "Why?" }],
  };
}

// A write that fails for context.json only, and one that fails for every file.
async function failingContext(path: string, content: string): Promise<void> {
  if (path.endsWith("context.json")) {
    throw new Error("disk full");
  }
  await writeAtomically(path, content);
}

async function failingAll(): Promise<void> {
  throw new Error("disk full");
}

// Random bytes that repeat on every call: with a fixed clock, a set name made of the time and these would repeat too.
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, randomBytes: (size: number) => Buffer.alloc(size) };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prq-publish-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("publishContext", () => {
  it("a second run never removes the first run's set, at the same time with the same random bytes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 1));
    const first = await publishContext(dir, context("First prompt"));
    const second = await publishContext(dir, context("Second prompt"));

    expect(second.prompt).not.toBe(first.prompt);
    expect(await readFile(first.prompt ?? "", "utf8")).toBe("First prompt");
    expect(await readFile(second.prompt ?? "", "utf8")).toBe("Second prompt");
    expect(JSON.parse(await readFile(second.context, "utf8"))).toMatchObject({
      instructions: { dir: dirname(second.prompt ?? "") },
    });
  });

  it("a failed write of context.json removes the set it made and leaves the earlier publication as it was", async () => {
    const earlier = await publishContext(dir, context("Answer in the language of the question."));
    const contextBefore = await readFile(earlier.context, "utf8");
    const setsBefore = await readdir(join(dir, "instructions"));

    await expect(publishContext(dir, context("Answer briefly."), failingContext)).rejects.toThrow("disk full");

    // No new set is left; the earlier set and the context that names it are unchanged.
    expect(await readdir(join(dir, "instructions"))).toEqual(setsBefore);
    expect(await readFile(earlier.context, "utf8")).toBe(contextBefore);
    expect(await readFile(earlier.prompt ?? "", "utf8")).toBe("Answer in the language of the question.");
  });

  it("a failed write of question.md, after the set was written, removes that set", async () => {
    const earlier = await publishContext(dir, context("Answer briefly."));
    const setsBefore = await readdir(join(dir, "instructions"));
    await expect(publishContext(dir, context("Answer at length."), failingAll)).rejects.toThrow("disk full");
    expect(await readdir(join(dir, "instructions"))).toEqual(setsBefore);
    expect(await readFile(earlier.context, "utf8")).toContain('"Answer briefly."');
  });
});
