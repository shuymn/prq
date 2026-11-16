import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prSessionStub } from "./names.ts";
import type { PrSession } from "./pr-session/index.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question, storedMessages } from "./test/chat.ts";
import {
  cancelWakes,
  gate,
  holdInsert,
  jobRows,
  newSession,
  prSessionSeams,
  type Session,
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

async function intakeRows(stub: DurableObjectStub<PrSession>): Promise<string[]> {
  return runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ question_id: string }>("SELECT question_id FROM prq_intake ORDER BY seq")
      .toArray()
      .map((row) => row.question_id),
  );
}

// The session's write of a question is lost at the hold, and a new instance starts on the same storage.
async function loseWrite(session: Session, where: "before" | "after") {
  const held = await holdInsert(session.stub, where);
  const write = session.stub.persistMessages([Q2]).catch((error: unknown) => error);
  await held.reached();
  const state = { stored: await storedIds(session), intake: await intakeRows(session.stub) };
  await cancelWakes(session.stub);
  await abortAllDurableObjects();
  await write;
  const restarted = await prSessionStub(env, session.ref);
  // The start's settle.
  await restarted.view();
  return { state, restarted };
}

async function storedIds(session: { path: string; token: string }): Promise<string[]> {
  return (await storedMessages(session.path, session.token)).map((message) => message.id);
}

describe("intake", () => {
  it("writes a question's intake row before the question, so a stop on either side leaves no question without a job", async () => {
    captureLogs();
    await setPool(["laptop"]);
    const before = await newSession("intake", sockets);
    await (await before.open()).chat([Q1]);
    const lostBefore = await loseWrite(before, "before");
    // The row is written and the question is not stored yet; after the stop the row is dropped and nothing remains.
    expect(lostBefore.state).toEqual({ stored: ["q1"], intake: ["q2"] });
    expect(await storedIds(before)).toEqual(["q1"]);
    expect((await jobRows(lostBefore.restarted)).map((job) => job.target)).toEqual(["q1"]);
    expect(await intakeRows(lostBefore.restarted)).toEqual([]);

    const after = await newSession("intake", sockets);
    await (await after.open()).chat([Q1]);
    const lostAfter = await loseWrite(after, "after");
    // The question is stored with its row and no job yet; the start turns the row into its job.
    expect(lostAfter.state).toEqual({ stored: ["q1", "q2"], intake: ["q2"] });
    expect((await jobRows(lostAfter.restarted)).map((job) => job.target)).toEqual(["q1", "q2"]);
    expect(await intakeRows(lostAfter.restarted)).toEqual([]);
  });

  it("keeps the intake row of a question whose insert is under way when settle runs", async () => {
    captureLogs();
    await setPool(["laptop"]);
    const { stub, open } = await newSession("intake", sockets);
    const client = await open();
    const held = await holdInsert(stub, "before");
    const asked = client.chat([Q1]);
    await held.reached();
    const settling = tracked(stub.settle());
    // The session keeps serving; settle waits for the write.
    expect((await stub.view()).jobs).toEqual([]);
    expect(settling.settled()).toBe(false);

    await held.open();
    await Promise.all([settling.promise, asked]);
    expect((await jobRows(stub)).map((job) => job.target)).toEqual(["q1"]);
    expect(await intakeRows(stub)).toEqual([]);
  });

  it("gives a job to each of 10,003 questions stored without one, however deep the history", async () => {
    captureLogs();
    await setPool(["laptop"]);
    const { stub } = await newSession("intake", sockets);
    // One write of 10,003 questions with no job step after it (as a stop leaves them): more than the 10,000 messages
    // the SDK walks from the newest.
    const many = Array.from({ length: 10_003 }, (_, n) => question(`many-${n}`, "?"));
    await runInDurableObject(stub, (instance) => instance.persistMessages(many));
    await cancelWakes(stub);

    await stub.settle();
    const targets = (await jobRows(stub)).map((job) => job.target);
    expect(targets).toHaveLength(10_003);
    expect(targets.slice(0, 2)).toEqual(["many-0", "many-1"]);
    expect(await intakeRows(stub)).toEqual([]);
  }, 60_000);
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
