import { AIChatAgent } from "@cloudflare/ai-chat";
import type { ClaimResponse } from "@prq/protocol";
import type { UIMessage } from "ai";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prSessionStub } from "./names.ts";
import { captureLogs, type LogEntry } from "./test/access.ts";
import { type AgentSocket, question, storedMessages } from "./test/chat.ts";
import {
  gate,
  jobOf,
  jobRows,
  newSession,
  prSessionSeams,
  type Session,
  sessionSql,
  setPool,
  submission,
  tracked,
} from "./test/session.ts";

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q1 = question("q1");
const Q2 = question("q2");

// A local session (agents A, B and C present) with the given questions asked over a chat connection.
async function localSession(...questions: UIMessage[]) {
  await setPool(["agent-a", "agent-b", "agent-c"]);
  const session = await newSession("jobs", sockets);
  const client = await session.open();
  if (questions.length > 0) {
    await client.chat(questions);
  }
  return { ...session, client };
}

function claimed(claim: ClaimResponse) {
  if (claim.job === null) {
    throw new Error("nothing was claimed");
  }
  return { jobId: claim.job.jobId, claimId: claim.claimId, target: claim.job.target, resumed: claim.resumed };
}

async function answers(session: Session): Promise<UIMessage[]> {
  return (await storedMessages(session.path, session.token)).filter((message) => message.role === "assistant");
}

describe("claim", () => {
  it("returns the agent's own claimed job first, then the oldest pending answer, never another agent's", async () => {
    captureLogs();
    const session = await localSession(Q1);
    const { stub, client } = session;

    const a1 = claimed(await stub.claim("agent-a", "fresh"));
    await client.chat([Q1, Q2]);
    await sessionSql(stub, "UPDATE prq_jobs SET claimed_at = 1 WHERE target = 'q1'");
    // A's resume pass returns Q1 again under a new claim, with the claim time set again.
    const a2 = claimed(await stub.claim("agent-a", "resume"));
    expect(a2).toMatchObject({ jobId: a1.jobId, resumed: true });
    expect(a2.claimId).not.toBe(a1.claimId);
    expect((await jobOf(stub, "q1")).claimed_at).toBeGreaterThan(1);
    // B gets Q2, and its resume returns Q2 under a new claim.
    expect(await stub.claim("agent-b", "resume")).toEqual({ job: null });
    const b1 = claimed(await stub.claim("agent-b", "fresh"));
    expect(b1.target).toEqual({ kind: "answer", messageId: "q2" });
    const b2 = claimed(await stub.claim("agent-b", "resume"));
    expect(b2.jobId).toBe(b1.jobId);
    expect(b2.claimId).not.toBe(b1.claimId);
    // C gets nothing: both jobs are claimed by other agents.
    expect(await stub.claim("agent-c", "resume")).toEqual({ job: null });
    expect(await stub.claim("agent-c", "fresh")).toEqual({ job: null });
  });

  it("gives two interleaved claims different jobs", async () => {
    captureLogs();
    const { stub } = await localSession(Q1, Q2);
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const owner = seams.ownerOf.bind(instance);
      vi.spyOn(seams, "ownerOf").mockImplementationOnce(async () => {
        await held.wait();
        return owner();
      });
    });
    const claimA = tracked(stub.claim("agent-a", "fresh"));
    await held.reached();
    const b = claimed(await stub.claim("agent-b", "fresh"));
    expect((await stub.peek("agent-a")).open).toBe(true);
    expect(claimA.settled()).toBe(false);

    await held.open();
    const a = claimed(await claimA.promise);
    expect([b.target, a.target]).toEqual([
      { kind: "answer", messageId: "q1" },
      { kind: "answer", messageId: "q2" },
    ]);
  });

  it("gives the question's text and no workspace before any analysis", async () => {
    captureLogs();
    const { stub, ref } = await localSession(question("q1", "Why is this needed?"));
    const claim = await stub.claim("agent-a", "fresh");
    expect(claim).toMatchObject({
      job: {
        pr: ref,
        target: { kind: "answer", messageId: "q1" },
        workspaceSha: null,
        question: "Why is this needed?",
      },
      resumed: false,
    });
  });
});

