import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRESENCE_MS } from "./hub.ts";
import type { PrSession } from "./pr-session/index.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import {
  claimIn,
  clearQueue,
  gate,
  holdClaim,
  hub,
  hubClaim,
  hubSeams,
  jobRows,
  newSession,
  NO_DEADLINE,
  queued,
  sessionSql,
  setPool,
  submission,
  tracked,
} from "./test/session.ts";

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

const Q1 = question("q1");

async function localSessionWithJob() {
  await setPool(["laptop"]);
  const session = await newSession("hub", sockets);
  const client = await session.open();
  await client.chat([Q1]);
  const [job] = (await session.stub.view()).jobs;
  if (job === undefined) {
    throw new Error("no job");
  }
  return { ...session, jobId: job.jobId };
}

// The Hub's counter, which numbers claim attempts.
async function hubCounter(): Promise<number> {
  return runInDurableObject(
    await hub(),
    (_, state) => state.storage.sql.exec<{ gen: number }>("SELECT gen FROM prq_hub WHERE id = 1").one().gen,
  );
}

async function notificationGen(name: string): Promise<number | undefined> {
  return runInDurableObject(
    await hub(),
    (_, state) =>
      state.storage.sql.exec<{ gen: number }>("SELECT gen FROM prq_notifications WHERE session = ?", name).toArray()[0]
        ?.gen,
  );
}

// Holds the Hub's next peek after the session answered it, before the Hub acts on the answer. The Hub calls its peek
// itself, so a spy on the instance sees it.
async function holdPeekAfterAnswer() {
  const held = await gate(await hub());
  await runInDurableObject(await hub(), (instance) => {
    const seams = hubSeams(instance);
    const peek = seams.peekSession.bind(instance);
    vi.spyOn(seams, "peekSession").mockImplementationOnce(async (...args) => {
      const answer = await peek(...args);
      await held.wait();
      return answer;
    });
  });
  return held;
}

// Makes the Hub's peeks of one session fail.
async function unreachablePeek(name: string) {
  await runInDurableObject(await hub(), (instance) => {
    const seams = hubSeams(instance);
    const peek = seams.peekSession.bind(instance);
    vi.spyOn(seams, "peekSession").mockImplementation(async (session, agentId) => {
      if (session === name) {
        throw new Error("session unreachable");
      }
      return peek(session, agentId);
    });
  });
}

// Makes the Hub's claims in one session fail.
async function unreachableClaim(name: string) {
  await runInDurableObject(await hub(), (instance) => {
    const seams = hubSeams(instance);
    const claim = seams.claimSession.bind(instance);
    vi.spyOn(seams, "claimSession").mockImplementation(async (...args) => {
      if (args[0] === name) {
        throw new Error("session unreachable");
      }
      return claim(...args);
    });
  });
}

// holdClaim, and the Hub stops waiting for the held call at once (its bound on a session call is made 1 ms for that
// call only).
async function holdLateClaim(stub: DurableObjectStub<PrSession>, pass: number) {
  const held = await holdClaim(stub, pass);
  await runInDurableObject(await hub(), (instance) => {
    const seams = hubSeams(instance);
    const bound = seams.sessionCallMs.bind(instance);
    const spy = vi.spyOn(seams, "sessionCallMs");
    for (let call = 0; call < pass; call += 1) {
      spy.mockImplementationOnce(bound);
    }
    spy.mockReturnValueOnce(1);
  });
  return held;
}

describe("presence", () => {
  it("counts an agent present until PRESENCE_MS after its last contact; a claim is a contact", async () => {
    captureLogs();
    await setPool([]);
    const stub = await hub();
    expect(await stub.isLocalPresent()).toBe(false);
    await hubClaim("laptop");
    expect(await stub.isLocalPresent()).toBe(true);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("UPDATE prq_agents SET last_seen_at = ?", Date.now() - PRESENCE_MS + 1000);
    });
    expect(await stub.isLocalPresent()).toBe(true);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("UPDATE prq_agents SET last_seen_at = ?", Date.now() - PRESENCE_MS);
    });
    expect(await stub.isLocalPresent()).toBe(false);
  });
});

describe("notification queue", () => {
  it("queues a canonical session name only", async () => {
    const logs = captureLogs();
    const stub = await hub();
    await stub.notify("octo~queue~1");
    expect(await queued()).toContain("octo~queue~1");
    await stub.notify("Octo~queue~1");
    expect(await queued()).not.toContain("Octo~queue~1");
    expect(logs.some((log) => log.entry["event"] === "prq.hub.notify_refused")).toBe(true);
  });
});

