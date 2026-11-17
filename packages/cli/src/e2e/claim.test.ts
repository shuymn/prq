import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ClaimResponse } from "@prq/protocol";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { result, stderrLines } from "../test/cli.ts";
import { agents, push, retry, sha } from "../test/pr.ts";
import { useStack } from "../test/stack.ts";

const stack = useStack();
const pr = { owner: "acme", repo: "widgets", number: 7 };

const Claimed = v.object({
  ...ClaimResponse.options[0].entries,
  dir: v.string(),
  answer: v.string(),
  saved: v.boolean(),
  next: v.picklist(["answer", "context"]),
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

// An analysis job for the agent: present first (its wait was a contact), so the pull request's session is local.
async function jobFor(agentId: string, head = "h1"): Promise<void> {
  expect((await stack.run(["wait", "--agent-id", agentId, "--timeout", "0"])).code).toBe(2);
  await push(stack.worker(), pr, sha(head));
}

async function claim(agentId: string) {
  const exit = await stack.run(["claim", "--agent-id", agentId]);
  expect(exit.code).toBe(0);
  return { exit, claimed: v.parse(Claimed, result(exit)) };
}

describe("prq claim", () => {
  it("saves the claim as the agent's record and names the claim's directory", async () => {
    await jobFor("laptop");
    const { exit, claimed } = await claim("laptop");
    const { job, claimId, resumed } = claimed;
    expect(job).toMatchObject({
      pr,
      run: 1,
      target: { kind: "analysis", headSha: sha("h1") },
      workspaceSha: sha("h1"),
    });
    expect(claimed.dir).toBe(join(stack.home(), "jobs", `${job.jobId}-r1-${sha("h1")}`));
    expect(claimed.answer).toBe(join(claimed.dir, "answer.md"));
    expect(claimed).toMatchObject({ resumed: false, saved: false, next: "context" });
    expect(exit.stderr).toBe("");
    expect(await exists(claimed.dir)).toBe(true);

    const record: unknown = JSON.parse(await readFile(recordPath("laptop"), "utf8"));
    expect(record).toEqual({ agentId: "laptop", claim: { job, claimId, resumed }, savedAt: expect.any(String) });
  });

  it("prints nothing for a claim it could not save; the next claim resumes it", async () => {
    await jobFor("laptop");
    // The records' directory can be read (no record) but not written.
    const records = join(stack.home(), "agents");
    await mkdir(records, { recursive: true });
    await chmod(records, 0o500);
    const failed = await stack.run(["claim", "--agent-id", "laptop"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(
      stack
        .access()
        .log.filter((entry) => entry.route === "/cli/claim")
        .map((entry) => entry.status),
    ).toEqual([200]);

    await chmod(records, 0o700);
    const { claimed } = await claim("laptop");
    expect(claimed).toMatchObject({ resumed: true, job: { run: 1 } });
  });

  it("resuming the same job, run and workspace names the same directory and reports a saved answer", async () => {
    await jobFor("laptop");
    const first = (await claim("laptop")).claimed;
    await writeFile(first.answer, "a summary\n");

    const { exit, claimed } = await claim("laptop");
    expect(claimed).toMatchObject({ resumed: true, dir: first.dir, saved: true, next: "answer" });
    expect(claimed.claimId).not.toBe(first.claimId);
    expect(exit.stderr).toBe("");
  });

  it("a claim of the job's next run names another directory and says the earlier claim ended", async () => {
    await jobFor("laptop");
    const first = (await claim("laptop")).claimed;
    await retry(stack.worker(), pr, first.job.jobId);

    const { exit, claimed } = await claim("laptop");
    expect(claimed).toMatchObject({ resumed: false, job: { jobId: first.job.jobId, run: 2 } });
    expect(claimed.dir).not.toBe(first.dir);
    expect(stderrLines(exit)).toEqual([
      `prq: the claim on job ${first.job.jobId} (run 1) ended; do not submit the answer in ${first.dir}`,
    ]);
    const record: unknown = JSON.parse(await readFile(recordPath("laptop"), "utf8"));
    expect(record).toMatchObject({ claim: { claimId: claimed.claimId, job: { run: 2 } } });
  });

  it("no job removes the record and says the earlier claim ended", async () => {
    await jobFor("laptop");
    const first = (await claim("laptop")).claimed;
    await retry(stack.worker(), pr, first.job.jobId);
    expect((await claim("desk")).claimed.job.run).toBe(2);

    const exit = await stack.run(["claim", "--agent-id", "laptop"]);
    expect(exit.code).toBe(0);
    expect(result(exit)).toEqual({ job: null, next: "wait" });
    expect(await exists(recordPath("laptop"))).toBe(false);
    expect(stderrLines(exit)).toEqual([
      `prq: the claim on job ${first.job.jobId} (run 1) ended; do not submit the answer in ${first.dir}`,
    ]);
  });

  it("late claim: a claim that landed behind a 503 is resumed by the retry in the same command", async () => {
    await jobFor("laptop");
    stack.access().plan("/cli/claim", { kind: "lose" });
    const { claimed } = await claim("laptop");
    expect(claimed).toMatchObject({ resumed: true, job: { run: 1, target: { headSha: sha("h1") } } });
    expect(
      stack
        .access()
        .log.filter((entry) => entry.route === "/cli/claim")
        .map((entry) => entry.status),
    ).toEqual([503, 200]);
  });

  it("agent ID: --agent-id over PRQ_AGENT_ID, sent with the service token", async () => {
    const flagged = await stack.run(["claim", "--agent-id", "from-flag"], { PRQ_AGENT_ID: "from-env" });
    expect(flagged.code).toBe(0);
    const unflagged = await stack.run(["claim"], { PRQ_AGENT_ID: "from-env" });
    expect(unflagged.code).toBe(0);

    expect(stack.access().log.map(({ agentId, serviceToken }) => ({ agentId, serviceToken }))).toEqual([
      { agentId: "from-flag", serviceToken: true },
      { agentId: "from-env", serviceToken: true },
    ]);
    expect((await agents(stack.worker())).map((row) => row.agentId).toSorted()).toEqual(["from-env", "from-flag"]);
  });
});