describe("submit", () => {
  it("rejects a submit whose claim, agent or target is not the current claim's, and changes nothing", async () => {
    captureLogs();
    const session = await localSession(Q1, Q2);
    const { stub } = session;
    const claim = await stub.claim("agent-a", "fresh");
    const good = submission(claim, "agent-a");
    const before = await jobRows(stub);

    expect(await stub.submit({ ...good, claimId: crypto.randomUUID() })).toMatchObject({ error: "stale_claim" });
    expect(await stub.submit({ ...good, agentId: "agent-b" })).toMatchObject({ error: "stale_claim" });
    expect(await stub.submit({ ...good, target: { kind: "answer", messageId: "q2" } })).toEqual({
      error: "target_mismatch",
    });
    expect(await stub.submit({ ...good, target: { kind: "analysis", headSha: "a".repeat(40) } })).toEqual({
      error: "target_mismatch",
    });
    expect(await stub.submit({ ...good, jobId: crypto.randomUUID() })).toEqual({ error: "unknown_job" });

    expect(await jobRows(stub)).toEqual(before);
    expect(await answers(session)).toEqual([]);
  });

  it("answers a repeat of the submit that finished a job as a duplicate, and refuses another agent or target", async () => {
    captureLogs();
    const session = await localSession(Q1, Q2);
    const { stub } = session;
    const good = submission(await stub.claim("agent-a", "fresh"), "agent-a");
    const accepted = await stub.submit(good);
    expect(accepted).toMatchObject({ status: "accepted" });
    const done = await jobRows(stub);

    expect(await stub.submit({ ...good, agentId: "agent-b" })).toMatchObject({ error: "stale_claim" });
    expect(await stub.submit({ ...good, target: { kind: "answer", messageId: "q2" } })).toEqual({
      error: "target_mismatch",
    });
    expect(await stub.submit(good)).toEqual({ ...accepted, status: "duplicate" });
    expect(await jobRows(stub)).toEqual(done);
    expect(await answers(session)).toHaveLength(1);
  });

  it("keeps the first answer of a resubmit, sequential or queued behind the first with other text", async () => {
    captureLogs();
    const session = await localSession(Q1, Q2);
    const { stub } = session;
    const claim1 = await stub.claim("agent-a", "fresh");
    const first = await stub.submit(submission(claim1, "agent-a", "first text"));
    expect(first).toMatchObject({ status: "accepted" });
    expect(await stub.submit(submission(claim1, "agent-a", "second text"))).toEqual({
      ...first,
      status: "duplicate",
    });

    // Queued: the second submit enters the history queue while the first holds it.
    const claim2 = await stub.claim("agent-a", "fresh");
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const insert = seams.insertMessages.bind(instance);
      vi.spyOn(seams, "insertMessages").mockImplementationOnce(async (messages) => {
        await held.wait();
        return insert(messages);
      });
    });
    const one = tracked(stub.submit(submission(claim2, "agent-a", "first text")));
    await held.reached();
    const two = tracked(stub.submit(submission(claim2, "agent-a", "second text")));
    expect((await stub.view()).jobs.map((job) => job.state)).toEqual(["done", "running"]);
    expect(two.settled()).toBe(false);
    await held.open();

    const accepted = await one.promise;
    expect(accepted).toMatchObject({ status: "accepted" });
    expect(await two.promise).toEqual({ ...accepted, status: "duplicate" });
    expect((await answers(session)).map((message) => message.parts)).toEqual([
      [{ type: "text", text: "first text" }],
      [{ type: "text", text: "first text" }],
    ]);
  });

  it("stores both answers of two parallel submits, and the last list sent holds both", async () => {
    captureLogs();
    const session = await localSession(Q1, Q2);
    const { stub, client } = session;
    const claimA = await stub.claim("agent-a", "fresh");
    const claimB = await stub.claim("agent-b", "fresh");
    // A's write is held inside the SDK's save, with its list already built.
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const base: AIChatAgent<Env> = Object.getPrototypeOf(Object.getPrototypeOf(instance));
      const save = base.persistMessages.bind(instance);
      vi.spyOn(base, "persistMessages").mockImplementationOnce(async (...args) => {
        await held.wait();
        return save(...args);
      });
    });
    const a = tracked(stub.submit(submission(claimA, "agent-a", "answer A")));
    await held.reached();
    const b = tracked(stub.submit(submission(claimB, "agent-b", "answer B")));
    expect((await stub.peek("agent-a")).open).toBe(true);
    expect(b.settled()).toBe(false);
    await held.open();
    await Promise.all([a.promise, b.promise]);

    const ids = [`answer-${claimA.job?.jobId}`, `answer-${claimB.job?.jobId}`];
    await client.received(ids[1] ?? "");
    expect(
      client
        .chatLists()
        .at(-1)
        ?.map((message) => message.id),
    ).toEqual(["q1", "q2", ...ids]);
    expect((await answers(session)).map((message) => message.id)).toEqual(ids);
  });

  it("puts the job, the question, the workspace and the agent in the answer's metadata", async () => {
    captureLogs();
    const session = await localSession(Q1);
    const claim = claimed(await session.stub.claim("agent-a", "fresh"));
    await session.stub.submit({ ...claim, agentId: "agent-a", text: "the answer" });
    expect(await answers(session)).toEqual([
      {
        id: `answer-${claim.jobId}`,
        role: "assistant",
        metadata: {
          kind: "answer",
          jobId: claim.jobId,
          questionId: "q1",
          sha: null,
          by: { kind: "local", agentId: "agent-a" },
        },
        parts: [{ type: "text", text: "the answer" }],
      },
    ]);
  });

  it("fails a submit whose conversation does not settle, reserving nothing", async () => {
    captureLogs();
    const session = await localSession(Q1);
    const { stub } = session;
    const claim = await stub.claim("agent-a", "fresh");
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "waitUntilStable").mockResolvedValueOnce(false);
    });
    expect(await stub.submit(submission(claim, "agent-a"))).toEqual({ error: "internal" });
    expect((await jobOf(stub, "q1")).state).toBe("claimed");
    expect(await stub.submit(submission(claim, "agent-a"))).toMatchObject({ status: "accepted" });
  });

  it("returns the job to its claim when the append fails, so a resubmit can try again", async () => {
    captureLogs();
    const session = await localSession(Q1);
    const { stub } = session;
    const claim = await stub.claim("agent-a", "fresh");
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "insertMessages").mockRejectedValueOnce(new Error("storage failed"));
    });
    expect(await stub.submit(submission(claim, "agent-a"))).toEqual({ error: "internal" });
    expect((await jobOf(stub, "q1")).state).toBe("claimed");
    expect(await stub.submit(submission(claim, "agent-a"))).toMatchObject({ status: "accepted" });
    expect(await answers(session)).toHaveLength(1);
  });
});

