import { type ClaimResponse, type Job, type PrRef, RetryResponse } from "@prq/protocol";
import { runInDurableObject } from "cloudflare:test";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLOUD_NOT_CONFIGURED } from "./pr-session/cloud.ts";
import type { PrSession } from "./pr-session/index.ts";
import type { JobRow } from "./pr-session/jobs.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import { accepted, claimOver, fetchBounded, heldBound, localSession, post, retryOver, submitOver } from "./test/cli.ts";
import {
  clearQueue,
  gate,
  holdInsert,
  jobRows,
  newSession,
  prSessionSeams,
  revOf,
  sessionSql,
  setPool,
  tracked,
} from "./test/session.ts";
import { deliver, deliveryRequest, inbox, nextAt, pullRequestEvent, push, send, sha, takeIn } from "./test/webhook.ts";

const sockets: AgentSocket[] = [];

// Each test starts from an empty queue: the sessions of earlier tests may still have work.
beforeEach(async () => {
  await clearQueue();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

async function analyses(stub: DurableObjectStub<PrSession>): Promise<JobRow[]> {
  return (await jobRows(stub)).filter((row) => row.kind === "analysis");
}

async function analysisOf(stub: DurableObjectStub<PrSession>, label: string): Promise<JobRow> {
  const row = (await analyses(stub)).find((job) => job.target === sha(label));
  if (row === undefined) {
    throw new Error(`no analysis of ${label}`);
  }
  return row;
}

// What a claim returned: the head of an analysis, the question of an answer, or null.
function claimed(claim: ClaimResponse): string | null {
  if (claim.job === null) {
    return null;
  }
  return claim.job.target.kind === "analysis" ? claim.job.target.headSha : claim.job.target.messageId;
}

function holding(claim: ClaimResponse) {
  if (claim.job === null) {
    throw new Error("nothing was claimed");
  }
  return { ...claim, job: claim.job };
}

async function retried(response: Promise<Response>): Promise<RetryResponse["status"]> {
  const res = await response;
  expect(res.status).toBe(200);
  return v.parse(RetryResponse, await res.json()).status;
}

async function status(response: Promise<Response>): Promise<{ status: number; error: unknown }> {
  const res = await response;
  const body: Record<string, unknown> = await res.json();
  return { status: res.status, error: body["error"] };
}

// A submit through the route with the given claimId and run, as the CLI resubmits an answer under a later claim.
function submitWith(token: string, pr: PrRef, job: Job, agentId: string, claimId: string, run: number) {
  const body = { agentId, pr, jobId: job.jobId, claimId, run, target: job.target, text: "the analysis" };
  return post("/cli/submit", token, body);
}

// A cloud session whose cloud agent records the jobs handed to it.
async function cloudSession(repo: string) {
  await setPool([]);
  const session = await newSession(repo, sockets);
  const started: string[] = [];
  const agent = {
    start: (job: Job) => {
      started.push(job.target.kind === "answer" ? job.target.messageId : job.target.headSha);
    },
  };
  await runInDurableObject(session.stub, (instance) => {
    vi.spyOn(prSessionSeams(instance), "cloudAgent").mockReturnValue(agent);
  });
  return { ...session, started };
}

describe("known head", () => {
  // A session whose analysis of head A is in the named state, made by the real steps (the cloud ones by the cloud seam).
  const states: Record<
    string,
    () => Promise<{ stub: DurableObjectStub<PrSession>; ref: PrRef; end?: () => Promise<void> }>
  > = {
    pending: async () => {
      const session = await localSession("known", sockets);
      await push(session.ref, "A");
      return session;
    },
    claimed: async () => {
      const session = await localSession("known", sockets);
      await push(session.ref, "A");
      await claimOver(session.token, "laptop");
      return session;
    },
    finalizing: async () => {
      const session = await localSession("known", sockets);
      await push(session.ref, "A");
      const claim = await claimOver(session.token, "laptop");
      const held = await holdInsert(session.stub, "before");
      const submit = tracked(submitOver(session.token, session.ref, claim, "laptop"));
      await held.reached();
      const end = async () => {
        // The push went through while the submit was held in its append.
        expect(submit.settled()).toBe(false);
        await held.open();
        await accepted(submit.promise);
      };
      return { ...session, end };
    },
    running: async () => {
      const session = await cloudSession("known");
      await push(session.ref, "A");
      return session;
    },
    done: async () => {
      const session = await localSession("known", sockets);
      await push(session.ref, "A");
      const claim = await claimOver(session.token, "laptop");
      await accepted(submitOver(session.token, session.ref, claim, "laptop"));
      return session;
    },
    failed: async () => {
      await setPool([]);
      const session = await newSession("known", sockets);
      await push(session.ref, "A");
      return session;
    },
  };

  it.for(Object.entries(states))(
    "makes no job for a push of a head whose analysis is %s, and leaves that job as it is",
    async ([state, made]) => {
      captureLogs();
      const { stub, ref, end } = await made();
      const before = await analyses(stub);
      expect(before).toMatchObject([{ target: sha("A"), state }]);

      // Delivered and taken in; settle goes on to steps that wait for a held submit, so its end is awaited last.
      await deliver({ body: JSON.stringify(pullRequestEvent(ref, { head: sha("A") })) });
      const settled = tracked(takeIn(ref));
      await vi.waitFor(async () => expect((await inbox(ref)).at(-1)?.processed).toBe(1), { timeout: 3000 });

      expect(await analyses(stub)).toEqual(before);
      await end?.();
      await settled.promise;
    },
  );
});

describe("folding", () => {
  it("supersedes every other head's waiting analysis on a push; a claimed one continues", async () => {
    const logs = captureLogs();
    const { stub, ref, token } = await localSession("fold", sockets);
    await push(ref, "A");
    const claimA = await claimOver(token, "laptop");
    expect(claimed(claimA)).toBe(sha("A"));

    await push(ref, "B");
    await push(ref, "C");

    expect((await analyses(stub)).map((row) => [row.target, row.state])).toEqual([
      [sha("A"), "claimed"],
      [sha("B"), "superseded"],
      [sha("C"), "pending"],
    ]);
    expect(await accepted(submitOver(token, ref, claimA, "laptop"))).toMatchObject({ status: "accepted" });
    expect(claimed(await claimOver(token, "desk"))).toBe(sha("C"));
    const superseded = logs.map((log) => log.entry).filter((entry) => entry["event"] === "prq.job.superseded");
    expect(superseded).toEqual([expect.objectContaining({ headSha: sha("B"), from: "pending", to: "superseded" })]);
  });

  it("supersedes the waiting analysis when the head moves back to a done one, and nothing waits", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("fold", sockets);
    await push(ref, "A");
    await accepted(submitOver(token, ref, await claimOver(token, "laptop"), "laptop"));
    await push(ref, "B");

    await push(ref, "A");

    expect((await analyses(stub)).map((row) => [row.target, row.state])).toEqual([
      [sha("A"), "done"],
      [sha("B"), "superseded"],
    ]);
    expect(await claimOver(token, "desk")).toEqual({ job: null });
    expect((await stub.view()).details?.headSha).toBe(sha("A"));
  });
});

describe("revive", () => {
  it("makes a superseded head's analysis wait again with the same jobId, in a new run", async () => {
    const logs = captureLogs();
    const { stub, ref, token } = await localSession("revive", sockets);
    await push(ref, "A");
    const first = await analysisOf(stub, "A");
    await push(ref, "B");
    expect(await analysisOf(stub, "A")).toMatchObject({ state: "superseded" });

    await push(ref, "A");

    expect(await analysisOf(stub, "A")).toMatchObject({ job_id: first.job_id, state: "pending", run: first.run + 1 });
    expect(await analysisOf(stub, "B")).toMatchObject({ state: "superseded" });
    expect(await claimOver(token, "laptop")).toMatchObject({ job: { jobId: first.job_id, run: first.run + 1 } });
    const revived = logs.map((log) => log.entry).filter((entry) => entry["event"] === "prq.job.revived");
    expect(revived).toEqual([expect.objectContaining({ jobId: first.job_id, from: "superseded", to: "pending" })]);
  });

  it("refuses an answer produced before the fold, resubmitted under a claim after the revival", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("revive", sockets);
    await push(ref, "A");
    const before = holding(await claimOver(token, "laptop"));
    await push(ref, "B");
    // The host ends the stalled claim of the old head: the retry folds it.
    expect(await retried(retryOver(token, ref, before.job.jobId, await revOf(stub, before.job.jobId)))).toBe(
      "superseded",
    );
    await push(ref, "A");

    // The agent's answer from before the fold: its claim is gone, so the CLI claims again, gets the same job, and
    // resubmits under the new claim with the run the answer was produced under.
    expect(await status(submitOver(token, ref, before, "laptop"))).toEqual({ status: 409, error: "stale_claim" });
    const after = holding(await claimOver(token, "laptop"));
    expect(after.job).toMatchObject({ jobId: before.job.jobId, run: before.job.run + 1 });
    const resubmit = submitWith(token, ref, after.job, "laptop", after.claimId, before.job.run);
    expect(await status(resubmit)).toEqual({ status: 409, error: "stale_claim" });
    // An answer produced under the revival's run is accepted.
    const current = submitWith(token, ref, after.job, "laptop", after.claimId, after.job.run);
    expect(await accepted(current)).toMatchObject({ status: "accepted" });
  });
});