describe("claim fan-out", () => {
  it("resumes the agent's own job in any session before a pending job in another", async () => {
    captureLogs();
    const first = await localSessionWithJob();
    const second = await localSessionWithJob();

    const claimed = await claimIn(second.stub, "laptop", "fresh");
    const resumed = await hubClaim("laptop");
    expect(resumed).toMatchObject({ job: { jobId: claimed.job?.jobId }, resumed: true });
    expect(resumed.job === null ? null : resumed.claimId).not.toBe(claimed.job === null ? null : claimed.claimId);

    expect(await hubClaim("desktop")).toMatchObject({ job: { jobId: first.jobId }, resumed: false });
    expect(await hubClaim("other")).toEqual({ job: null });
  });

  it("skips a session it cannot reach and keeps it queued", async () => {
    const logs = captureLogs();
    const unreachableSession = await localSessionWithJob();
    const reachable = await localSessionWithJob();
    await unreachableClaim(unreachableSession.name);
    expect(await hubClaim("laptop")).toMatchObject({ job: { jobId: reachable.jobId } });
    expect(await queued()).toContain(unreachableSession.name);
    expect(logs.some((log) => log.entry["event"] === "prq.hub.session_failed")).toBe(true);
  });
});

describe("late claims", () => {
  it("lets no resume that lands after a newer claim replace that claim", async () => {
    captureLogs();
    const { stub, jobId } = await localSessionWithJob();
    await claimIn(stub, "laptop", "fresh");
    // The Hub's resume in the session is held there, and the Hub stops waiting for it.
    const held = await holdLateClaim(stub, 0);
    expect(await hubClaim("laptop")).toEqual({ job: null });
    await held.reached();
    expect((await stub.view()).jobs).toMatchObject([{ jobId, state: "claimed" }]);

    const next = await hubClaim("laptop");
    expect(next).toMatchObject({ job: { jobId }, resumed: true });
    await held.open();
    // The late resume has run; the job keeps the newer claim.
    expect((await jobRows(stub))[0]?.claim_id).toBe(next.job === null ? null : next.claimId);
    expect(await stub.submit(submission(next, "laptop"))).toMatchObject({ status: "accepted" });
  });

  it("lets no fresh claim that lands after a newer claim take another job", async () => {
    captureLogs();
    const session = await localSessionWithJob();
    const { stub, open } = session;
    await (await open()).chat([Q1, question("q2")]);
    // The Hub's resume in the session goes on (there is nothing to resume); its fresh claim is held there.
    const held = await holdLateClaim(stub, 1);
    expect(await hubClaim("laptop")).toEqual({ job: null });
    await held.reached();
    expect((await stub.view()).jobs.map((job) => job.state)).toEqual(["pending", "pending"]);

    expect(await hubClaim("laptop")).toMatchObject({ job: { jobId: session.jobId }, resumed: false });
    await held.open();
    // The late claim has run and took nothing: Q2 still waits for any agent.
    expect((await jobRows(stub)).map((job) => [job.target, job.state, job.agent_id])).toEqual([
      ["q1", "claimed", "laptop"],
      ["q2", "pending", null],
    ]);
  });
  it("refuses a claim past its deadline before it numbers an attempt or asks a session", async () => {
    const logs = captureLogs();
    const { stub, jobId } = await localSessionWithJob();
    let asked = 0;
    await runInDurableObject(await hub(), (instance) => {
      const seams = hubSeams(instance);
      const claim = seams.claimSession.bind(instance);
      vi.spyOn(seams, "claimSession").mockImplementation(async (...args) => {
        asked += 1;
        return claim(...args);
      });
    });
    const before = await hubCounter();
    expect(await (await hub()).claim("laptop", Date.now() - 1)).toEqual({
      error: "unavailable",
      detail: "the call arrived after its deadline",
    });
    expect({ asked, counter: await hubCounter() }).toEqual({ asked: 0, counter: before });
    expect((await stub.view()).jobs).toMatchObject([{ jobId, state: "pending" }]);
    expect(logs.map((log) => log.entry)).toContainEqual(
      expect.objectContaining({ event: "prq.request.late", call: "claim" }),
    );
  });
});

describe("late claims after a retry", () => {
  it("lets no fresh claim held past a newer claim and a retry take the retried job", async () => {
    captureLogs();
    const { stub, jobId } = await localSessionWithJob();
    // Attempt 10's fresh claim is held in the session before it chooses a job.
    const held = await holdClaim(stub);
    const late = tracked(stub.claim("laptop", "fresh", 10, NO_DEADLINE));
    await held.reached();
    // Attempt 11 claims the job, and the host retries it.
    expect(await stub.claim("laptop", "fresh", 11, NO_DEADLINE)).toMatchObject({ job: { jobId } });
    expect(await stub.retryJob(jobId, NO_DEADLINE)).toEqual({ status: "retried" });
    expect(late.settled()).toBe(false);

    await held.open();
    expect(await late.promise).toEqual({ job: null });
    expect((await stub.view()).jobs).toMatchObject([{ jobId, state: "pending", agentId: null }]);
    // A newer attempt of the agent still claims it.
    expect(await stub.claim("laptop", "fresh", 12, NO_DEADLINE)).toMatchObject({ job: { jobId } });
  });
});

