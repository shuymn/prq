import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ClaimResponse } from "@prq/protocol";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { result, stderrLines } from "../test/cli.ts";
import { latch } from "../test/latch.ts";
import { ask, push, retry, sha, storedMessages } from "../test/pr.ts";
import { useStack } from "../test/stack.ts";

const stack = useStack();
const pr = { owner: "acme", repo: "widgets", number: 7 };

const Claimed = v.object({
  ...ClaimResponse.options[0].entries,
  dir: v.string(),
  answer: v.string(),
  saved: v.boolean(),
});

const Dropped = v.object({
  status: v.literal("dropped"),
  reason: v.string(),
  claim: v.nullable(Claimed),
  next: v.picklist(["answer", "context", "wait"]),
});

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

// A claim of the next job whose first request lands only after the CLI's resend took the job: the stand-in answers it
// 503 at once and forwards it when the returned latch opens, then the Hub resumes the job under another claimId.
async function claimWithLateFirst(agentId: string) {
  const release = latch();
  const answered = latch();
  stack.access().plan("/cli/claim", { kind: "defer", release, answered });
  const claimed = await claim(agentId);
  expect(claimed.resumed).toBe(false);
  return {
    claimed,
    land: async () => {
      release.open();
      await answered.promise;
    },
  };
}

function submits(): (number | null)[] {
  return stack
    .access()
    .log.filter((entry) => entry.route === "/cli/submit")
    .map((entry) => entry.status);
}

async function answers(): Promise<{ id: string; text: string }[]> {
  return (await storedMessages(stack.worker(), pr))
    .filter((message) => message.role === "assistant")
    .map(({ id, text }) => ({ id, text }));
}