describe("submit against retry and resume", () => {
  it("rejects a submit held before its reservation once a retry and a new claim replaced it", async () => {
    captureLogs();
    const session = await localSession(Q1);
    const { stub } = session;
    const claimA = await stub.claim("agent-a", "fresh");
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const stable = seams.waitUntilStable.bind(instance);
      vi.spyOn(seams, "waitUntilStable").mockImplementationOnce(async (options) => {
        await held.wait();
        return stable(options);
      });
    });
    const a = tracked(stub.submit(submission(claimA, "agent-a", "answer A")));
    await held.reached();
    expect(await stub.retryJob(claimA.job?.jobId ?? "")).toEqual({ status: "retried" });
    const claimB = await stub.claim("agent-b", "fresh");
    expect(a.settled()).toBe(false);
    await held.open();

    expect(await a.promise).toMatchObject({ error: "stale_claim" });
    expect(await stub.submit(submission(claimB, "agent-b", "answer B"))).toMatchObject({ status: "accepted" });
    expect((await answers(session)).map((message) => message.parts)).toEqual([[{ type: "text", text: "answer B" }]]);
  });

  it("refuses a retry and a resume once a submit has reserved the job, and the submit finishes", async () => {
    captureLogs();
    const session = await localSession(Q1);
    const { stub } = session;
    const claimA = await stub.claim("agent-a", "fresh");
    const jobId = claimA.job?.jobId ?? "";
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const insert = seams.insertMessages.bind(instance);
      vi.spyOn(seams, "insertMessages").mockImplementationOnce(async (messages) => {
        await held.wait();
        return insert(messages);
      });
    });
    const a = tracked(stub.submit(submission(claimA, "agent-a", "answer A")));
    await held.reached();
    expect(await stub.retryJob(jobId)).toMatchObject({ error: "not_retryable" });
    expect(await stub.claim("agent-a", "resume")).toEqual({ job: null });
    const settling = tracked(stub.settle());
    expect((await stub.view()).jobs).toMatchObject([{ jobId, state: "running" }]);
    expect(a.settled()).toBe(false);
    await held.open();

    expect(await a.promise).toMatchObject({ status: "accepted" });
    await settling.promise;
    expect((await stub.view()).jobs).toMatchObject([{ jobId, state: "done" }]);
    expect((await answers(session)).map((message) => message.parts)).toEqual([[{ type: "text", text: "answer A" }]]);
  });
});

