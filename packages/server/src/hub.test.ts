import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRESENCE_MS } from "./hub.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import { clearQueue, gate, hub, hubSeams, newSession, queued, sessionSql, setPool, tracked } from "./test/session.ts";

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
    vi.spyOn(seams, "claimSession").mockImplementation(async (session, agentId, mode) => {
      if (session === name) {
        throw new Error("session unreachable");
      }
      return claim(session, agentId, mode);
    });
  });
}

describe("presence", () => {
  it("counts an agent present until PRESENCE_MS after its last contact; a claim is a contact", async () => {
    captureLogs();
    await setPool([]);
    const stub = await hub();
    expect(await stub.isLocalPresent()).toBe(false);
    await stub.claim("laptop");
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
    const stub = await hub();

    const claimed = await second.stub.claim("laptop", "fresh");
    const resumed = await stub.claim("laptop");
    expect(resumed).toMatchObject({ job: { jobId: claimed.job?.jobId }, resumed: true });
    expect(resumed.job === null ? null : resumed.claimId).not.toBe(claimed.job === null ? null : claimed.claimId);

    expect(await stub.claim("desktop")).toMatchObject({ job: { jobId: first.jobId }, resumed: false });
    expect(await stub.claim("other")).toEqual({ job: null });
  });

  it("skips a session it cannot reach and keeps it queued", async () => {
    const logs = captureLogs();
    const unreachableSession = await localSessionWithJob();
    const reachable = await localSessionWithJob();
    await unreachableClaim(unreachableSession.name);
    expect(await (await hub()).claim("laptop")).toMatchObject({ job: { jobId: reachable.jobId } });
    expect(await queued()).toContain(unreachableSession.name);
    expect(logs.some((log) => log.entry["event"] === "prq.hub.session_failed")).toBe(true);
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
    expect(await stub.retryJob(jobId)).toEqual({ status: "retried" });
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
    expect(await stub.retryJob(jobId)).toEqual({ status: "retried" });
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
    expect(await stub.claim("laptop", "fresh")).toEqual({ job: null });
    expect(await (await hub()).hasWork("laptop")).toBe(false);
    expect(await (await hub()).claim("laptop")).toEqual({ job: null });
  });
});
