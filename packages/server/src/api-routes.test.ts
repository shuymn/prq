import { ErrorResponse } from "@prq/protocol";
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROUTE_CALL_MS } from "./http.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import {
  claimOver,
  fetchBounded,
  heldBound,
  localSession,
  post,
  postRequest,
  retryOver,
  retryPath,
} from "./test/cli.ts";
import {
  claimIn,
  clearQueue,
  gate,
  jobOf,
  prSessionSeams,
  revOf,
  sessionSql,
  tracked,
  within,
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

async function outcome(response: Promise<Response>): Promise<{ status: number; body: unknown }> {
  const res = await response;
  return { status: res.status, body: await res.json() };
}

async function errorOf(response: Promise<Response> | Response): Promise<{ status: number; error: string }> {
  const res = await response;
  return { status: res.status, error: v.parse(ErrorResponse, await res.json()).error };
}

async function sessionCount(): Promise<number> {
  return (await listDurableObjectIds(env.PrSession)).length;
}

describe("retry", () => {
  it("retries a claimed or a failed job, and refuses one in any other state with 409", async () => {
    captureLogs();
    const session = await localSession("api", sockets, question("q1"), question("q2"));
    const { stub, ref, token } = session;
    const claimed = await jobOf(stub, "q1");
    await claimIn(stub, "laptop", "fresh");
    const failed = await jobOf(stub, "q2");
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'failed', failure = 'gone' WHERE job_id = ?", failed.job_id);

    const retried = { status: 200, body: { status: "retried" } };
    expect(await outcome(retryOver(token, ref, claimed.job_id, await revOf(stub, claimed.job_id)))).toEqual(retried);
    expect(await outcome(retryOver(token, ref, failed.job_id, await revOf(stub, failed.job_id)))).toEqual(retried);
    expect((await stub.view()).jobs.map((job) => job.state)).toEqual(["pending", "pending"]);

    // Both are pending now; then one is done and one is being finalized.
    const refused = { status: 409, error: "not_retryable" };
    const retryNow = async (jobId: string) => errorOf(retryOver(token, ref, jobId, await revOf(stub, jobId)));
    expect(await retryNow(claimed.job_id)).toEqual(refused);
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'done' WHERE job_id = ?", claimed.job_id);
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'finalizing' WHERE job_id = ?", failed.job_id);
    expect(await retryNow(claimed.job_id)).toEqual(refused);
    expect(await retryNow(failed.job_id)).toEqual(refused);
  });

  it("answers 409 stale_job to a retry from a view the job has changed since, and changes nothing", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("api", sockets, question("q1"));
    await claimIn(stub, "laptop", "fresh");
    const job = await jobOf(stub, "q1");
    const seen = await revOf(stub, job.job_id);
    // The agent resumes the job after the view: still claimed, under another claim.
    const resumed = await claimIn(stub, "laptop", "resume");
    expect(await errorOf(retryOver(token, ref, job.job_id, seen))).toEqual({ status: 409, error: "stale_job" });
    expect(await jobOf(stub, "q1")).toMatchObject({
      state: "claimed",
      claim_id: resumed.job === null ? null : resumed.claimId,
    });
  });

  it("answers 404 for a job the session does not have", async () => {
    captureLogs();
    const { ref, token } = await localSession("api", sockets, question("q1"));
    expect(await errorOf(retryOver(token, ref, crypto.randomUUID(), 0))).toEqual({ status: 404, error: "unknown_job" });
  });

  it("reaches the canonical session for any case of owner and repository, creating no other", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("api", sockets, question("q1"));
    await claimIn(stub, "laptop", "fresh");
    const job = await jobOf(stub, "q1");
    const before = await sessionCount();

    const shouted = { ...ref, owner: "OCTO", repo: "Api" };
    const rev = await revOf(stub, job.job_id);
    expect(await outcome(retryOver(token, shouted, job.job_id, rev))).toEqual({
      status: 200,
      body: { status: "retried" },
    });
    expect((await jobOf(stub, "q1")).state).toBe("pending");
    expect(await sessionCount()).toBe(before);
  });

  it("answers 400 for an owner, repository or number outside PrRef, creating no session", async () => {
    captureLogs();
    const { token } = await localSession("api", sockets);
    const before = await sessionCount();
    for (const path of [
      "/api/pr/-octo/demo/1",
      "/api/pr/octo/de%20mo/1",
      "/api/pr/octo/de%7Emo/1",
      "/api/pr/octo/de%2Fmo/1",
      "/api/pr/octo/demo/0",
      "/api/pr/octo/demo/01",
      "/api/pr/octo/demo/1e0",
      "/api/pr/octo/demo/99999999999999999999",
    ]) {
      const res = errorOf(post(`${path}/jobs/${crypto.randomUUID()}/retry`, token, { expectedRev: 0 }));
      expect({ path, ...(await res) }).toEqual({ path, status: 400, error: "bad_request" });
    }
    expect(await sessionCount()).toBe(before);
  });

  it("answers 400 naming expectedRev for a body without a whole revision from 0", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("api", sockets, question("q1"));
    await claimIn(stub, "laptop", "fresh");
    const job = await jobOf(stub, "q1");
    for (const body of [{}, { expectedRev: -1 }, { expectedRev: 0.5 }, { expectedRev: "0" }]) {
      const res = await post(retryPath(ref, job.job_id), token, body);
      expect({ body, status: res.status, json: await res.json() }).toEqual({
        body,
        status: 400,
        json: { error: "bad_request", detail: "invalid expectedRev" },
      });
    }
    expect((await jobOf(stub, "q1")).state).toBe("claimed");
  });
});

