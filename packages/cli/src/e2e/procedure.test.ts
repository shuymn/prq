// The procedure skills/prq/SKILL.md gives a local AI session, followed by a script that reads nothing but each result's
// next: it runs the command next names, writes a fixed answer when next is answer and then submits, and stops at a wait
// that times out, the session idle with nothing to do. Each outcome the SKILL handles must lead it back to that wait,
// through next values the SKILL lists. Whether a model follows the SKILL is the recorded run's (verify-prq).

import { writeFile } from "node:fs/promises";

import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { result } from "../test/cli.ts";
import { makeRepo } from "../test/git.ts";
import { latch } from "../test/latch.ts";
import { ask, push, retry, storedMessages } from "../test/pr.ts";
import { useStack } from "../test/stack.ts";

const stack = useStack();
const pr = { owner: "acme", repo: "widgets", number: 7 };

const ANSWER = "the follower's answer\n";

// The steps the SKILL names; answer is the one that is not a command.
const Next = v.picklist(["wait", "claim", "context", "checkout", "answer"]);
type Step = v.InferOutput<typeof Next> | "reconcile" | "submit";

// What the follower reads from a result: next, and the answer path a job's result carries (claim and context print it,
// reconcile and a dropped submit inside their claim); the rest labels the step in the sequence.
const Result = v.looseObject({
  next: Next,
  answer: v.optional(v.string()),
  claim: v.optional(v.nullable(v.looseObject({ answer: v.string() }))),
  job: v.optional(v.nullable(v.looseObject({ jobId: v.string() }))),
  status: v.optional(v.string()),
  reason: v.optional(v.string()),
});
type Result = v.InferOutput<typeof Result>;

// What a test does just before the follower's first run of a step: the outside events of its outcome.
type Events = Partial<Record<Step, (last: Partial<Record<Step, Result>>) => Promise<void>>>;

// Runs the procedure for agentId from the step start, with env on top of the stack's. Returns each step as
// "<command> <exit code> <status or reason>" ("answer" for the answer), and fails on an exit the procedure does not
// continue from (1, 3) or a next outside the SKILL's list. The bound stops a loop that never reaches an idle wait.
async function follow(agentId: string, start: Step, events: Events = {}, env: Record<string, string> = {}) {
  const sequence: string[] = [];
  const last: Partial<Record<Step, Result>> = {};
  let answer: string | undefined;
  let step = start;
  for (let n = 0; n < 16; n += 1) {
    const event = events[step];
    delete events[step];
    await event?.(last);
    if (step === "answer") {
      if (answer === undefined) {
        throw new Error("next is answer, but no result named the answer's path");
      }
      await writeFile(answer, ANSWER);
      sequence.push("answer");
      step = "submit";
      continue;
    }
    const args = step === "wait" ? ["wait", "--timeout", "0"] : [step];
    const exit = await stack.run([...args, "--agent-id", agentId], env);
    if (exit.code !== 0 && exit.code !== 2 && exit.code !== 4) {
      throw new Error(`prq ${step} exited ${exit.code} after ${sequence.join(", ")}: ${exit.stderr}`);
    }
    const out = v.parse(Result, result(exit));
    last[step] = out;
    answer = out.answer ?? out.claim?.answer ?? answer;
    const label = out.reason ?? out.status ?? (out.job === null || out.claim === null ? "none" : undefined);
    sequence.push([step, exit.code, label].filter((part) => part !== undefined).join(" "));
    if (step === "wait" && exit.code === 2) {
      return sequence;
    }
    step = out.next;
  }
  throw new Error(`no idle wait after ${sequence.join(", ")}`);
}

function jobId(out: Result | undefined): string {
  const id = out?.job?.jobId;
  if (id === undefined) {
    throw new Error("no job in the result");
  }
  return id;
}

// The agent is present first (its wait was a contact), so the pull request's session gives its jobs to local agents.
async function present(agentId: string): Promise<void> {
  expect((await stack.run(["wait", "--agent-id", agentId, "--timeout", "0"])).code).toBe(2);
}

async function answers(): Promise<string[]> {
  return (await storedMessages(stack.worker(), pr))
    .filter((message) => message.role === "assistant")
    .map((message) => message.text);
}

// Another agent's claim and submit of the job the pool gives it next.
async function takeAndSubmit(agentId: string, text: string): Promise<void> {
  const claimed = v.parse(Result, result(await stack.run(["claim", "--agent-id", agentId])));
  await writeFile(claimed.answer ?? "", text);
  expect((await stack.run(["submit", "--agent-id", agentId])).code).toBe(0);
}

