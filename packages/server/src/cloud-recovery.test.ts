import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prSessionStub } from "./names.ts";
import { TURN_INTERRUPTED } from "./pr-session/cloud.ts";
import { PrSession } from "./pr-session/index.ts";
import { captureLogs, events } from "./test/access.ts";
import { type AgentSocket, question, storedMessages } from "./test/chat.ts";
import {
  type CloudSession,
  cloudSession,
  expectAppended,
  messageRows,
  textOf,
  unstarted,
  untilState,
  usageOf,
} from "./test/cloud.ts";
import { contextRow } from "./test/compaction.ts";
import {
  answerScript,
  finish,
  type Script,
  ScriptedModel,
  type StreamPart,
  text,
  toolCall,
  useCloudModel,
} from "./test/model.ts";
import { clearSkills, type Gate, gate, jobOf, prSessionSeams } from "./test/session.ts";
import { registered, skillWith } from "./test/skills.ts";

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q1 = question("q1");

// A first turn held at a gate in its stream, after its text.
function heldScript(held: Gate, answer = "first answer"): Script {
  return [...text(answer), { hold: held }, finish()];
}

// Holds the history writes of the job's commit: before its result's append, or after it.
async function holdCommit(stub: DurableObjectStub<PrSession>, where: "before" | "after"): Promise<Gate> {
  const held = await gate(stub);
  await runInDurableObject(stub, (instance) => {
    const seams = prSessionSeams(instance);
    const insert = seams.insertMessages.bind(instance);
    vi.spyOn(seams, "insertMessages").mockImplementation(async (messages, adds) => {
      if (adds === "results" && where === "before") {
        await held.wait();
      }
      await insert(messages, adds);
      if (adds === "results" && where === "after") {
        await held.wait();
      }
    });
  });
  return held;
}

// Resets every object while the job holds, then starts the session again (its onStart runs settle), with the next
// turn's scripts added first.
async function resetAndRestart(session: CloudSession, model: ScriptedModel, ...scripts: Script[]) {
  await abortAllDurableObjects();
  model.add(...scripts);
  return prSessionStub(env, session.ref);
}