describe("retry time limit", () => {
  it("answers 503 when the session does not answer in time; a retry that changed the job still applies", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("api", sockets, question("q1"));
    await claimIn(stub, "laptop", "fresh");
    const job = await jobOf(stub, "q1");
    const seen = await revOf(stub, job.job_id);
    // The retry's delivery to the Hub, after its change, is held.
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const deliver = seams.deliver.bind(instance);
      vi.spyOn(seams, "deliver").mockImplementationOnce(async () => {
        await held.wait();
        await deliver();
      });
    });
    const limit = heldBound();
    const req = postRequest(retryPath(ref, job.job_id), token, { expectedRev: seen });
    const res = tracked(fetchBounded(limit.bound, req));
    await held.reached();
    // A sentinel read of the session goes through while the retry is held.
    expect((await stub.view()).jobs.map((view) => view.state)).toEqual(["pending"]);
    expect(res.settled()).toBe(false);

    limit.expire();
    const timedOut = await within(res.promise, 3000);
    expect(timedOut.headers.get("Cache-Control")).toBe("no-store");
    expect(await errorOf(timedOut)).toEqual({ status: 503, error: "unavailable" });
    expect(limit.bounds).toEqual([{ ms: ROUTE_CALL_MS, what: "a session's retry" }]);
    await held.open();
    // The retry the route stopped waiting for has applied: the job is pending, so a second retry is refused.
    expect(await errorOf(retryOver(token, ref, job.job_id, seen))).toEqual({ status: 409, error: "not_retryable" });
  });

  it("lets no retry that lands after the 503 undo what changed the job since its view", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("api", sockets, question("q1"));
    await claimIn(stub, "laptop", "fresh");
    const job = await jobOf(stub, "q1");
    const seen = await revOf(stub, job.job_id);
    // The retry is held in the session while it arms its wake, before its change.
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const schedule = instance.schedule.bind(instance);
      vi.spyOn(instance, "schedule").mockImplementationOnce(async (...args) => {
        await held.wait();
        return schedule(...args);
      });
    });
    const limit = heldBound();
    const req = postRequest(retryPath(ref, job.job_id), token, { expectedRev: seen });
    const res = tracked(fetchBounded(limit.bound, req));
    await held.reached();
    limit.expire();
    expect(await errorOf(within(res.promise, 3000))).toEqual({ status: 503, error: "unavailable" });

    // The UI sends the retry again from the same view, and the agent claims the job; then the first retry lands.
    const retried = { status: 200, body: { status: "retried" } };
    expect(await outcome(retryOver(token, ref, job.job_id, seen))).toEqual(retried);
    const next = await claimOver(token, "laptop");
    expect(next).toMatchObject({ job: { jobId: job.job_id } });
    await held.open();
    expect(await limit.late()).toMatchObject({ error: "stale_job" });
    expect(await jobOf(stub, "q1")).toMatchObject({
      state: "claimed",
      claim_id: next.job === null ? null : next.claimId,
    });
  });
});
