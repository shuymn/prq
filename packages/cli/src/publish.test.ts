import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ContextSkill, Job } from "@prq/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "./context.ts";
import { publishContext, type SkillReader } from "./publish.ts";
import type { SkillFile } from "./skills.ts";
import { writeAtomically } from "./state.ts";
import { latch } from "./test/latch.ts";

const pr = { owner: "acme", repo: "widgets", number: 7 };
const job: Job = {
  jobId: "00000000-0000-4000-8000-000000000001",
  pr,
  run: 1,
  target: { kind: "answer", messageId: "q" },
  workspaceSha: null,
};

const POLISH: ContextSkill = { name: "polish", description: "Polishes text.", rev: 1, sha: "1".repeat(40) };

function context(answer: string, skills: ContextSkill[] = []): Context {
  return {
    pr,
    details: null,
    job,
    instructions: {
      prompts: { analysis: { text: "Summarize.", savedAt: 1 }, answer: { text: answer, savedAt: 2 } },
      skills,
    },
    messages: [{ id: "q", role: "user", text: "Why?" }],
  };
}

// A reader that gives every skill these files, as checked files.
function files(entries: Record<string, string>): SkillReader {
  return async () =>
    Object.entries(entries).map(([path, text]): SkillFile => ({ path, mode: "100644", content: Buffer.from(text) }));
}

const NO_SKILLS = files({});

// A write that fails for every file.
async function failingAll(): Promise<void> {
  throw new Error("disk full");
}

// Random bytes that repeat on every call: with a fixed clock, a set name made of the time and these would repeat too.
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, randomBytes: (size: number) => Buffer.alloc(size) };
});

// While contextRename is set, it runs in place of the rename onto context.json, given that rename: the last step of its
// atomic write, issued once the temporary file is written whole. While temporaryRemoval is set, removing a temporary
// file fails.
const faults = vi.hoisted(() => {
  const set: {
    contextRename: ((rename: () => Promise<void>) => Promise<void>) | undefined;
    temporaryRemoval: boolean;
  } = { contextRename: undefined, temporaryRemoval: false };
  return set;
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      const rename = () => fs.rename(from, to);
      await (faults.contextRename !== undefined && to.endsWith("context.json")
        ? faults.contextRename(rename)
        : rename());
    },
    rm: async (path: string, options?: import("node:fs").RmOptions) => {
      if (faults.temporaryRemoval && path.endsWith(".tmp")) {
        throw new Error("removal failed");
      }
      await fs.rm(path, options);
    },
  };
});

// Ends prq as a SIGTERM would, through the listener publishContext added last, with the signal it raises again held
// back: the test goes on from the point where prq would have ended.
function terminate(): void {
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  process.listeners("SIGTERM").at(-1)?.("SIGTERM");
  expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prq-publish-"));
});