describe("revision", () => {
  it("advances an analysis's rev with each change: a fold, a revival, a claim, an old-head retry", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("rev", sockets);
    await push(ref, "A");
    const jobId = (await analysisOf(stub, "A")).job_id;
    let before = await revOf(stub, jobId);
    // The changes whose step left the rev as it was.
    const unchanged: string[] = [];
    const change = async (step: string, made: () => Promise<unknown>) => {
      await made();
      const after = await revOf(stub, jobId);
      if (after !== before + 1) {
        unchanged.push(step);
      }
      before = after;
    };

    await change("fold", () => push(ref, "B"));
    await change("revival", () => push(ref, "A"));
    await change("claim", () => claimOver(token, "laptop"));
    // A claimed analysis is no push's to change.
    await push(ref, "B");
    expect(await revOf(stub, jobId)).toBe(before);
    await change("old-head retry", () => retried(retryOver(token, ref, jobId, before)));

    expect(unchanged).toEqual([]);
    expect(await analysisOf(stub, "A")).toMatchObject({ state: "superseded" });
  });
});

describe("redelivery and reordering", () => {
  it("changes nothing on a redelivery of the current head", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("order", sockets);
    await push(ref, "A");
    const body = JSON.stringify(pullRequestEvent(ref, { head: sha("B") }));
    await deliver({ body });
    await takeIn(ref);
    const rows = await jobRows(stub);
    const view = await stub.view();

    // GitHub's UI sends it again under a new ID.
    await deliver({ body });
    await takeIn(ref);

    expect(await jobRows(stub)).toEqual(rows);
    expect(await stub.view()).toEqual(view);
    expect(claimed(await claimOver(token, "laptop"))).toBe(sha("B"));
  });

  it("makes the newest push's head current: A, B, then A again leaves A waiting", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("order", sockets);
    await push(ref, "A");
    const first = await analysisOf(stub, "A");
    await push(ref, "B");
    await push(ref, "A");

    expect((await stub.view()).details?.headSha).toBe(sha("A"));
    expect((await analyses(stub)).map((row) => [row.job_id, row.state])).toEqual([
      [first.job_id, "pending"],
      [(await analysisOf(stub, "B")).job_id, "superseded"],
    ]);
    expect(claimed(await claimOver(token, "laptop"))).toBe(sha("A"));
  });
});