describe("restart after a reset", () => {
  it("runs a job again whose turn was lost before it reached the model", async () => {
    const logs = captureLogs();
    const session = await cloudSession("recovery", sockets);
    const model = new ScriptedModel();
    useCloudModel(model);
    const held = await gate(session.stub);
    await runInDurableObject(session.stub, (instance) => {
      const save = instance.saveMessages.bind(instance);
      vi.spyOn(instance, "saveMessages").mockImplementationOnce(async (...args) => {
        await held.wait();
        return save(...args);
      });
    });
    await session.client.chat([Q1]);
    await held.reached();
    const before = await messageRows(session);

    const stub = await resetAndRestart(session, model, answerScript("answer"));
    await untilState(stub, "q1", "done");

    const job = await jobOf(stub, "q1");
    expect(model.calls).toHaveLength(1);
    expect(await usageOf(stub, job.job_id)).toMatchObject([{ run: 1, starts: 2, steps: 1 }]);
    expectAppended(before, await messageRows(session), [`answer-${job.job_id}`]);
    expect(events(logs, "prq.job.restarted")).toMatchObject([{ jobId: job.job_id }]);
  });

  it("runs a job again whose turn was lost mid-stream, and stores only the second turn's result", async () => {
    const logs = captureLogs();
    const session = await cloudSession("recovery", sockets);
    const held = await gate(session.stub);
    const model = new ScriptedModel().add(heldScript(held));
    useCloudModel(model);
    await session.client.chat([Q1]);
    await held.reached();
    const before = await messageRows(session);

    const stub = await resetAndRestart(session, model, answerScript("second answer"));
    await untilState(stub, "q1", "done");

    const job = await jobOf(stub, "q1");
    expect(model.calls).toHaveLength(2);
    expect(await usageOf(stub, job.job_id)).toMatchObject([{ starts: 2, steps: 1 }]);
    expectAppended(before, await messageRows(session), [`answer-${job.job_id}`]);
    const stored = await storedMessages(session.path, session.token);
    expect(textOf(stored.at(-1))).toBe("second answer");
    // The SDK's write of the second turn's streamed message added nothing; the cut turn's added nothing either.
    expect(events(logs, "prq.chat.dropped")).toMatchObject([{ role: "assistant", messages: 1 }]);
  });

  it("runs a job again whose turn ended but whose commit had not appended its result", async () => {
    captureLogs();
    const session = await cloudSession("recovery", sockets);
    const model = new ScriptedModel().add(answerScript("first answer"));
    useCloudModel(model);
    const held = await holdCommit(session.stub, "before");
    await session.client.chat([Q1]);
    await held.reached();
    const before = await messageRows(session);

    const stub = await resetAndRestart(session, model, answerScript("second answer"));
    await untilState(stub, "q1", "done");

    const job = await jobOf(stub, "q1");
    expect(model.calls).toHaveLength(2);
    expectAppended(before, await messageRows(session), [`answer-${job.job_id}`]);
    expect(textOf((await storedMessages(session.path, session.token)).at(-1))).toBe("second answer");
  });

  it("finishes a job whose result was appended before the reset, with no model call", async () => {
    const logs = captureLogs();
    const session = await cloudSession("recovery", sockets);
    const model = new ScriptedModel().add(answerScript("the answer"));
    useCloudModel(model);
    const held = await holdCommit(session.stub, "after");
    await session.client.chat([Q1]);
    await held.reached();
    const before = await messageRows(session);
    expect((await jobOf(session.stub, "q1")).state).toBe("running");

    const stub = await resetAndRestart(session, model);
    await untilState(stub, "q1", "done");

    const job = await jobOf(stub, "q1");
    expect(job).toMatchObject({ result_message_id: `answer-${job.job_id}`, unresolved_failure: 0, turn_id: null });
    expect(model.calls).toHaveLength(1);
    expect(await messageRows(session)).toEqual(before);
    expect(events(logs, "prq.job.restarted")).toEqual([]);
    expect(events(logs, "prq.job.usage")).toMatchObject([{ jobId: job.job_id, outcome: "done", starts: 1 }]);
  });

  it("keeps no measurement for a recovered result that holds a skill call: the next question counts the estimate", async () => {
    captureLogs();
    await clearSkills();
    await registered(skillWith("polish", { body: "Polish the answer.\n" }));
    const session = await cloudSession("recovery", sockets);
    // At a 16,384-token window (14,336 for a request): q0's measurement leaves q1 the room for one result, and would
    // leave q2 less once q1's answer is counted on top of it.
    const model = new ScriptedModel().add(
      answerScript("A short first answer.", { input: 14_205, output: 10 }),
      [toolCall("activate_skill", { name: "polish" }, "call-1"), finish("tool-calls", { input: 1000, output: 10 })],
      answerScript(`${"Clear text ".repeat(7)}done.`),
    );
    model.contextTokens = 16_384;
    useCloudModel(model);
    await session.client.chat([question("q0", "?")]);
    await untilState(session.stub, "q0", "done");
    expect((await contextRow(session.stub)).context_tokens).toBe(14_215);
    const held = await holdCommit(session.stub, "after");
    await session.client.chat([question("q1", "?")]);
    await held.reached();

    const stub = await resetAndRestart(session, model, answerScript("answer two"));
    await untilState(stub, "q1", "done");
    const job = await jobOf(stub, "q1");
    expect(await contextRow(stub)).toMatchObject({ context_tokens: null, context_through: `answer-${job.job_id}` });

    await (await session.open()).chat([question("q2", "?")]);
    await untilState(stub, "q2", "done");
    // On q0's measurement q2's request would leave less than a result's room and be offered no tools.
    expect((model.calls.at(-1)?.tools ?? []).map((entry) => entry.name)).toEqual([
      "activate_skill",
      "read_skill_resource",
    ]);
    await clearSkills();
  });

  it("fails a run whose incomplete text was appended before the reset, with its stored reason and no new start", async () => {
    const logs = captureLogs();
    const session = await cloudSession("recovery", sockets);
    const model = new ScriptedModel().add([...text("first partial"), { fail: new Error("first error") }]);
    useCloudModel(model);
    const held = await holdCommit(session.stub, "after");
    await session.client.chat([Q1]);
    await held.reached();
    const before = await messageRows(session);

    const stub = await resetAndRestart(session, model, [
      ...text("second partial"),
      { fail: new Error("second error") },
    ]);
    await untilState(stub, "q1", "failed");

    const job = await jobOf(stub, "q1");
    expect(job).toMatchObject({ failure: "first error", unresolved_failure: 1, turn_id: null });
    expect(model.calls).toHaveLength(1);
    expect(await messageRows(session)).toEqual(before);
    expect(textOf((await storedMessages(session.path, session.token)).at(-1))).toBe("first partial");
    expect(events(logs, "prq.job.restarted")).toEqual([]);
    expect(events(logs, "prq.job.usage")).toMatchObject([{ jobId: job.job_id, outcome: "failed", starts: 1 }]);
  });

  it("fails a run whose turn was interrupted on each of its 3 starts", async () => {
    const logs = captureLogs();
    const session = await cloudSession("recovery", sockets);
    const first = await gate(session.stub);
    const model = new ScriptedModel().add(heldScript(first));
    useCloudModel(model);
    await session.client.chat([Q1]);
    await first.reached();
    const before = await messageRows(session);

    for (const start of [2, 3]) {
      await abortAllDurableObjects();
      const held = await gate(unstarted(session.name));
      model.add(heldScript(held));
      const stub = await prSessionStub(env, session.ref);
      await held.reached();
      expect(await usageOf(stub, (await jobOf(stub, "q1")).job_id)).toMatchObject([{ starts: start }]);
    }
    const stub = await resetAndRestart(session, model);
    await untilState(stub, "q1", "failed");

    const job = await jobOf(stub, "q1");
    expect(job).toMatchObject({ failure: TURN_INTERRUPTED, unresolved_failure: 1, turn_id: null });
    expect(model.calls).toHaveLength(3);
    expect(await messageRows(session)).toEqual(before);
    expect(events(logs, "prq.job.usage")).toMatchObject([{ jobId: job.job_id, outcome: "failed", starts: 3 }]);
  });
});

