import { type Job, PrSessionView } from "@prq/protocol";
import { runInDurableObject } from "cloudflare:test";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLOUD_NOT_CONFIGURED } from "./pr-session/cloud.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question, storedMessages } from "./test/chat.ts";
import { jobOf, newSession, prSessionSeams, sessionSql, setPool } from "./test/session.ts";

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q1 = question("q1");
const Q2 = question("q2");
const Q3 = question("q3");

describe("no cloud agent configured", () => {
  it("stores a cloud question with its job already failed, with no turn, and fails it again on retry", async () => {
    const logs = captureLogs();
    await setPool([]);
    const { stub, path, token, open } = await newSession("cloud", sockets);
    const client = await open();

    await client.chat([Q1]);
    const job = await jobOf(stub, "q1");
    expect(job).toMatchObject({ state: "failed", failure: CLOUD_NOT_CONFIGURED });
    expect(await stub.retryJob(job.job_id)).toEqual({ status: "retried" });
    expect(await jobOf(stub, "q1")).toMatchObject({ state: "failed", failure: CLOUD_NOT_CONFIGURED });

    // No view and no log showed the job waiting.
    const views = client.frames
      .filter((frame) => frame["type"] === "cf_agent_state")
      .map((frame) => v.parse(PrSessionView, frame["state"]));
    expect(views.at(-1)?.jobs).toMatchObject([{ state: "failed", failure: CLOUD_NOT_CONFIGURED }]);
    expect(views.flatMap((view) => view.jobs.map((viewed) => viewed.state))).not.toContain("pending");
    const jobLogs = logs.map((log) => log.entry).filter((entry) => String(entry["event"]).startsWith("prq.job."));
    expect(jobLogs.map((entry) => entry["to"])).not.toContain("pending");
    expect(jobLogs.filter((entry) => entry["event"] === "prq.job.failed")).toHaveLength(2);
    // Nothing was streamed and nothing but the question was stored.
    expect(client.frames.some((frame) => JSON.stringify(frame).includes("text-delta"))).toBe(false);
    expect(await storedMessages(path, token)).toEqual([Q1]);
  });
});

describe("with a cloud agent", () => {
  it("hands over the oldest waiting job, once per job, and nothing while one is running", async () => {
    captureLogs();
    await setPool([]);
    const { stub, open } = await newSession("cloud", sockets);
    const started: string[] = [];
    const agent = {
      start: (job: Job) => {
        started.push(job.target.kind === "answer" ? job.target.messageId : job.target.headSha);
      },
    };
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "cloudAgent").mockReturnValue(agent);
    });
    const client = await open();

    await client.chat([Q1]);
    await client.chat([Q1, Q2]);
    await client.chat([Q1, Q2, Q3]);
    expect(started).toEqual(["q1"]);
    expect((await stub.view()).jobs.map((job) => job.state)).toEqual(["running", "pending", "pending"]);

    // #5's completion of Q1, stood in for with SQL, then settle hands over the next one.
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'done' WHERE target = 'q1'");
    await stub.settle();
    expect(started).toEqual(["q1", "q2"]);
    await stub.settle();
    expect(started).toEqual(["q1", "q2"]);
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'done' WHERE target = 'q2'");
    await stub.settle();
    expect(started).toEqual(["q1", "q2", "q3"]);
  });
});