describe("GitHub's order", () => {
  it("keeps B current when A's call, held until its route answered 503, lands after B", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("github-order", sockets);
    // A's call is held in the session while it arms its wake.
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const schedule = instance.schedule.bind(instance);
      vi.spyOn(instance, "schedule").mockImplementationOnce(async (...args) => {
        await held.wait();
        return schedule(...args);
      });
    });
    const limit = heldBound();
    const a = JSON.stringify(pullRequestEvent(ref, { head: sha("A") }));
    const res = tracked(fetchBounded(limit.bound, await deliveryRequest({ body: a })));
    await held.reached();
    expect((await stub.view()).details).toBeNull();
    limit.expire();
    expect((await res.promise).status).toBe(503);

    await push(ref, "B");
    expect((await stub.view()).details?.headSha).toBe(sha("B"));
    await held.open();
    await limit.late();
    await takeIn(ref);

    expect((await stub.view()).details?.headSha).toBe(sha("B"));
    expect(claimed(await claimOver(token, "laptop"))).toBe(sha("B"));
  });

  it("keeps the newer head when an older push is taken in after it, and none of its details", async () => {
    captureLogs();
    const { stub, ref } = await localSession("github-order", sockets);
    const older = JSON.stringify(pullRequestEvent(ref, { head: sha("A"), title: "older" }));
    await push(ref, "B", { title: "newer" });

    await deliver({ body: older });
    await takeIn(ref);

    expect((await stub.view()).details).toMatchObject({ headSha: sha("B"), title: "newer" });
    expect((await analyses(stub)).map((row) => row.target)).toEqual([sha("B")]);
  });

  it("takes in deliveries stored out of GitHub's order with the newest head current", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("github-order", sockets);
    const a = JSON.stringify(pullRequestEvent(ref, { head: sha("A") }));
    const b = JSON.stringify(pullRequestEvent(ref, { head: sha("B") }));
    await deliver({ body: b });
    await deliver({ body: a });

    await takeIn(ref);

    expect((await stub.view()).details?.headSha).toBe(sha("B"));
    expect((await analyses(stub)).map((row) => [row.target, row.state])).toEqual([[sha("B"), "pending"]]);
    expect(claimed(await claimOver(token, "laptop"))).toBe(sha("B"));
  });

  it("applies a force-push back to an older head, also within the same second", async () => {
    captureLogs();
    const { stub, ref } = await localSession("github-order", sockets);
    await push(ref, "A");
    const at = nextAt();
    await push(ref, "B", { at, before: sha("A") });
    await push(ref, "A", { at, before: sha("B") });

    expect((await stub.view()).details?.headSha).toBe(sha("A"));
    expect(await analysisOf(stub, "A")).toMatchObject({ state: "pending", run: 2 });
  });

  it("does not stall on a lost delivery: a later push moves the head whatever it moved from", async () => {
    captureLogs();
    const { stub, ref } = await localSession("github-order", sockets);
    await push(ref, "A");
    // B's push is never delivered.
    await push(ref, "C", { before: sha("B") });

    expect((await stub.view()).details?.headSha).toBe(sha("C"));
    expect(await analysisOf(stub, "C")).toMatchObject({ state: "pending" });
  });

  it("orders opened and reopened, which name no head before, by time alone", async () => {
    captureLogs();
    const { stub, ref } = await localSession("github-order", sockets);
    const at = nextAt();
    await push(ref, "A", { at });
    // The same second, and nothing links it to A: the head stays.
    await send(ref, { action: "opened", head: sha("X"), at });
    expect((await stub.view()).details?.headSha).toBe(sha("A"));
    expect((await analyses(stub)).map((row) => row.target)).toEqual([sha("A")]);

    await send(ref, { action: "reopened", head: sha("X") });
    expect((await stub.view()).details?.headSha).toBe(sha("X"));
  });

  it("takes the next push of the chain on a tie, whichever is taken in first", async () => {
    captureLogs();
    for (const order of ["chain first", "chain last"]) {
      const { stub, ref } = await localSession("github-order", sockets);
      const at = nextAt();
      const opened = JSON.stringify(pullRequestEvent(ref, { action: "opened", head: sha("A"), at }));
      const next = JSON.stringify(pullRequestEvent(ref, { head: sha("B"), at, before: sha("A") }));
      for (const body of order === "chain first" ? [next, opened] : [opened, next]) {
        await deliver({ body });
        await takeIn(ref);
      }
      expect({ order, head: (await stub.view()).details?.headSha }).toEqual({ order, head: sha("B") });
    }
  });

  it("stores an event's details by their own time, though its head is kept out", async () => {
    captureLogs();
    const { stub, ref } = await localSession("github-order", sockets);
    const earlier = nextAt();
    const at = nextAt();
    await push(ref, "A", { at, title: "one" });

    await send(ref, { action: "synchronize", head: sha("X"), at, title: "two" });
    expect((await stub.view()).details).toMatchObject({ headSha: sha("A"), title: "two" });
    await send(ref, { action: "edited", head: sha("A"), at: earlier, title: "older" });
    expect((await stub.view()).details).toMatchObject({ headSha: sha("A"), title: "two" });
  });

  // Known limits (docs/design.md, Intake): whole seconds and `before` cannot order every same-second sequence. These
  // pin what happens now, and that the next push heals it.
  it("known limit: a same-second A, B, A, B whose middle A is taken in last leaves A current until the next push", async () => {
    captureLogs();
    const { stub, ref } = await localSession("github-order", sockets);
    const at = nextAt();
    await push(ref, "A", { at });
    // GitHub's order is A, B, A, B; the delivery of the second A is taken in last.
    await push(ref, "B", { at, before: sha("A") });
    await push(ref, "B", { at, before: sha("A") });
    await push(ref, "A", { at, before: sha("B") });
    expect((await stub.view()).details?.headSha).toBe(sha("A"));
    expect(await analysisOf(stub, "A")).toMatchObject({ state: "pending" });

    await push(ref, "C", { before: sha("B") });
    expect((await stub.view()).details?.headSha).toBe(sha("C"));
    expect(await analysisOf(stub, "C")).toMatchObject({ state: "pending" });
  });

  it("known limit: a delivery lost inside a same-second chain leaves the head until the next push", async () => {
    captureLogs();
    const { stub, ref } = await localSession("github-order", sockets);
    const at = nextAt();
    await push(ref, "A", { at });
    // B's push, in the same second, is never delivered; C moved from B.
    await push(ref, "C", { at, before: sha("B") });
    expect((await stub.view()).details?.headSha).toBe(sha("A"));
    expect((await analyses(stub)).map((row) => row.target)).toEqual([sha("A")]);

    await push(ref, "D", { before: sha("C") });
    expect((await stub.view()).details?.headSha).toBe(sha("D"));
    expect(await analysisOf(stub, "D")).toMatchObject({ state: "pending" });
  });
});

