import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { ClaimResponse, PROMPT_CHARS } from "@prq/protocol";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { result, stderrLines } from "../test/cli.ts";
import { latch } from "../test/latch.ts";
import { ask, push, retry, savePrompt, sha, type SkillFiles, storeSkill } from "../test/pr.ts";
import { useStack } from "../test/stack.ts";

const stack = useStack();
const pr = { owner: "acme", repo: "widgets", number: 7 };

const Claimed = v.object({ ...ClaimResponse.options[0].entries, dir: v.string() });

function recordPath(agentId: string): string {
  return join(stack.home(), "agents", `${createHash("sha256").update(agentId).digest("hex")}.json`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// The agent is present first (its wait was a contact), so the pull request's session is local.
async function present(agentId: string): Promise<void> {
  expect((await stack.run(["wait", "--agent-id", agentId, "--timeout", "0"])).code).toBe(2);
}

async function claim(agentId: string) {
  const exit = await stack.run(["claim", "--agent-id", agentId]);
  expect(exit.code).toBe(0);
  return v.parse(Claimed, result(exit));
}

const NEVER_SAVED = { text: "", savedAt: null };

// A published set's directory, as context.json names it.
const SET = /\/instructions\/set-[0-9A-Za-z]{6}$/;

const Saved = v.looseObject({
  instructions: v.object({
    prompts: v.object({ analysis: v.object({ text: v.string() }), answer: v.object({ text: v.string() }) }),
    dir: v.string(),
  }),
});

async function savedContext(dir: string) {
  return v.parse(Saved, JSON.parse(await readFile(join(dir, "context.json"), "utf8")));
}

const Printed = v.object({
  skills: v.array(v.object({ name: v.string(), description: v.string(), path: v.string() })),
});

// A skill with a script, a file in a directory and a binary file.
const POLISH: SkillFiles = {
  "SKILL.md": { text: "---\nname: polish\ndescription: Polishes text.\n---\n# Polish\n" },
  "references/style.md": { text: "# Style\n" },
  "scripts/check.py": { text: "print('ok')\n", mode: "100755" },
  "assets/mark.bin": { text: "\u0000\u00ff\ufeff" },
};

// The files under a skill's directory: each path in the skill, its bytes and its permission bits.
async function filesUnder(path: string): Promise<Record<string, { text: string; mode: number }>> {
  const files: Record<string, { text: string; mode: number }> = {};
  for (const entry of await readdir(path, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = join(entry.parentPath, entry.name);
      files[relative(path, file)] = { text: await readFile(file, "utf8"), mode: (await stat(file)).mode & 0o777 };
    }
  }
  return files;
}

describe("prq context", () => {
  it("an analysis: writes context.json into the claim's directory and names no question", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    const claimed = await claim("laptop");

    const exit = await stack.run(["context", "--agent-id", "laptop"]);
    expect(exit.code).toBe(0);
    expect(exit.stderr).toBe("");
    const contextPath = join(claimed.dir, "context.json");
    expect(result(exit)).toEqual({
      dir: claimed.dir,
      pr,
      details: expect.objectContaining({ headSha: sha("h1"), baseSha: sha("base") }),
      job: claimed.job,
      messages: 0,
      context: contextPath,
      question: null,
      prompt: null,
      skills: [],
      answer: join(claimed.dir, "answer.md"),
      next: "checkout",
    });
    const written: unknown = JSON.parse(await readFile(contextPath, "utf8"));
    expect(written).toEqual({
      pr,
      details: expect.objectContaining({ headSha: sha("h1") }),
      job: claimed.job,
      instructions: {
        prompts: { analysis: NEVER_SAVED, answer: NEVER_SAVED },
        skills: [],
        dir: expect.stringMatching(SET),
      },
      messages: [],
    });
    expect(await exists(join(claimed.dir, "question.md"))).toBe(false);
    // A blank prompt is no file: the set is published empty.
    expect(await readdir(join(claimed.dir, "instructions"))).toEqual([
      basename((await savedContext(claimed.dir)).instructions.dir),
    ]);
  });

  it("an answer: the answer prompt in a new set each run; a path an earlier run printed still opens", async () => {
    await present("laptop");
    // The analysis prompt at its cap, which an answer job never carries into its set.
    await savePrompt(stack.worker(), "analysis", "a".repeat(PROMPT_CHARS));
    await savePrompt(stack.worker(), "answer", "Answer in the language of the question.\n");
    await ask(stack.worker(), pr, "q1", "なぜ?");
    const claimed = await claim("laptop");

    const first = await stack.run(["context", "--agent-id", "laptop"]);
    expect(first.code).toBe(0);
    const firstPrompt = v.parse(v.object({ prompt: v.string() }), result(first)).prompt;
    expect(firstPrompt).toMatch(new RegExp(`^${claimed.dir}/instructions/set-[0-9A-Za-z]{6}/prompt\\.md$`));
    expect(await readFile(firstPrompt, "utf8")).toBe("Answer in the language of the question.\n");
    expect(await readdir(join(firstPrompt, ".."))).toEqual(["prompt.md"]);
    const firstSaved = await savedContext(claimed.dir);
    expect(firstSaved.instructions.dir).toBe(join(firstPrompt, ".."));
    expect(firstSaved.instructions.prompts.analysis.text).toBe("a".repeat(PROMPT_CHARS));

    await savePrompt(stack.worker(), "answer", "Answer briefly.");
    const second = await stack.run(["context", "--agent-id", "laptop"]);
    expect(second.code).toBe(0);
    const secondPrompt = v.parse(v.object({ prompt: v.string() }), result(second)).prompt;
    expect(secondPrompt).not.toBe(firstPrompt);
    expect(await readFile(secondPrompt, "utf8")).toBe("Answer briefly.");
    expect((await savedContext(claimed.dir)).instructions.dir).toBe(join(secondPrompt, ".."));
    // The first run's path still opens, as that run printed it.
    expect(await readFile(firstPrompt, "utf8")).toBe("Answer in the language of the question.\n");
    expect((await readdir(join(claimed.dir, "instructions"))).toSorted()).toEqual(
      [basename(join(firstPrompt, "..")), basename(join(secondPrompt, ".."))].toSorted(),
    );
  });

  it("a later page that fails: exit 1, and context.json and the sets as the earlier run left them", async () => {
    await present("laptop");
    await savePrompt(stack.worker(), "answer", "Answer in the language of the question.");
    // A question larger than a page, so the context takes two.
    await ask(stack.worker(), pr, "huge-q", "x".repeat(12 * 1024 * 1024));
    const claimed = await claim("laptop");
    expect((await stack.run(["context", "--agent-id", "laptop"])).code).toBe(0);
    const context = await readFile(join(claimed.dir, "context.json"));
    const sets = await readdir(join(claimed.dir, "instructions"));

    await savePrompt(stack.worker(), "answer", "Answer briefly.");
    // The first page forwarded as the Worker answers it, the second answered 500.
    const passed = latch();
    passed.open();
    stack
      .access()
      .plan("/cli/context", { kind: "hold", answered: latch(), release: passed }, { kind: "reply", status: 500 });
    const failed = await stack.run(["context", "--agent-id", "laptop"]);

    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(
      stack
        .access()
        .log.filter((entry) => entry.route === "/cli/context")
        .map((entry) => entry.status)
        .slice(-2),
    ).toEqual([200, 500]);
    expect((await readFile(join(claimed.dir, "context.json"))).equals(context)).toBe(true);
    expect(await readdir(join(claimed.dir, "instructions"))).toEqual(sets);
  }, 120_000);

  it("a registered skill: its files at the listed revision in the new set, byte for byte with their modes", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    const skill = await storeSkill(stack.worker(), "polish", POLISH);
    const claimed = await claim("laptop");

    const exit = await stack.run(["context", "--agent-id", "laptop"]);
    expect(exit.code).toBe(0);
    const printed = v.parse(Printed, result(exit));
    const set = (await savedContext(claimed.dir)).instructions.dir;
    expect(printed.skills).toEqual([
      { name: "polish", description: "The polish skill.", path: join(set, "skills/polish") },
    ]);
    expect(await filesUnder(join(set, "skills/polish"))).toEqual({
      "SKILL.md": { text: POLISH["SKILL.md"]?.text, mode: 0o644 },
      "references/style.md": { text: "# Style\n", mode: 0o644 },
      "scripts/check.py": { text: "print('ok')\n", mode: 0o755 },
      "assets/mark.bin": { text: "\u0000\u00ff\ufeff", mode: 0o644 },
    });
    // context.json lists the skill as the context gave it; nothing goes where a worktree would be.
    expect(JSON.parse(await readFile(join(claimed.dir, "context.json"), "utf8"))).toMatchObject({
      instructions: { skills: [{ name: "polish", description: "The polish skill.", rev: skill.rev, sha: skill.sha }] },
    });
    expect(dirname(dirname(set))).toBe(claimed.dir);
    expect(await exists(join(claimed.dir, "worktree"))).toBe(false);
    expect(
      stack
        .access()
        .log.filter((entry) => entry.route === "/cli/skill")
        .map((entry) => entry.status),
    ).toEqual([200]);
  });

  it("a skill updated after the context was read: exit 1 with the set before kept; a rerun reads the update", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    const first = await storeSkill(stack.worker(), "polish", POLISH);
    const claimed = await claim("laptop");
    expect((await stack.run(["context", "--agent-id", "laptop"])).code).toBe(0);
    const context = await readFile(join(claimed.dir, "context.json"));
    const sets = await readdir(join(claimed.dir, "instructions"));

    // The context lists revision `first.rev`; the skill is updated before its files are read.
    const answered = latch();
    const release = latch();
    stack.access().plan("/cli/context", { kind: "hold", answered, release });
    const run = stack.start(["context", "--agent-id", "laptop"]);
    await answered.promise;
    const v2 = { ...POLISH, "SKILL.md": { text: "---\nname: polish\ndescription: v2\n---\n" } };
    await storeSkill(stack.worker(), "polish", v2, { expectedRev: first.rev, commit: "2".repeat(40) });
    release.open();
    const failed = await run.exited;

    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(stderrLines(failed)).toEqual([
      "prq: the skill polish was updated or removed while prq context read it; run prq context again",
    ]);
    expect((await readFile(join(claimed.dir, "context.json"))).equals(context)).toBe(true);
    expect(await readdir(join(claimed.dir, "instructions"))).toEqual(sets);

    const rerun = await stack.run(["context", "--agent-id", "laptop"]);
    expect(rerun.code).toBe(0);
    const [skill] = v.parse(Printed, result(rerun)).skills;
    expect(await readFile(join(skill?.path ?? "", "SKILL.md"), "utf8")).toBe(v2["SKILL.md"].text);
  });

  it("a signal while a skill is read: the set is removed, and prq ends by the signal", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    await storeSkill(stack.worker(), "polish", POLISH);
    const claimed = await claim("laptop");
    expect((await stack.run(["context", "--agent-id", "laptop"])).code).toBe(0);
    const context = await readFile(join(claimed.dir, "context.json"));
    const sets = await readdir(join(claimed.dir, "instructions"));

    const answered = latch();
    const release = latch();
    stack.access().plan("/cli/skill", { kind: "hold", answered, release });
    const run = stack.start(["context", "--agent-id", "laptop"]);
    try {
      await answered.promise;
      // The new set exists while its skill is read.
      expect((await readdir(join(claimed.dir, "instructions"))).length).toBe(sets.length + 1);
      const ended = await run.kill("SIGTERM");

      expect({ code: ended.code, signal: ended.signal, stdout: ended.stdout }).toEqual({
        code: null,
        signal: "SIGTERM",
        stdout: "",
      });
      expect(await readdir(join(claimed.dir, "instructions"))).toEqual(sets);
      expect((await readFile(join(claimed.dir, "context.json"))).equals(context)).toBe(true);
    } finally {
      release.open();
    }
  });

  it("a question larger than a page: its parts joined, question.md byte for byte", async () => {
    await present("laptop");
    // A character beyond Latin-1 and 12 MiB of ASCII: more than one 8 MiB page.
    const text = `Ā${"x".repeat(12 * 1024 * 1024)}`;
    await ask(stack.worker(), pr, "huge-q", text);
    const claimed = await claim("laptop");
    expect(claimed.job.target).toEqual({ kind: "answer", messageId: "huge-q" });

    const exit = await stack.run(["context", "--agent-id", "laptop"]);
    expect(exit.code).toBe(0);
    const questionPath = join(claimed.dir, "question.md");
    expect(result(exit)).toMatchObject({ messages: 1, question: questionPath, next: "answer" });
    expect((await readFile(questionPath)).equals(Buffer.from(text, "utf8"))).toBe(true);
    const pages = stack.access().log.filter((entry) => entry.route === "/cli/context");
    expect(pages.length).toBeGreaterThan(1);
    const written = v.parse(
      v.object({ messages: v.array(v.looseObject({ id: v.string(), text: v.string() })) }),
      JSON.parse(await readFile(join(claimed.dir, "context.json"), "utf8")),
    );
    expect(written.messages).toHaveLength(1);
    const [message] = written.messages;
    expect(message?.id).toBe("huge-q");
    expect(message?.text === text).toBe(true);
    expect(message).not.toHaveProperty("part");
  }, 120_000);

  it("after a retry: exit 4, stale_claim, claim next; the record stays", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    const claimed = await claim("laptop");
    const record = await readFile(recordPath("laptop"), "utf8");
    await retry(stack.worker(), pr, claimed.job.jobId);

    const exit = await stack.run(["context", "--agent-id", "laptop"]);
    expect(exit.code).toBe(4);
    expect(result(exit)).toEqual({ status: "stale_claim", next: "claim" });
    expect(await readFile(recordPath("laptop"), "utf8")).toBe(record);
    expect(await exists(join(claimed.dir, "context.json"))).toBe(false);
  });

  it("a job the session does not have: exit 4, stale_claim", async () => {
    const job = {
      jobId: randomUUID(),
      pr,
      run: 1,
      target: { kind: "analysis", headSha: sha("h1") },
      workspaceSha: null,
    };
    const record = { agentId: "laptop", claim: { job, claimId: randomUUID(), resumed: false } };
    await mkdir(join(stack.home(), "agents"), { recursive: true });
    await writeFile(recordPath("laptop"), JSON.stringify({ ...record, savedAt: new Date().toISOString() }));

    const exit = await stack.run(["context", "--agent-id", "laptop"]);
    expect(exit.code).toBe(4);
    expect(result(exit)).toEqual({ status: "stale_claim", next: "claim" });
    expect(stack.access().log.map((entry) => entry.status)).toEqual([404]);
  });

  it("a jobs directory that is a symlink: exit 1 before any request, nothing written", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    const claimed = await claim("laptop");
    // jobs/ moved to another state root's place and a symlink left in its own.
    const elsewhere = join(stack.dir(), "elsewhere-jobs");
    const jobs = join(stack.home(), "jobs");
    await rename(jobs, elsewhere);
    await symlink(elsewhere, jobs);
    const record = await readFile(recordPath("laptop"), "utf8");

    const exit = await stack.run(["context", "--agent-id", "laptop"]);
    expect(exit.code).toBe(1);
    expect(exit.stdout).toBe("");
    expect(stderrLines(exit)).toEqual([
      `prq: ${jobs} is a symlink, not followed; nothing is written through it (set PRQ_HOME to keep prq's state elsewhere)`,
    ]);
    expect(await readdir(join(elsewhere, basename(claimed.dir)))).toEqual([]);
    expect(await readFile(recordPath("laptop"), "utf8")).toBe(record);
    expect(stack.access().log.filter((entry) => entry.route === "/cli/context")).toEqual([]);
  });

  it("no claim saved: exit 1 before any request", async () => {
    const exit = await stack.run(["context", "--agent-id", "laptop"]);
    expect(exit.code).toBe(1);
    expect(exit.stdout).toBe("");
    expect(stderrLines(exit)).toEqual(["prq: no claim is saved for agent laptop; run prq claim"]);
    expect(stack.access().log).toEqual([]);
  });
});
