import { ErrorResponse } from "@prq/protocol";
import { listDurableObjectIds } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import { localSession, post, retryOver } from "./test/cli.ts";
import { claimIn, jobOf, sessionSql } from "./test/session.ts";

const sockets: AgentSocket[] = [];

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

async function errorOf(response: Promise<Response>): Promise<{ status: number; error: string }> {
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

    expect(await outcome(retryOver(token, ref, claimed.job_id))).toEqual({ status: 200, body: { status: "retried" } });
    expect(await outcome(retryOver(token, ref, failed.job_id))).toEqual({ status: 200, body: { status: "retried" } });
    expect((await stub.view()).jobs.map((job) => job.state)).toEqual(["pending", "pending"]);

    // Both are pending now; then one is done and one is being finalized.
    expect(await errorOf(retryOver(token, ref, claimed.job_id))).toEqual({ status: 409, error: "not_retryable" });
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'done' WHERE job_id = ?", claimed.job_id);
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'finalizing' WHERE job_id = ?", failed.job_id);
    expect(await errorOf(retryOver(token, ref, claimed.job_id))).toEqual({ status: 409, error: "not_retryable" });
    expect(await errorOf(retryOver(token, ref, failed.job_id))).toEqual({ status: 409, error: "not_retryable" });
  });

  it("answers 404 for a job the session does not have", async () => {
    captureLogs();
    const { ref, token } = await localSession("api", sockets, question("q1"));
    expect(await errorOf(retryOver(token, ref, crypto.randomUUID()))).toEqual({ status: 404, error: "unknown_job" });
  });

  it("reaches the canonical session for any case of owner and repository, creating no other", async () => {
    captureLogs();
    const { stub, ref, token } = await localSession("api", sockets, question("q1"));
    await claimIn(stub, "laptop", "fresh");
    const job = await jobOf(stub, "q1");
    const before = await sessionCount();

    const shouted = { ...ref, owner: "OCTO", repo: "Api" };
    expect(await outcome(retryOver(token, shouted, job.job_id))).toEqual({ status: 200, body: { status: "retried" } });
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
      const res = errorOf(post(`${path}/jobs/${crypto.randomUUID()}/retry`, token, {}));
      expect({ path, ...(await res) }).toEqual({ path, status: 400, error: "bad_request" });
    }
    expect(await sessionCount()).toBe(before);
  });
});