describe("prq submit", () => {
  it("sends answer.md under the claim: accepted, the record removed", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    const claimed = await claim("laptop");
    await writeFile(claimed.answer, "the summary\n");

    const exit = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(exit.code).toBe(0);
    expect(exit.stderr).toBe("");
    expect(result(exit)).toEqual({ status: "accepted", messageId: `analysis-${claimed.job.jobId}`, next: "wait" });
    expect(await exists(recordPath("laptop"))).toBe(false);
    expect(await answers()).toEqual([{ id: `analysis-${claimed.job.jobId}`, text: "the summary\n" }]);
  });

  it("late claim after the resend: claims once and resubmits under the original run, stored once", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    const { claimed, land } = await claimWithLateFirst("laptop");
    await writeFile(claimed.answer, "the summary\n");
    await land();

    const exit = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(exit.code).toBe(0);
    expect(result(exit)).toEqual({ status: "accepted", messageId: `analysis-${claimed.job.jobId}`, next: "wait" });
    expect(submits()).toEqual([409, 200]);
    expect(await exists(recordPath("laptop"))).toBe(false);
    expect(await answers()).toEqual([{ id: `analysis-${claimed.job.jobId}`, text: "the summary\n" }]);
  });

  it("retry while working: the answer is dropped for the next run's claim, which then takes its own answer", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    const first = await claim("laptop");
    await writeFile(first.answer, "written under run 1\n");
    await retry(stack.worker(), pr, first.job.jobId);

    const dropped = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(dropped.code).toBe(4);
    const output = v.parse(Dropped, result(dropped));
    expect(output).toMatchObject({ reason: "stale_claim", next: "context", claim: { job: { run: 2 }, saved: false } });
    expect(output.claim?.dir).not.toBe(first.dir);
    expect(stderrLines(dropped)).toEqual([
      `prq: the claim on job ${first.job.jobId} (run 1) ended; do not submit the answer in ${first.dir}`,
    ]);
    // One submit: the claim of another run is not sent the answer.
    expect(submits()).toEqual([409]);
    expect(await answers()).toEqual([]);
    const record: unknown = JSON.parse(await readFile(recordPath("laptop"), "utf8"));
    expect(record).toMatchObject({ claim: { claimId: output.claim?.claimId, job: { run: 2 } } });

    // The answer written under run 1 stays in run 1's directory and is not sent under run 2.
    const missing = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(missing.code).toBe(1);
    expect(stderrLines(missing)).toEqual([
      `prq: no answer in ${output.claim?.answer}: write it there, then run prq submit`,
    ]);
    expect(submits()).toEqual([409]);

    await writeFile(output.claim?.answer ?? "", "written under run 2\n");
    const accepted = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(accepted.code).toBe(0);
    expect(result(accepted)).toMatchObject({ status: "accepted" });
    expect(await answers()).toEqual([{ id: `analysis-${first.job.jobId}`, text: "written under run 2\n" }]);
  });

  it("head moved before the recovery: the claim is kept, the answer dropped as workspace_moved", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    await ask(stack.worker(), pr, "q1", "what changed?");
    // The oldest waiting answer comes first: the question, at the current head.
    const { claimed, land } = await claimWithLateFirst("laptop");
    expect(claimed.job).toMatchObject({ target: { kind: "answer", messageId: "q1" }, workspaceSha: sha("h1") });
    await writeFile(claimed.answer, "an answer read at h1\n");

    // A push, and another agent's analysis of the new head.
    await push(stack.worker(), pr, sha("h2"));
    const analysis = await claim("desk");
    expect(analysis.job.target).toEqual({ kind: "analysis", headSha: sha("h2") });
    await writeFile(analysis.answer, "the summary of h2\n");
    expect((await stack.run(["submit", "--agent-id", "desk"])).code).toBe(0);
    // The late claim resumes the question, its workspace fixed again at the analyzed head.
    await land();

    const exit = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(exit.code).toBe(4);
    const output = v.parse(Dropped, result(exit));
    expect(output).toMatchObject({
      reason: "workspace_moved",
      next: "context",
      claim: { resumed: true, job: { jobId: claimed.job.jobId, run: 1, workspaceSha: sha("h2") }, saved: false },
    });
    expect(output.claim?.dir).not.toBe(claimed.dir);
    expect(await answers()).toEqual([{ id: `analysis-${analysis.job.jobId}`, text: "the summary of h2\n" }]);
    const record: unknown = JSON.parse(await readFile(recordPath("laptop"), "utf8"));
    expect(record).toMatchObject({ claim: { claimId: output.claim?.claimId, job: { workspaceSha: sha("h2") } } });
  });

  it("taken by another agent: no resubmit, exit 4 without a claim, the record removed", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    const first = await claim("laptop");
    await writeFile(first.answer, "the summary\n");
    await retry(stack.worker(), pr, first.job.jobId);
    expect((await claim("desk")).job.run).toBe(2);

    const exit = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(exit.code).toBe(4);
    expect(result(exit)).toEqual({ status: "dropped", reason: "stale_claim", claim: null, next: "wait" });
    expect(submits()).toEqual([409]);
    expect(await exists(recordPath("laptop"))).toBe(false);
    expect(await answers()).toEqual([]);
  });

  it("answer file: a missing or blank answer is refused before any request", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    const claimed = await claim("laptop");

    const missing = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");
    expect(stderrLines(missing)).toEqual([`prq: no answer in ${claimed.answer}: write it there, then run prq submit`]);

    await writeFile(claimed.answer, " \n\t\n");
    const blank = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(blank.code).toBe(1);
    expect(stderrLines(blank)).toEqual([`prq: the answer in ${claimed.answer} is blank`]);
    expect(submits()).toEqual([]);
    expect(await exists(recordPath("laptop"))).toBe(true);
  });

  it("500 then rerun: exit 1 keeping the record and the answer; the rerun is accepted", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    const claimed = await claim("laptop");
    await writeFile(claimed.answer, "the summary\n");
    const record = await readFile(recordPath("laptop"), "utf8");
    stack.access().plan("/cli/submit", { kind: "reply", status: 500 });

    const failed = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(stderrLines(failed)).toEqual(["prq: /cli/submit answered 500 internal"]);
    expect(await readFile(recordPath("laptop"), "utf8")).toBe(record);
    expect(await readFile(claimed.answer, "utf8")).toBe("the summary\n");

    const rerun = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(rerun.code).toBe(0);
    expect(result(rerun)).toMatchObject({ status: "accepted" });
    expect(await answers()).toHaveLength(1);
  });

  it("response lost after the store: the resend gets duplicate, stored once, the record removed", async () => {
    await present("laptop");
    await push(stack.worker(), pr, sha("h1"));
    const claimed = await claim("laptop");
    await writeFile(claimed.answer, "the summary\n");
    stack.access().plan("/cli/submit", { kind: "drop" });

    const exit = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(exit.code).toBe(0);
    expect(result(exit)).toEqual({ status: "duplicate", messageId: `analysis-${claimed.job.jobId}`, next: "wait" });
    expect(submits()).toEqual([200, 200]);
    expect(await exists(recordPath("laptop"))).toBe(false);
    expect(await answers()).toEqual([{ id: `analysis-${claimed.job.jobId}`, text: "the summary\n" }]);
  });

  it("a job the session does not have: dropped without a claim, the record removed", async () => {
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
    const dir = join(stack.home(), "jobs", `${job.jobId}-r1-none`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "answer.md"), "an answer\n");

    const exit = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(exit.code).toBe(4);
    expect(result(exit)).toEqual({ status: "dropped", reason: "unknown_job", claim: null, next: "wait" });
    expect(submits()).toEqual([404]);
    expect(await exists(recordPath("laptop"))).toBe(false);
  });

  it("no claim saved: exit 1 before any request", async () => {
    const exit = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(exit.code).toBe(1);
    expect(stderrLines(exit)).toEqual(["prq: no claim is saved for agent laptop; run prq claim"]);
    expect(stack.access().log).toEqual([]);
  });
});