async function lostDuringSubmit(where: "after" | "before") {
  captureLogs();
  const session = await localSession(Q1);
  const { stub } = session;
  const claim = await stub.claim("agent-a", "fresh");
  const held = await gate(stub);
  await runInDurableObject(stub, (instance) => {
    const seams = prSessionSeams(instance);
    const insert = seams.insertMessages.bind(instance);
    vi.spyOn(seams, "insertMessages").mockImplementationOnce(async (messages) => {
      if (where === "after") {
        await insert(messages);
      }
      await held.wait();
    });
  });
  const lost = stub.submit(submission(claim, "agent-a")).catch((error: unknown) => error);
  await held.reached();
  await abortAllDurableObjects();
  await lost;
  // Stubs made before the loss are broken; a new one starts a fresh instance on the same storage.
  return { session: { ...session, stub: await prSessionStub(env, session.ref) }, claim };
}

describe("instance loss", () => {
  it("finishes a job whose answer was stored before the loss: done, and a resubmit is a duplicate", async () => {
    const { session, claim } = await lostDuringSubmit("after");
    expect(await session.stub.submit(submission(claim, "agent-a"))).toMatchObject({ status: "duplicate" });
    expect((await jobOf(session.stub, "q1")).state).toBe("done");
    expect(await answers(session)).toHaveLength(1);
  });

  it("returns a job whose answer was not stored to its claim, and a resubmit is accepted", async () => {
    const { session, claim } = await lostDuringSubmit("before");
    expect((await jobOf(session.stub, "q1")).state).toBe("claimed");
    expect(await session.stub.submit(submission(claim, "agent-a"))).toMatchObject({ status: "accepted" });
    expect(await answers(session)).toHaveLength(1);
  });
});