afterEach(async () => {
  faults.contextRename = undefined;
  faults.temporaryRemoval = false;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("publishContext", () => {
  it("a second run never removes the first run's set, at the same time with the same random bytes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 1));
    const first = await publishContext(dir, context("First prompt"), NO_SKILLS);
    const second = await publishContext(dir, context("Second prompt"), NO_SKILLS);

    expect(second.prompt).not.toBe(first.prompt);
    expect(await readFile(first.prompt ?? "", "utf8")).toBe("First prompt");
    expect(await readFile(second.prompt ?? "", "utf8")).toBe("Second prompt");
    expect(JSON.parse(await readFile(second.context, "utf8"))).toMatchObject({
      instructions: { dir: dirname(second.prompt ?? "") },
    });
  });

  it("a failed write of question.md, after the set was written, removes that set", async () => {
    const earlier = await publishContext(dir, context("Answer briefly."), NO_SKILLS);
    const setsBefore = await readdir(join(dir, "instructions"));
    await expect(publishContext(dir, context("Answer at length."), NO_SKILLS, failingAll)).rejects.toThrow("disk full");
    expect(await readdir(join(dir, "instructions"))).toEqual(setsBefore);
    expect(await readFile(earlier.context, "utf8")).toContain('"Answer briefly."');
  });

  it("a failed rename onto context.json removes only this run's set, its skills included", async () => {
    const earlier = await publishContext(dir, context("Answer briefly.", [POLISH]), files({ "SKILL.md": "A" }));
    const contextBefore = await readFile(earlier.context, "utf8");
    const setsBefore = await readdir(join(dir, "instructions"));

    faults.contextRename = () => Promise.reject(new Error("rename failed"));
    await expect(
      publishContext(dir, context("Answer at length.", [POLISH]), files({ "SKILL.md": "B" })),
    ).rejects.toThrow("rename failed");

    // The earlier set and the context.json that names it read as before; this run's set and temporary file are gone.
    expect(await readdir(join(dir, "instructions"))).toEqual(setsBefore);
    expect(await readFile(earlier.context, "utf8")).toBe(contextBefore);
    expect(await readFile(earlier.prompt ?? "", "utf8")).toBe("Answer briefly.");
    expect(await readFile(join(earlier.skills[0]?.path ?? "", "SKILL.md"), "utf8")).toBe("A");
    expect((await readdir(dir)).toSorted()).toEqual(["context.json", "instructions", "question.md"]);
  });

  it.each([
    [
      "a signal once the rename is done",
      () => {
        faults.contextRename = async (rename) => {
          await rename();
          terminate();
        };
      },
    ],
    [
      "a failure to remove the temporary file",
      () => {
        faults.temporaryRemoval = true;
      },
    ],
  ])("%s, before the call returns, leaves the set context.json names", async (_, arrange) => {
    await publishContext(dir, context("Answer briefly.", [POLISH]), files({ "SKILL.md": "A" }));
    arrange();
    const published = await publishContext(dir, context("Answer at length.", [POLISH]), files({ "SKILL.md": "B" }));

    const saved: unknown = JSON.parse(await readFile(published.context, "utf8"));
    expect(saved).toMatchObject({ instructions: { dir: dirname(published.prompt ?? "") } });
    expect(await readFile(published.prompt ?? "", "utf8")).toBe("Answer at length.");
    expect(await readFile(join(published.skills[0]?.path ?? "", "SKILL.md"), "utf8")).toBe("B");
  });

  it("a signal once the rename onto context.json is issued removes its temporary file and leaves the set", async () => {
    const earlier = await publishContext(dir, context("Answer briefly."), NO_SKILLS);
    const contextBefore = await readFile(earlier.context, "utf8");
    let left: { entries: string[]; sets: number } | undefined;
    faults.contextRename = async () => {
      terminate();
      left = { entries: (await readdir(dir)).toSorted(), sets: (await readdir(join(dir, "instructions"))).length };
      throw new Error("ended by the signal");
    };
    await expect(publishContext(dir, context("Answer at length."), NO_SKILLS)).rejects.toThrow("ended by the signal");

    // Where prq ended: no temporary file, this run's set beside the earlier one, and context.json as it was.
    expect(left).toEqual({ entries: ["context.json", "instructions", "question.md"], sets: 2 });
    expect(await readFile(earlier.context, "utf8")).toBe(contextBefore);
  });

  it("concurrent refreshes each publish a whole set, and every path either printed keeps opening", async () => {
    // A is held once its set is whole, before it writes context.json; B runs from start to end meanwhile.
    const reached = latch();
    const release = latch();
    const held = async (...args: Parameters<typeof writeAtomically>) => {
      if (args[0].endsWith("context.json")) {
        reached.open();
        await release.promise;
      }
      await writeAtomically(...args);
    };
    const a = publishContext(dir, context("Prompt A", [POLISH]), files({ "SKILL.md": "A", "notes/a.md": "a" }), held);
    await reached.promise;
    const b = await publishContext(dir, context("Prompt B", [POLISH]), files({ "SKILL.md": "B", "notes/b.md": "b" }));
    release.open();
    const published = await a;

    // A published last: context.json names A's set, and every file each run printed opens with that run's bytes.
    const saved: unknown = JSON.parse(await readFile(join(dir, "context.json"), "utf8"));
    expect(saved).toMatchObject({ instructions: { dir: dirname(published.prompt ?? "") } });
    expect(await readFile(published.prompt ?? "", "utf8")).toBe("Prompt A");
    expect(await readFile(join(published.skills[0]?.path ?? "", "notes/a.md"), "utf8")).toBe("a");
    expect(await readFile(b.prompt ?? "", "utf8")).toBe("Prompt B");
    expect(await readFile(join(b.skills[0]?.path ?? "", "SKILL.md"), "utf8")).toBe("B");
    expect(await readFile(join(b.skills[0]?.path ?? "", "notes/b.md"), "utf8")).toBe("b");
    expect(await stat(join(published.skills[0]?.path ?? "", "notes/b.md")).catch(() => null)).toBeNull();
  });
});