describe("a session that is slow to start", () => {
  it("bounds a call to it, its start included, and keeps it queued", async () => {
    const logs = captureLogs();
    const { name, stub } = await localSessionWithJob();
    const held = await gate(await hub());
    await runInDurableObject(await hub(), (instance) => {
      const seams = hubSeams(instance);
      const start = seams.sessionStub.bind(instance);
      vi.spyOn(seams, "sessionStub").mockImplementation(async (session) => {
        await held.wait();
        return start(session);
      });
      vi.spyOn(seams, "sessionCallMs").mockReturnValue(1);
    });

    // Both calls end while the session's start is still held.
    expect(await hubClaim("laptop")).toEqual({ job: null });
    expect(await (await hub()).hasWork("laptop")).toBe(false);
    expect(held.isReached()).toBe(true);
    expect(await (await hub()).isLocalPresent()).toBe(true);
    expect(await queued()).toContain(name);
    const failed = logs.map((log) => log.entry).filter((entry) => entry["event"] === "prq.hub.session_failed");
    expect(failed.map((entry) => [entry["call"], entry["error"]])).toEqual([
      ["claim", "WaitTimeout"],
      ["claim", "WaitTimeout"],
      ["peek", "WaitTimeout"],
    ]);

    // Let go, the claim the Hub stopped waiting for still lands: the job is the agent's to resume.
    await held.open();
    await vi.waitFor(async () => expect((await jobRows(stub))[0]?.agent_id).toBe("laptop"), { timeout: 3000 });
  });
});

describe("notify during peek", () => {
  it("keeps a session queued when it was notified while a check found nothing open", async () => {
    captureLogs();
    const { stub, name, jobId } = await localSessionWithJob();
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'failed' WHERE job_id = ?", jobId);
    const before = await notificationGen(name);
    const held = await holdPeekAfterAnswer();
    const check = tracked((await hub()).hasWork("laptop"));
    await held.reached();
    // The job is retried: the session notifies the Hub during the check.
    expect(await stub.retryJob(jobId, NO_DEADLINE)).toEqual({ status: "retried" });
    expect(await notificationGen(name)).toBeGreaterThan(before ?? 0);
    expect(check.settled()).toBe(false);
    await held.open();
    // The check reports what it saw; the row stays, so the next check finds the job.
    expect(await check.promise).toBe(false);
    expect(await queued()).toContain(name);
    expect(await (await hub()).hasWork("laptop")).toBe(true);
  });

  it("keeps a row deleted and written again during an older check", async () => {
    captureLogs();
    const { stub, name, jobId } = await localSessionWithJob();
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'failed' WHERE job_id = ?", jobId);
    const held = await holdPeekAfterAnswer();
    const older = tracked((await hub()).hasWork("laptop"));
    await held.reached();
    // A newer check finds nothing open and deletes the row; a retry writes it again.
    expect(await (await hub()).hasWork("laptop")).toBe(false);
    expect(await queued()).not.toContain(name);
    expect(await stub.retryJob(jobId, NO_DEADLINE)).toEqual({ status: "retried" });
    expect(await queued()).toContain(name);
    expect(older.settled()).toBe(false);
    await held.open();
    await older.promise;
    expect(await queued()).toContain(name);
  });

  it("drops a session with nothing open, and keeps one it cannot reach", async () => {
    const logs = captureLogs();
    const done = await localSessionWithJob();
    await sessionSql(done.stub, "UPDATE prq_jobs SET state = 'done'");
    const unreachableSession = await localSessionWithJob();
    await unreachablePeek(unreachableSession.name);
    await (await hub()).hasWork("laptop");
    const names = await queued();
    expect(names).not.toContain(done.name);
    expect(names).toContain(unreachableSession.name);
    expect(logs.some((log) => log.entry["call"] === "peek")).toBe(true);
  });
});

describe("cloud sessions", () => {
  it("exposes nothing to peek or claim", async () => {
    captureLogs();
    await setPool([]);
    const { stub, name, open } = await newSession("hub", sockets);
    const client = await open();
    await client.chat([Q1]);
    expect((await stub.view()).owner).toBe("cloud");
    // Even a waiting job (as #5's cloud agent leaves one) is not offered to a local agent.
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'pending'");
    await (await hub()).notify(name);

    expect(await stub.peek("laptop")).toEqual({ resume: false, fresh: false, open: false });
    expect(await claimIn(stub, "laptop", "fresh")).toEqual({ job: null });
    expect(await (await hub()).hasWork("laptop")).toBe(false);
    expect(await hubClaim("laptop")).toEqual({ job: null });
  });
});
