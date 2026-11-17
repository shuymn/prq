import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STALL_MS } from "./ledger.ts";
import type { PrSession } from "./pr-session/index.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import { localSession } from "./test/cli.ts";
import {
  cancelWakes,
  claimIn,
  clearQueue,
  hub,
  jobRows,
  ledgerRowOf,
  retryIn,
  sessionSql,
  submission,
} from "./test/session.ts";

const sockets: AgentSocket[] = [];

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

type ClaimAged = { time: number; payload: unknown };

// The session's claimAged checks: the second each is due and the claim it is for.
async function checks(stub: DurableObjectStub<PrSession>): Promise<ClaimAged[]> {
  return runInDurableObject(stub, async (instance) =>
    (await instance.listSchedules())
      .filter((schedule) => schedule.callback === "claimAged")
      .map(({ time, payload }) => ({ time, payload })),
  );
}

async function problemOf(name: string): Promise<string | null | undefined> {
  return (await ledgerRowOf(name))?.problem;
}

async function ledgerRev(name: string): Promise<number | undefined> {
  return runInDurableObject(
    await hub(),
    (_, state) =>
      state.storage.sql.exec<{ rev: number }>("SELECT rev FROM prq_ledger WHERE session = ?", name).toArray()[0]?.rev,
  );
}

async function scheduleCount(stub: DurableObjectStub<PrSession>): Promise<number> {
  return runInDurableObject(stub, async (instance) => (await instance.listSchedules()).length);
}

// The session's ledger outbox rows: a revision written and not yet delivered.
async function ledgerOutbox(stub: DurableObjectStub<PrSession>): Promise<number> {
  return runInDurableObject(
    stub,
    (_, state) =>
      state.storage.sql.exec<{ rows: number }>("SELECT count(*) AS rows FROM prq_outbox WHERE kind = 'ledger'").one()
        .rows,
  );
}

// A local session with Q1's job claimed by laptop.
async function claimed() {
  const session = await localSession("alarm", sockets, Q1);
  const claim = await claimIn(session.stub, "laptop", "fresh");
  if (claim.job === null) {
    throw new Error("nothing was claimed");
  }
  return { ...session, claim, payload: { jobId: claim.job.jobId, claimId: claim.claimId } };
}

