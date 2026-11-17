import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ClaimResponse } from "@prq/protocol";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { result, stderrLines } from "../test/cli.ts";
import { ask, push, retry, sha } from "../test/pr.ts";
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
      answer: join(claimed.dir, "answer.md"),
      next: "checkout",
    });
    const written: unknown = JSON.parse(await readFile(contextPath, "utf8"));
    expect(written).toEqual({
      pr,
      details: expect.objectContaining({ headSha: sha("h1") }),
      job: claimed.job,
      messages: [],
    });
    expect(await exists(join(claimed.dir, "question.md"))).toBe(false);
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

  it("no claim saved: exit 1 before any request", async () => {
    const exit = await stack.run(["context", "--agent-id", "laptop"]);
    expect(exit.code).toBe(1);
    expect(exit.stdout).toBe("");
    expect(stderrLines(exit)).toEqual(["prq: no claim is saved for agent laptop; run prq claim"]);
    expect(stack.access().log).toEqual([]);
  });
});