describe("usage", () => {
  it("logs a run's steps and tokens summed over its starts, from its first start to its end", async () => {
    const logs = captureLogs();
    const session = await cloudSession("recovery", sockets);
    const model = new ScriptedModel("model-u").add([
      ...text("first"),
      finish("stop", { input: 100, output: 20, cached: 50 }),
    ]);
    useCloudModel(model);
    const held = await holdCommit(session.stub, "before");
    await session.client.chat([Q1]);
    await held.reached();

    const stub = await resetAndRestart(session, model, [
      ...text("second"),
      finish("stop", { input: 200, output: 40, cached: 0 }),
    ]);
    await untilState(stub, "q1", "done");

    const job = await jobOf(stub, "q1");
    expect(events(logs, "prq.job.usage")).toEqual([
      {
        event: "prq.job.usage",
        pr: session.name,
        jobId: job.job_id,
        kind: "answer",
        run: 1,
        outcome: "done",
        model: "model-u",
        steps: 2,
        inputTokens: 300,
        outputTokens: 60,
        cachedInputTokens: 50,
        // The run's first start was the job's creation; its end, the done statement.
        wallMs: job.updated_at - job.created_at,
        starts: 2,
        overflowRerun: false,
      },
    ]);
  });
});

// The SDK's recovery tasks and the chat turns its task runner has not finished.
async function sdkTasks(stub: DurableObjectStub<PrSession>) {
  return runInDurableObject(stub, (_, state) => ({
    recovery: state.storage.sql
      .exec<{ input: string }>("SELECT input FROM cf_agents_task_runs WHERE definition = '__cf_internal_chat_recovery'")
      .toArray()
      .map((row) => row.input),
    turns: state.storage.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM cf_agents_task_runs WHERE definition = '__cf_internal_chat_turn' AND state = 'running'",
      )
      .one().count,
  }));
}

describe("SDK recovery declined", () => {
  it.for([
    ["mid-stream", []],
    [
      "after a finished tool step",
      [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "lookup",
          input: "{}",
          providerExecuted: true,
          dynamic: true,
        },
        { type: "tool-result", toolCallId: "call-1", toolName: "lookup", result: { found: true }, dynamic: true },
      ],
    ],
  ] satisfies [string, StreamPart[]][])("starts no recovery turn of its own after a reset %s", async ([, prefix]) => {
    captureLogs();
    const recoveries = [
      vi.spyOn(PrSession.prototype, "_chatRecoveryRetry"),
      vi.spyOn(PrSession.prototype, "_chatRecoveryContinue"),
    ];
    const session = await cloudSession("recovery", sockets);
    const held = await gate(session.stub);
    const model = new ScriptedModel().add([...prefix, ...heldScript(held)]);
    useCloudModel(model);
    await session.client.chat([Q1]);
    await held.reached();
    const before = await messageRows(session);

    const stub = await resetAndRestart(session, model, answerScript("second answer"));
    await untilState(stub, "q1", "done");
    // The interrupted turn's task is recovered by the SDK at its wake.
    await vi.waitFor(async () => expect((await sdkTasks(stub)).turns).toBe(0), { timeout: 10_000, interval: 50 });

    expect((await sdkTasks(stub)).recovery).toEqual([]);
    for (const recovery of recoveries) {
      expect(recovery).not.toHaveBeenCalled();
    }
    expect(model.calls).toHaveLength(2);
    const job = await jobOf(stub, "q1");
    expectAppended(before, await messageRows(session), [`answer-${job.job_id}`]);
  });
});