// Waits in real time until Date.now() reaches `at` (alarms run at whole seconds).
async function reach(at: number): Promise<void> {
  while (Date.now() < at) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("claimAged", () => {
  it("is scheduled at every claim and resume, at the first whole second at or after the claim's deadline", async () => {
    captureLogs();
    const { stub, claim, payload } = await claimed();
    const [row] = await jobRows(stub);
    expect(await checks(stub)).toEqual([{ time: Math.ceil(((row?.claimed_at ?? 0) + STALL_MS) / 1000), payload }]);

    const resumed = await claimIn(stub, "laptop", "resume");
    expect(resumed).toMatchObject({ resumed: true, job: { jobId: claim.job.jobId } });
    const [again] = await jobRows(stub);
    expect(await checks(stub)).toContainEqual({
      time: Math.ceil(((again?.claimed_at ?? 0) + STALL_MS) / 1000),
      payload: { jobId: claim.job.jobId, claimId: resumed.job === null ? null : resumed.claimId },
    });
  });

  it("marks the claim possibly stalled when it runs after the deadline, and schedules itself again when it runs before", async () => {
    const logs = captureLogs();
    const { stub, name, payload } = await claimed();
    expect(await problemOf(name)).toBeNull();
    // The deadline is a moment ahead, at a time with a millisecond part; the check is armed again for it.
    const deadline = (Math.floor(Date.now() / 1000) + 1) * 1000 + 600;
    await sessionSql(stub, "UPDATE prq_jobs SET claimed_at = ?", deadline - STALL_MS);
    await cancelWakes(stub);
    await stub.settle();
    const due = Math.ceil(deadline / 1000);
    expect(await checks(stub)).toEqual([{ time: due, payload }]);

    // Run before the deadline: no mark, and a new check for the same second.
    await cancelWakes(stub);
    await runInDurableObject(stub, (instance) => instance.claimAged(payload));
    expect(await checks(stub)).toEqual([{ time: due, payload }]);
    expect(await problemOf(name)).toBeNull();
    expect((await stub.view()).jobs[0]?.stalled).toBe(false);

    await reach(due * 1000);
    await runDurableObjectAlarm(stub);
    await vi.waitFor(async () => expect(await problemOf(name)).toBe("possibly_stalled"), { timeout: 3000 });
    expect((await stub.view()).jobs[0]?.stalled).toBe(true);
    expect(logs.some((log) => log.entry["event"] === "prq.job.stalled")).toBe(true);
    expect(await checks(stub)).toEqual([]);
  }, 10_000);

  it("changes nothing for a claim that has ended", async () => {
    const logs = captureLogs();
    const { stub, name, payload } = await claimed();
    await sessionSql(stub, "UPDATE prq_jobs SET claimed_at = ?", Date.now() - STALL_MS - 1000);
    await retryIn(stub, payload.jobId);
    const rev = await ledgerRev(name);
    const view = await stub.view();
    await cancelWakes(stub);

    await runInDurableObject(stub, (instance) => instance.claimAged(payload));
    expect(await ledgerRev(name)).toBe(rev);
    expect(await stub.view()).toEqual(view);
    expect(await checks(stub)).toEqual([]);
    expect(await problemOf(name)).not.toBe("possibly_stalled");
    expect(logs.some((log) => log.entry["event"] === "prq.job.stalled")).toBe(false);
  });

  it("changes nothing, before its deadline, for a claim a resume replaced or a submit completed", async () => {
    captureLogs();
    const { stub, name, payload } = await claimed();
    // What a check for an ended claim must leave as it is: the ledger's row and the session's checks.
    const unchanged = async (check: { jobId: string; claimId: string }) => {
      const before = { rev: await ledgerRev(name), checks: await checks(stub) };
      await runInDurableObject(stub, (instance) => instance.claimAged(check));
      expect({ rev: await ledgerRev(name), checks: await checks(stub) }).toEqual(before);
    };
    // The resume holds the job under a new claim, which has its own check.
    const resumed = await claimIn(stub, "laptop", "resume");
    if (resumed.job === null) {
      throw new Error("nothing was resumed");
    }
    expect(resumed.job.jobId).toBe(payload.jobId);
    await unchanged(payload);
    // The submit completes the job under the resumed claim, which it keeps.
    expect(await stub.submit(submission(resumed, "laptop"))).not.toHaveProperty("error");
    expect((await jobRows(stub)).find((row) => row.job_id === payload.jobId)).toMatchObject({
      state: "done",
      claim_id: resumed.claimId,
    });
    await unchanged({ jobId: payload.jobId, claimId: resumed.claimId });
  });

  it("leaves a stall whose check was lost to settle, which publishes it once; a second settle does nothing", async () => {
    const logs = captureLogs();
    const { stub, name, payload } = await claimed();
    await cancelWakes(stub);
    await sessionSql(stub, "UPDATE prq_jobs SET claimed_at = ?", Date.now() - STALL_MS - 1000);
    expect(await problemOf(name)).toBeNull();
    const stalls = () => logs.filter((log) => log.entry["event"] === "prq.job.stalled").length;

    await stub.settle();
    expect((await stub.view()).jobs[0]?.stalled).toBe(true);
    expect(await problemOf(name)).toBe("possibly_stalled");
    expect(stalls()).toBe(1);
    const rev = await ledgerRev(name);
    const schedules = await scheduleCount(stub);

    await stub.settle();
    await runInDurableObject(stub, (instance) => instance.claimAged(payload));
    expect(await ledgerRev(name)).toBe(rev);
    expect(await ledgerOutbox(stub)).toBe(0);
    expect(await scheduleCount(stub)).toBe(schedules);
    expect(await checks(stub)).toEqual([]);
    expect(stalls()).toBe(1);
  });

  it("is armed by settle when the claim's own schedule failed", async () => {
    const logs = captureLogs();
    const session = await localSession("alarm", sockets, Q1);
    await runInDurableObject(session.stub, (instance) => {
      const schedule = instance.schedule.bind(instance);
      let failed = false;
      vi.spyOn(instance, "schedule").mockImplementation(async (...args) => {
        if (args[1] === "claimAged" && !failed) {
          failed = true;
          throw new Error("storage failed");
        }
        return schedule(...args);
      });
    });
    const claim = await claimIn(session.stub, "laptop", "fresh");
    expect(claim.job).not.toBeNull();
    expect(logs.some((log) => log.entry["event"] === "prq.settle.failed" && log.entry["step"] === "claim_aged")).toBe(
      true,
    );
    expect(await checks(session.stub)).toEqual([]);

    await session.stub.settle();
    expect(await checks(session.stub)).toHaveLength(1);
  });
});