describe("old-head retry", () => {
  it("supersedes a stalled claim of an old head, ends its claim, and the next claim is the current head", async () => {
    const logs = captureLogs();
    const { stub, ref, token } = await localSession("retry", sockets);
    await push(ref, "A");
    const claimA = holding(await claimOver(token, "laptop"));
    await push(ref, "B");

    expect(await retried(retryOver(token, ref, claimA.job.jobId, await revOf(stub, claimA.job.jobId)))).toBe(
      "superseded",
    );

    expect(await analysisOf(stub, "A")).toMatchObject({ state: "superseded", agent_id: null, claim_id: null });
    expect(await status(submitOver(token, ref, claimA, "laptop"))).toEqual({ status: 409, error: "stale_claim" });
    expect(claimed(await claimOver(token, "desk"))).toBe(sha("B"));
    const entry = logs.map((log) => log.entry).find((logged) => logged["event"] === "prq.job.retried");
    expect(entry).toMatchObject({ jobId: claimA.job.jobId, headSha: sha("A"), from: "claimed", to: "superseded" });
  });

  it("supersedes an old head's failed analysis, and makes the current head's failed one wait", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("retry", sockets);
    await push(ref, "A");
    await push(ref, "B");
    await push(ref, "A");
    await push(ref, "B");
    // A local job never fails; the failures are stood in for with SQL, as a cloud agent's would be.
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'failed', failure = 'stood in', rev = rev + 1");
    const a = await analysisOf(stub, "A");
    const b = await analysisOf(stub, "B");

    expect(await retried(retryOver(token, ref, a.job_id, a.rev))).toBe("superseded");
    expect(await retried(retryOver(token, ref, b.job_id, b.rev))).toBe("retried");

    expect(await analysisOf(stub, "A")).toMatchObject({ state: "superseded", failure: null, run: a.run });
    expect(await analysisOf(stub, "B")).toMatchObject({ state: "pending", failure: null, run: b.run + 1 });
    expect(claimed(await claimOver(token, "laptop"))).toBe(sha("B"));
  });

  it("decides superseded against the head when the retry's statement runs, not when the retry arrived", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("retry", sockets);
    await push(ref, "A");
    const claimA = holding(await claimOver(token, "laptop"));
    await push(ref, "B");
    const seen = await revOf(stub, claimA.job.jobId);
    // The retry, made while A is an old head, is held in the session while it arms its wake.
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const schedule = instance.schedule.bind(instance);
      vi.spyOn(instance, "schedule").mockImplementationOnce(async (...args) => {
        await held.wait();
        return schedule(...args);
      });
    });
    const retry = tracked(retryOver(token, ref, claimA.job.jobId, seen));
    await held.reached();
    // The push back to A goes through while the retry is held; A's claim and revision are untouched by it.
    await push(ref, "A");
    expect(retry.settled()).toBe(false);
    expect(await revOf(stub, claimA.job.jobId)).toBe(seen);

    await held.open();

    expect(await retried(retry.promise)).toBe("retried");
    expect(await analysisOf(stub, "A")).toMatchObject({ state: "pending", run: claimA.job.run + 1 });
    expect(claimed(await claimOver(token, "desk"))).toBe(sha("A"));
  });
});