describe("the procedure, following only next", () => {
  it("accepted: a question before any push, answered without a worktree", async () => {
    await present("laptop");
    await ask(stack.worker(), pr, "q1", "what is this?");

    expect(await follow("laptop", "wait")).toEqual([
      "wait 0 ready",
      "claim 0",
      "context 0",
      "answer",
      "submit 0 accepted",
      "wait 2 timeout",
    ]);
    expect(await answers()).toEqual([ANSWER]);
  });

  it("a job with a workspace: through checkout", async () => {
    const repo = await makeRepo(stack.dir(), pr);
    const head = await repo.head("h1");
    await present("laptop");
    await push(stack.worker(), pr, head, repo.base);

    expect(await follow("laptop", "wait", {}, repo.env)).toEqual([
      "wait 0 ready",
      "claim 0",
      "context 0",
      "checkout 0",
      "answer",
      "submit 0 accepted",
      "wait 2 timeout",
    ]);
    expect(await answers()).toEqual([ANSWER]);
  });

  it("duplicate after a lost response", async () => {
    await present("laptop");
    await ask(stack.worker(), pr, "q1", "what is this?");
    const events: Events = {
      submit: async () => {
        stack.access().plan("/cli/submit", { kind: "drop" });
      },
    };

    expect(await follow("laptop", "wait", events)).toEqual([
      "wait 0 ready",
      "claim 0",
      "context 0",
      "answer",
      "submit 0 duplicate",
      "wait 2 timeout",
    ]);
    expect(await answers()).toEqual([ANSWER]);
  });

  it("no job: another agent took it between the wait and the claim", async () => {
    await present("laptop");
    await ask(stack.worker(), pr, "q1", "what is this?");
    const events: Events = {
      claim: async () => {
        expect((await stack.run(["claim", "--agent-id", "desk"])).code).toBe(0);
      },
    };

    expect(await follow("laptop", "wait", events)).toEqual(["wait 0 ready", "claim 0 none", "wait 2 timeout"]);
  });

  it("dropped for a newer run: the host retried while the answer was written", async () => {
    await present("laptop");
    await ask(stack.worker(), pr, "q1", "what is this?");
    const events: Events = {
      submit: async (last) => retry(stack.worker(), pr, jobId(last.claim)),
    };

    expect(await follow("laptop", "wait", events)).toEqual([
      "wait 0 ready",
      "claim 0",
      "context 0",
      "answer",
      "submit 4 stale_claim",
      "context 0",
      "answer",
      "submit 0 accepted",
      "wait 2 timeout",
    ]);
    expect(await answers()).toEqual([ANSWER]);
  });

  it("dropped for a moved workspace: a push and another agent's analysis before the late claim landed", async () => {
    const repo = await makeRepo(stack.dir(), pr);
    const h1 = await repo.head("h1");
    await present("laptop");
    await push(stack.worker(), pr, h1, repo.base);
    await ask(stack.worker(), pr, "q1", "what changed?");
    const release = latch();
    const answered = latch();
    const events: Events = {
      // The claim's first request lands only after its resend took the question.
      claim: async () => {
        stack.access().plan("/cli/claim", { kind: "defer", release, answered });
      },
      submit: async () => {
        await push(stack.worker(), pr, await repo.head("h2"), repo.base);
        await takeAndSubmit("desk", "the summary of h2\n");
        release.open();
        await answered.promise;
      },
    };

    expect(await follow("laptop", "wait", events, repo.env)).toEqual([
      "wait 0 ready",
      "claim 0",
      "context 0",
      "checkout 0",
      "answer",
      "submit 4 workspace_moved",
      "context 0",
      "checkout 0",
      "answer",
      "submit 0 accepted",
      "wait 2 timeout",
    ]);
    expect(await answers()).toEqual(["the summary of h2\n", ANSWER]);
  });

  it("a stale claim found by context: the host retried before the context was read", async () => {
    await present("laptop");
    await ask(stack.worker(), pr, "q1", "what is this?");
    const events: Events = {
      context: async (last) => retry(stack.worker(), pr, jobId(last.claim)),
    };

    expect(await follow("laptop", "wait", events)).toEqual([
      "wait 0 ready",
      "claim 0",
      "context 4 stale_claim",
      "claim 0",
      "context 0",
      "answer",
      "submit 0 accepted",
      "wait 2 timeout",
    ]);
    expect(await answers()).toEqual([ANSWER]);
  });

  it("a restart resolved by reconcile: the unfinished saved answer is finished, then submitted", async () => {
    await present("laptop");
    await ask(stack.worker(), pr, "q1", "what is this?");
    // The session before the restart: a claim whose first request landed late, replacing its claimId, and an answer
    // it stopped writing.
    const release = latch();
    const answered = latch();
    stack.access().plan("/cli/claim", { kind: "defer", release, answered });
    const claimed = v.parse(Result, result(await stack.run(["claim", "--agent-id", "laptop"])));
    await writeFile(claimed.answer ?? "", "the first half");
    release.open();
    await answered.promise;

    expect(await follow("laptop", "reconcile")).toEqual([
      "reconcile 0",
      "claim 0",
      "answer",
      "submit 0 accepted",
      "wait 2 timeout",
    ]);
    expect(await answers()).toEqual([ANSWER]);
  });
});
