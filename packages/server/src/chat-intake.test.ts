import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prSessionStub } from "./names.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question, storedMessages } from "./test/chat.ts";
import {
  cancelWakes,
  gate,
  jobRows,
  newSession,
  prSessionSeams,
  setPool,
  submission,
  tracked,
  within,
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
const Q3 = question("q3");
const Q4 = question("q4");

describe("one job per question", () => {
  it("creates exactly one answer job per question, on a resend and while another request is in flight", async () => {
    const logs = captureLogs();
    await setPool(["laptop"]);
    const { stub, open } = await newSession("intake", sockets);
    const first = await open();
    const second = await open();

    await first.chat([Q1]);
    await first.chat([Q1, Q2]);
    await first.chat([Q1, Q2]);
    // Q3's turn is held at its job step; Q4 is stored meanwhile and its turn waits behind Q3's.
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const create = seams.createJobs.bind(instance);
      vi.spyOn(seams, "createJobs").mockImplementationOnce(async () => {
        await held.wait();
        return create();
      });
    });
    const asked = tracked(first.chat([Q1, Q2, Q3]));
    await held.reached();
    const other = second.chat([Q1, Q2, Q3, Q4]);
    await second.received(Q4.id);
    expect(asked.settled()).toBe(false);
    await held.open();
    await Promise.all([asked.promise, other]);

    const jobs = await jobRows(stub);
    expect(jobs.map((job) => [job.kind, job.target, job.state])).toEqual(
      ["q1", "q2", "q3", "q4"].map((id) => ["answer", id, "pending"]),
    );
    const created = logs
      .filter((log) => log.entry["event"] === "prq.job.created")
      .map((log) => String(log.entry["jobId"]));
    expect(created.toSorted()).toEqual(jobs.map((job) => job.job_id).toSorted());
  });
});

describe("questions outside the history in memory", () => {
  it("gives a job after a restart to every stored question without one, older than the cached history included", async () => {
    captureLogs();
    await setPool(["laptop"]);
    const { stub, ref, open } = await newSession("intake", sockets);
    const client = await open();
    await client.chat([Q1]);
    client.close();
    // Nine 4 MiB questions stored with no job, as a stop between their save and their job step leaves them. Together
    // they are over the 32 MiB of history the SDK loads into this.messages at a start.
    const large = Array.from({ length: 9 }, (_, n) => question(`large-${n}`, "x".repeat(4 * 1024 * 1024)));
    await runInDurableObject(stub, async (instance) => {
      for (const message of large) {
        await instance.persistMessages([message]);
      }
    });
    await cancelWakes(stub);
    await abortAllDurableObjects();

    // The start's settle creates the jobs.
    const restarted = await prSessionStub(env, ref);
    await restarted.view();
    const cached = await runInDurableObject(restarted, (instance) => instance.messages.map((message) => message.id));
    expect(cached).not.toContain("large-0");
    expect((await jobRows(restarted)).map((job) => job.target)).toEqual(["q1", ...large.map((message) => message.id)]);
  });
});

async function claimedQ1() {
  captureLogs();
  await setPool(["laptop"]);
  const session = await newSession("intake", sockets);
  const client = await session.open();
  await client.chat([Q1]);
  const claim = await session.stub.claim("laptop", "fresh");
  return { ...session, client, claim };
}

describe("questions during an append", () => {
  it("keeps a question sent while an answer is being appended", async () => {
    const { stub, path, token, client, claim } = await claimedQ1();
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const insert = seams.insertMessages.bind(instance);
      vi.spyOn(seams, "insertMessages").mockImplementationOnce(async (messages) => {
        await held.wait();
        return insert(messages);
      });
    });
    const submit = tracked(stub.submit(submission(claim, "laptop")));
    await held.reached();
    const asked = client.chat([Q1, Q2]);
    expect((await stub.view()).jobs).toHaveLength(1);
    expect(submit.settled()).toBe(false);

    await held.open();
    expect(await submit.promise).toMatchObject({ status: "accepted" });
    await asked;

    const ids = (await storedMessages(path, token)).map((message) => message.id);
    expect(ids.toSorted()).toEqual(["q1", "q2", `answer-${claim.job?.jobId}`].toSorted());
    expect((await jobRows(stub)).map((job) => [job.target, job.state])).toEqual([
      ["q1", "done"],
      ["q2", "pending"],
    ]);
  });

  it("returns a submit that starts while a question's save is between the SDK and the write queue", async () => {
    const { stub, path, token, client, claim } = await claimedQ1();
    // Q2's save is held as it enters persistMessages: the SDK counts it pending from before that call.
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const save = instance.persistMessages.bind(instance);
      vi.spyOn(instance, "persistMessages").mockImplementationOnce(async (...args) => {
        await held.wait();
        return save(...args);
      });
    });
    const asked = tracked(client.chat([Q1, Q2]));
    await held.reached();
    const submit = tracked(stub.submit(submission(claim, "laptop")));
    // The session keeps serving; the submit waits for the save.
    expect((await stub.view()).jobs).toHaveLength(1);
    expect(submit.settled()).toBe(false);

    await held.open();
    expect(await within(submit.promise, 2000)).toMatchObject({ status: "accepted" });
    await asked.promise;

    expect((await storedMessages(path, token)).map((message) => message.id)).toEqual([
      "q1",
      "q2",
      `answer-${claim.job?.jobId}`,
    ]);
  });
});