describe("questions first", () => {
  it("gives a local agent the waiting questions before the current head's analysis", async () => {
    captureLogs();
    const { stub, ref, token, client } = await localSession("first", sockets);
    await push(ref, "A");
    const claimA = await claimOver(token, "laptop");
    await push(ref, "B");
    await client.chat([question("q1")]);
    await push(ref, "C");
    await client.chat([question("q1"), question("q2")]);
    await accepted(submitOver(token, ref, claimA, "laptop"));

    const order = [];
    for (const agentId of ["desk-1", "desk-2", "desk-3", "desk-4"]) {
      order.push(claimed(await claimOver(token, agentId)));
    }

    expect(order).toEqual(["q1", "q2", sha("C"), null]);
    expect(await analysisOf(stub, "B")).toMatchObject({ state: "superseded" });
  });
});

describe("cloud analyses", () => {
  it("hands over the questions, then the current head's analysis, and never a superseded one", async () => {
    captureLogs();
    const { stub, ref, open, started } = await cloudSession("cloud");
    const client = await open();
    await push(ref, "A");
    expect(started).toEqual([sha("A")]);

    await push(ref, "B");
    await client.chat([question("q1")]);
    await push(ref, "C");
    await client.chat([question("q1"), question("q2")]);
    expect(started).toEqual([sha("A")]);
    expect((await stub.view()).jobs.map((job) => job.state)).toEqual([
      "running",
      "superseded",
      "pending",
      "pending",
      "pending",
    ]);

    // #5's completion of each running job, stood in for with SQL, then settle hands over the next one.
    for (const target of [sha("A"), "q1", "q2", sha("C")]) {
      await sessionSql(stub, "UPDATE prq_jobs SET state = 'done' WHERE target = ?", target);
      await stub.settle();
    }
    expect(started).toEqual([sha("A"), "q1", "q2", sha("C")]);
    expect(await analysisOf(stub, "B")).toMatchObject({ state: "superseded" });
  });

  it("fails each push's analysis at once while no cloud agent is configured", async () => {
    captureLogs();
    await setPool([]);
    const { stub, ref } = await newSession("cloud", sockets);

    await push(ref, "A");
    await push(ref, "B");

    expect((await analyses(stub)).map((row) => [row.target, row.state, row.failure])).toEqual([
      [sha("A"), "failed", CLOUD_NOT_CONFIGURED],
      [sha("B"), "failed", CLOUD_NOT_CONFIGURED],
    ]);
  });
});