describe("retry", () => {
  it("puts a claimed job back to pending; the earlier claimId is rejected even after the job completes", async () => {
    captureLogs();
    const session = await localSession(Q1, Q2);
    const { stub } = session;
    // The same agent claims again after a retry: only the new claimId is its claim.
    const firstA = await stub.claim("agent-a", "fresh");
    expect(await stub.retryJob(claimed(firstA).jobId)).toEqual({ status: "retried" });
    const againA = await stub.claim("agent-a", "fresh");
    expect(claimed(againA).jobId).toBe(claimed(firstA).jobId);
    expect(await stub.submit(submission(firstA, "agent-a"))).toMatchObject({ error: "stale_claim" });
    expect(await stub.submit(submission(againA, "agent-a"))).toMatchObject({ status: "accepted" });
    expect(await stub.submit(submission(firstA, "agent-a"))).toMatchObject({ error: "stale_claim" });

    // Another agent claims after a retry.
    const claimA = await stub.claim("agent-a", "fresh");
    const jobId = claimA.job?.jobId ?? "";
    expect(await stub.retryJob(jobId)).toEqual({ status: "retried" });
    expect((await jobOf(stub, "q2")).state).toBe("pending");
    const claimB = await stub.claim("agent-b", "fresh");
    expect(claimed(claimB)).toMatchObject({ jobId, resumed: false });
    expect(claimed(claimB).claimId).not.toBe(claimed(claimA).claimId);
    expect(await stub.submit(submission(claimA, "agent-a"))).toMatchObject({ error: "stale_claim" });
    expect(await stub.submit(submission(claimB, "agent-b"))).toMatchObject({ status: "accepted" });
    expect(await stub.submit(submission(claimA, "agent-a"))).toMatchObject({ error: "stale_claim" });
    expect(await answers(session)).toHaveLength(2);
  });

  it("refuses a retry whose job changed while its wake was being armed", async () => {
    captureLogs();
    const { stub } = await localSession(Q1);
    const jobId = (await jobOf(stub, "q1")).job_id;
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'failed' WHERE job_id = ?", jobId);
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const schedule = instance.schedule.bind(instance);
      vi.spyOn(instance, "schedule").mockImplementationOnce(async (...args) => {
        await held.wait();
        return schedule(...args);
      });
    });
    const first = tracked(stub.retryJob(jobId));
    await held.reached();
    expect(await stub.retryJob(jobId)).toEqual({ status: "retried" });
    expect(first.settled()).toBe(false);
    await held.open();
    expect(await first.promise).toEqual({ error: "not_retryable", detail: "the job changed state" });
    expect((await jobOf(stub, "q1")).state).toBe("pending");
  });

  it("retries a failed job, and refuses pending, running, done and unknown jobs", async () => {
    captureLogs();
    const { stub } = await localSession(Q1);
    const jobId = (await jobOf(stub, "q1")).job_id;
    expect(await stub.retryJob(jobId)).toMatchObject({ error: "not_retryable" });
    for (const state of ["finalizing", "running", "done"]) {
      await sessionSql(stub, "UPDATE prq_jobs SET state = ? WHERE job_id = ?", state, jobId);
      expect(await stub.retryJob(jobId)).toMatchObject({ error: "not_retryable" });
    }
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'failed', failure = 'it broke' WHERE job_id = ?", jobId);
    expect(await stub.retryJob(jobId)).toEqual({ status: "retried" });
    expect(await jobOf(stub, "q1")).toMatchObject({ state: "pending", failure: null });
    expect(await stub.retryJob(crypto.randomUUID())).toEqual({ error: "unknown_job" });
  });
});

function jobEvents(logs: LogEntry[]) {
  return logs
    .map((log) => log.entry)
    .filter((entry) => String(entry["event"]).startsWith("prq.job."))
    .map(({ event, from, to }) => ({ event, from, to }));
}

describe("logs", () => {
  it("logs each operation with the session, the job and the change, and no message text", async () => {
    const logs = captureLogs();
    const { stub, name } = await localSession(question("q1", "secret question"));
    const claimA = await stub.claim("agent-a", "fresh");
    await stub.claim("agent-a", "resume");
    await stub.retryJob(claimA.job?.jobId ?? "");
    const claimB = await stub.claim("agent-b", "fresh");
    await stub.submit(submission(claimB, "agent-b", "secret answer"));
    await stub.submit(submission(claimB, "agent-b", "secret answer"));
    await stub.submit(submission(claimA, "agent-a", "secret answer"));

    expect(jobEvents(logs)).toEqual([
      { event: "prq.job.created", from: undefined, to: "pending" },
      { event: "prq.job.claimed", from: "pending", to: "claimed" },
      { event: "prq.job.resumed", from: "claimed", to: "claimed" },
      { event: "prq.job.retried", from: "claimed", to: "pending" },
      { event: "prq.job.claimed", from: "pending", to: "claimed" },
      { event: "prq.job.submitted", from: "finalizing", to: "done" },
      { event: "prq.job.duplicate", from: undefined, to: undefined },
      { event: "prq.job.rejected", from: undefined, to: undefined },
    ]);
    const jobId = claimA.job?.jobId;
    for (const entry of logs.map((log) => log.entry).filter((e) => String(e["event"]).startsWith("prq.job."))) {
      expect(entry).toMatchObject({ pr: name, jobId });
    }
    expect(JSON.stringify(logs)).not.toMatch(/secret/);
  });
});
