import { MessageMetadata } from "@prq/protocol";
import { WebSocketChatTransport } from "agents/chat/transport";
import type { UIMessage } from "ai";
import { runInDurableObject } from "cloudflare:test";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WORKSPACE_NOT_AVAILABLE } from "./pr-session/cloud.ts";
import { contextBudget } from "./pr-session/context-budget.ts";
import { PrSession } from "./pr-session/index.ts";
import { CHARS_PER_TOKEN } from "./pr-session/room.ts";
import { MIN_RESULT_CHARS } from "./pr-session/tools.ts";
import { NO_ANSWER_TEXT } from "./pr-session/turn.ts";
import { WORKSPACE_CALL_MS } from "./pr-session/workspace.ts";
import { captureLogs, events } from "./test/access.ts";
import { type AgentSocket, question, storedMessages } from "./test/chat.ts";
import {
  cloudSession,
  expectAppended,
  messageRows,
  resumeOffer,
  streamsText,
  textOf,
  turnFrames,
  untilEnded,
  untilState,
} from "./test/cloud.ts";
import {
  answerScript,
  type CallOptions,
  finish,
  reasoning,
  ScriptedModel,
  type StreamPart,
  text,
  toolCall,
  useCloudModel,
  useWorkspace,
} from "./test/model.ts";
import { advance, until } from "./test/provider.ts";
import { gate, jobOf, jobRows, prSessionSeams, retryIn, revOf, sessionSql } from "./test/session.ts";
import { BASE, INSTALLATION_ID, push, sha } from "./test/webhook.ts";
import { FakeWorkspace } from "./test/workspace.ts";

const sockets: AgentSocket[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q1 = question("q1");
const Q2 = question("q2");
const Q3 = question("q3");

async function stored(session: { path: string; token: string }, id: string): Promise<UIMessage | undefined> {
  return (await storedMessages(session.path, session.token)).find((message) => message.id === id);
}

describe("hand-over", () => {
  it("runs one job at a time: one model call while it streams, each job started once", async () => {
    const logs = captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, client } = session;
    const held = await gate(stub);
    const model = new ScriptedModel().add(
      [...text("answer one"), { hold: held }, finish()],
      answerScript("answer two"),
      answerScript("answer three"),
    );
    useCloudModel(model);

    await client.chat([Q1]);
    await held.reached();
    // A chat request's turn waits behind the job's; settle (its wake) gives its questions their jobs meanwhile.
    const asked = [client.chat([Q1, Q2]), client.chat([Q1, Q2, Q3])];
    await vi.waitFor(async () => expect(await storedMessages(session.path, session.token)).toHaveLength(3));
    await stub.settle();

    expect(model.calls).toHaveLength(1);
    expect((await stub.view()).jobs.map((job) => job.state)).toEqual(["running", "pending", "pending"]);
    await held.open();
    await Promise.all(asked);
    await untilState(stub, "q3", "done");
    expect(model.calls).toHaveLength(3);
    const started = events(logs, "prq.job.started").map((entry) => entry["jobId"]);
    expect(started).toEqual((await jobRows(stub)).map((row) => row.job_id));
  });
});

describe("commit", () => {
  it("appends the result with cloud metadata and settled parts only, marks the job done, then runs the next", async () => {
    captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, client } = session;
    const model = new ScriptedModel("model-x").add(
      [
        ...reasoning("thinking it over"),
        // A provider-executed tool call with its result (settled), and one without (unsettled).
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "lookup",
          input: "{}",
          providerExecuted: true,
          dynamic: true,
        },
        { type: "tool-result", toolCallId: "call-1", toolName: "lookup", result: { found: true }, dynamic: true },
        {
          type: "tool-call",
          toolCallId: "call-2",
          toolName: "lookup",
          input: "{}",
          providerExecuted: true,
          dynamic: true,
        },
        ...text("answer one"),
        finish("stop", { input: 120, output: 30, cached: 100 }),
      ] satisfies StreamPart[],
      answerScript("answer two"),
    );
    useCloudModel(model);

    await client.chat([Q1]);
    await client.chat([Q1, Q2]);
    await untilState(stub, "q2", "done");

    const job = await jobOf(stub, "q1");
    expect(job.failure).toBeNull();
    expect(job).toMatchObject({ state: "done", result_message_id: `answer-${job.job_id}`, turn_id: null });
    const result = await stored(session, `answer-${job.job_id}`);
    expect(result?.role).toBe("assistant");
    expect(v.parse(MessageMetadata, result?.metadata)).toEqual({
      kind: "answer",
      jobId: job.job_id,
      questionId: "q1",
      sha: null,
      run: 1,
      by: { kind: "cloud", model: "model-x" },
      usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 100 },
    });
    const types = (result?.parts ?? []).map((part) => part.type);
    expect(types).not.toContain("reasoning");
    expect(JSON.stringify(result?.parts)).toContain("call-1");
    expect(JSON.stringify(result?.parts)).not.toContain("call-2");
    expect(textOf(result)).toBe("answer one");
    // Q2's model call came after Q1's result was stored: it read it.
    expect(model.prompts()[1]?.map((message) => message.text)).toEqual(["question q1", "answer one", "question q2"]);
  });
});

describe("binding", () => {
  it("calls the model in the job's turn only, when a chat request's turn is queued before it", async () => {
    captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, client } = session;
    const model = new ScriptedModel().add(answerScript("answer one"), answerScript("answer two"));
    useCloudModel(model);
    // The job's turn is held before saveMessages, so the next chat request's turn is queued first.
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const save = instance.saveMessages.bind(instance);
      vi.spyOn(instance, "saveMessages").mockImplementationOnce(async (...args) => {
        await held.wait();
        return save(...args);
      });
    });
    await client.chat([Q1]);
    await held.reached();

    const asked = await client.chat([Q1, Q2]);
    expect(model.calls).toHaveLength(0);
    expect(streamsText(turnFrames(client, asked))).toBe(false);
    expect((await jobRows(stub)).map((row) => [row.target, row.state])).toEqual([
      ["q1", "running"],
      ["q2", "pending"],
    ]);
    await held.open();
    await untilState(stub, "q2", "done");

    expect(model.calls).toHaveLength(2);
    expect(streamsText(turnFrames(client, asked))).toBe(false);
    expect(textOf(await stored(session, `answer-${(await jobOf(stub, "q1")).job_id}`))).toBe("answer one");
  });

  it("clears a binding no onChatMessage took, so a later chat request's turn calls no model", async () => {
    captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, client } = session;
    const model = new ScriptedModel().add(answerScript("answer one"), answerScript("answer two"));
    useCloudModel(model);
    // The job's turn is held inside its slot, after it bound the job.
    const bound = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const save = instance.saveMessages.bind(instance);
      vi.spyOn(instance, "saveMessages").mockImplementationOnce(async (messages, options) =>
        save(async (current) => {
          const list = typeof messages === "function" ? await messages(current) : messages;
          await bound.wait();
          return list;
        }, options),
      );
    });
    await client.chat([Q1]);
    await bound.reached();
    // Q2's request is stored and its turn queued behind the job's.
    const q2 = crypto.randomUUID();
    const asked = client.chat([Q1, Q2], "submit-message", { id: q2 });
    await vi.waitFor(async () => expect((await storedMessages(session.path, session.token)).length).toBe(2));
    // The history queue is held by Q3's insert, so the job's commit cannot run before Q2's turn.
    const writes = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const insert = seams.insertMessages.bind(instance);
      vi.spyOn(seams, "insertMessages").mockImplementationOnce(async (...args) => {
        await writes.wait();
        return insert(...args);
      });
    });
    const third = client.chat([Q1, Q2, Q3]);
    await writes.reached();
    // The job's turn fails after binding, before its onChatMessage; Q2's turn then takes intake's path.
    let intake = 0;
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(instance, "persistMessages").mockRejectedValueOnce(new Error("storage failed"));
      const seams = prSessionSeams(instance);
      const createJobs = seams.createJobs.bind(instance);
      vi.spyOn(seams, "createJobs").mockImplementation(async () => {
        intake += 1;
        return createJobs();
      });
    });

    await bound.open();
    await vi.waitFor(() => expect(intake + model.calls.length).toBeGreaterThan(0));
    expect(model.calls).toHaveLength(0);
    await writes.open();
    await Promise.all([asked, third]);
    await untilState(stub, "q2", "done");

    expect(streamsText(turnFrames(client, q2))).toBe(false);
    const job = await jobOf(stub, "q1");
    expect(job.state).toBe("done");
    expect(textOf(await stored(session, `answer-${job.job_id}`))).toBe("answer one");
  });
});

describe("failure", () => {
  it("keeps the text of a turn that errored as incomplete, fails the job, and a retry stores the result, each run named in its stream start, its rows and the view", async () => {
    const logs = captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, client } = session;
    const model = new ScriptedModel().add(
      [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "partial" }, { fail: new Error("lost") }],
      answerScript("answer one"),
    );
    useCloudModel(model);
    const before = await messageRows(session);

    await client.chat([Q1]);
    await untilState(stub, "q1", "failed");

    const job = await jobOf(stub, "q1");
    expect(job).toMatchObject({ failure: "lost", unresolved_failure: 1, turn_id: null });
    expect((await stub.view()).jobs).toMatchObject([{ state: "failed", failure: "lost", run: 1 }]);
    const incomplete = await stored(session, `answer-${job.job_id}-r1-incomplete`);
    expect(textOf(incomplete)).toBe("partial");
    expect(v.parse(MessageMetadata, incomplete?.metadata)).toMatchObject({
      kind: "answer",
      jobId: job.job_id,
      questionId: "q1",
      run: 1,
      incomplete: { reason: "lost" },
    });
    expect(await stored(session, `answer-${job.job_id}`)).toBeUndefined();

    expect(await retryIn(stub, job.job_id)).toEqual({ status: "retried" });
    await untilState(stub, "q1", "done");
    expect((await stub.view()).jobs).toMatchObject([{ state: "done", run: 2 }]);
    const result = await stored(session, `answer-${job.job_id}`);
    expect(textOf(result)).toBe("answer one");
    expect(v.parse(MessageMetadata, result?.metadata)).toMatchObject({ jobId: job.job_id, run: 2 });
    expectAppended(before, await messageRows(session), [
      "q1",
      `answer-${job.job_id}-r1-incomplete`,
      `answer-${job.job_id}`,
    ]);
    expect(events(logs, "prq.job.failed")).toMatchObject([{ from: "running", to: "failed", reason: "lost" }]);
    // Each run's stream starts with the same message ID, its start metadata naming the run.
    const starts = client.frames.flatMap((frame) => {
      const body = frame["type"] === "cf_agent_use_chat_response" ? frame["body"] : undefined;
      const start = v.safeParse(
        v.pipe(
          v.string(),
          v.parseJson(),
          v.object({ type: v.literal("start"), messageId: v.string(), messageMetadata: MessageMetadata }),
        ),
        body,
      );
      return start.success ? [{ messageId: start.output.messageId, run: start.output.messageMetadata.run }] : [];
    });
    expect(starts).toEqual([
      { messageId: `answer-${job.job_id}`, run: 1 },
      { messageId: `answer-${job.job_id}`, run: 2 },
    ]);
  });

  it("fails a turn a client cancels, keeping its text as incomplete", async () => {
    captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, client } = session;
    const held = await gate(stub);
    const model = new ScriptedModel().add([...text("partial"), { hold: held }, finish()]);
    useCloudModel(model);
    await client.chat([Q1]);
    await held.reached();
    const streamed = await client.next(
      (frame) => frame["type"] === "cf_agent_use_chat_response" && streamsText([frame]),
    );

    client.send({ type: "cf_agent_chat_request_cancel", id: streamed["id"] });
    await untilState(stub, "q1", "failed");

    const job = await jobOf(stub, "q1");
    expect(job.failure).toBe("the turn was cancelled");
    expect(textOf(await stored(session, `answer-${job.job_id}-r1-incomplete`))).toBe("partial");
    expect(await stored(session, `answer-${job.job_id}`)).toBeUndefined();
    await held.open();
  });

  it("fails a job whose turn threw before its model call, calling no model", async () => {
    const logs = captureLogs();
    const { stub, ref } = await cloudSession("turn", sockets);
    const model = new ScriptedModel();
    useCloudModel(model);
    vi.spyOn(prSessionSeams(PrSession.prototype), "workspaceFor").mockImplementation(() => {
      throw new TypeError("no binding");
    });

    await push(ref, "a");
    await untilState(stub, sha("a"), "failed");

    expect((await jobRows(stub)).map((row) => row.failure)).toEqual([
      "the turn failed before the model was called (TypeError)",
    ]);
    expect(model.calls).toHaveLength(0);
    expect(events(logs, "prq.turn.failed")).toMatchObject([{ error: "TypeError" }]);
  });

  it("fails a job whose question is not stored, calling no model", async () => {
    captureLogs();
    const { stub, client } = await cloudSession("turn", sockets);
    const model = new ScriptedModel();
    useCloudModel(model);
    // The job's turn is held before saveMessages; the question is then read as missing.
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const save = instance.saveMessages.bind(instance);
      vi.spyOn(instance, "saveMessages").mockImplementationOnce(async (...args) => {
        await held.wait();
        return save(...args);
      });
    });
    await client.chat([Q1]);
    await held.reached();
    await runInDurableObject(stub, (instance) => {
      const sessions: { getMessage: (id: string) => Promise<unknown> } = Object.getPrototypeOf(
        instance.sessions.session(),
      );
      const getMessage = sessions.getMessage;
      vi.spyOn(sessions, "getMessage").mockImplementation(function (this: unknown, id: string) {
        return id === "q1" ? Promise.resolve(null) : Reflect.apply(getMessage, this, [id]);
      });
    });

    await held.open();
    await untilState(stub, "q1", "failed");

    expect((await jobOf(stub, "q1")).failure).toBe("the question is not stored");
    expect(model.calls).toHaveLength(0);
  });

  it("runs a job again at the next settle when its commit failed", async () => {
    const logs = captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, client } = session;
    const model = new ScriptedModel().add(answerScript("first answer"), answerScript("second answer"));
    useCloudModel(model);
    await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const insert = seams.insertMessages.bind(instance);
      vi.spyOn(seams, "insertMessages").mockImplementation(async (messages, adds) => {
        if (adds === "results" && events(logs, "prq.turn.commit_failed").length === 0) {
          throw new Error("storage failed");
        }
        return insert(messages, adds);
      });
    });
    const before = await messageRows(session);

    await client.chat([Q1]);
    await vi.waitFor(() => expect(events(logs, "prq.turn.commit_failed")).toHaveLength(1));
    expect((await jobOf(stub, "q1")).state).toBe("running");
    await stub.settle();
    await untilState(stub, "q1", "done");

    const job = await jobOf(stub, "q1");
    expect(model.calls).toHaveLength(2);
    expectAppended(before, await messageRows(session), ["q1", `answer-${job.job_id}`]);
    expect(textOf(await stored(session, `answer-${job.job_id}`))).toBe("second answer");
  });
});

describe("finish reasons", () => {
  it.for([
    ["length", "the model stopped at its output limit"],
    ["content-filter", "the provider's content filter stopped the answer"],
    ["other", "the model stopped with finish reason other"],
  ] as const)("fails a turn that finished with %s, keeping its text incomplete", async ([reason, failure]) => {
    captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, client } = session;
    useCloudModel(new ScriptedModel().add([...text("cut short"), finish(reason)]));

    await client.chat([Q1]);
    await untilState(stub, "q1", "failed");

    const job = await jobOf(stub, "q1");
    expect(job.failure).toBe(failure);
    expect(textOf(await stored(session, `answer-${job.job_id}-r1-incomplete`))).toBe("cut short");
    expect(await stored(session, `answer-${job.job_id}`)).toBeUndefined();
  });
});

describe("no answer text", () => {
  it.for([
    ["reasoning only", [...reasoning("thinking it over"), finish()]],
    ["blank text", [...text(" \n"), finish()]],
  ] satisfies [string, StreamPart[]][])(
    "fails a turn that stopped with %s, storing nothing, so a retry can run it again",
    async ([, script]) => {
      captureLogs();
      const session = await cloudSession("turn", sockets);
      const { stub, client } = session;
      useCloudModel(new ScriptedModel().add(script, answerScript("answer one")));
      const before = await messageRows(session);

      await client.chat([Q1]);
      await untilState(stub, "q1", "failed");

      const job = await jobOf(stub, "q1");
      expect(job.failure).toBe(NO_ANSWER_TEXT);
      expectAppended(before, await messageRows(session), ["q1"]);
      expect(await retryIn(stub, job.job_id)).toEqual({ status: "retried" });
      await untilState(stub, "q1", "done");
      expect(textOf(await stored(session, `answer-${job.job_id}`))).toBe("answer one");
    },
  );
});

describe("no client tools", () => {
  it("offers the model none of the tools a chat request carried", async () => {
    captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, client } = session;
    const model = new ScriptedModel().add(answerScript("answer one"));
    useCloudModel(model);
    const clientTools = [{ name: "client_tool", description: "Runs in the browser", parameters: { type: "object" } }];

    await client.chat([Q1], "submit-message", { body: { clientTools } });
    await untilState(stub, "q1", "done");

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.tools ?? []).toEqual([]);
  });
});

describe("workspace required", () => {
  it("fails an analysis and an answer after a push with no workspace, calling no model", async () => {
    const logs = captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, client, ref } = session;
    const model = new ScriptedModel();
    useCloudModel(model);
    const before = await messageRows(session);

    await push(ref, "a");
    await untilState(stub, sha("a"), "failed");
    await client.chat([Q1]);
    await untilState(stub, "q1", "failed");

    expect((await jobRows(stub)).map((row) => [row.kind, row.state, row.failure, row.workspace_sha])).toEqual([
      ["analysis", "failed", WORKSPACE_NOT_AVAILABLE, sha("a")],
      ["answer", "failed", WORKSPACE_NOT_AVAILABLE, sha("a")],
    ]);
    expect(model.calls).toHaveLength(0);
    expectAppended(before, await messageRows(session), ["q1"]);
    expect(events(logs, "prq.job.usage")).toMatchObject([
      { kind: "analysis", outcome: "failed", steps: 0 },
      { kind: "answer", outcome: "failed", steps: 0 },
    ]);
  });

  it("runs a question asked before any push, which has no workspace commit", async () => {
    captureLogs();
    const { stub, client } = await cloudSession("turn", sockets);
    const model = new ScriptedModel().add(answerScript("answer one"));
    useCloudModel(model);

    await client.chat([Q1]);
    await untilState(stub, "q1", "done");

    expect((await jobOf(stub, "q1")).workspace_sha).toBeNull();
    expect(model.calls).toHaveLength(1);
  });

  it("runs an analysis at its head with a workspace", async () => {
    captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, ref } = session;
    const model = new ScriptedModel().add(answerScript("the summary"));
    useCloudModel(model);
    useWorkspace();

    await push(ref, "a");
    await untilState(stub, sha("a"), "done");

    const [job] = await jobRows(stub);
    const result = await stored(session, `analysis-${job?.job_id}`);
    expect(v.parse(MessageMetadata, result?.metadata)).toMatchObject({ kind: "analysis", headSha: sha("a") });
    expect(model.prompts()).toEqual([[{ role: "user", text: `Summarize the pull request at head ${sha("a")}.` }]]);
  });
});

describe("settle during a turn", () => {
  it("leaves a live turn alone, and a commit whose turn is no longer the job's appends nothing", async () => {
    const logs = captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, client } = session;
    const held = await gate(stub);
    const model = new ScriptedModel().add([...text("answer one"), { hold: held }, finish()]);
    useCloudModel(model);
    await client.chat([Q1]);
    await held.reached();

    await stub.settle();
    expect(model.calls).toHaveLength(1);
    expect((await jobOf(stub, "q1")).state).toBe("running");

    // The streamed message's drop, the turn's last write, is held: the turn has not ended.
    const writes = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const insert = seams.insertMessages.bind(instance);
      vi.spyOn(seams, "insertMessages").mockImplementationOnce(async (...args) => {
        await writes.wait();
        return insert(...args);
      });
    });
    await held.open();
    await writes.reached();
    await sessionSql(stub, "UPDATE prq_jobs SET turn_id = 'another-turn' WHERE target = 'q1'");
    const before = await messageRows(session);
    await writes.open();
    await vi.waitFor(() => expect(events(logs, "prq.turn.stale")).toHaveLength(1));

    expect(await messageRows(session)).toEqual(before);
    expect(await jobOf(stub, "q1")).toMatchObject({ state: "running", turn_id: "another-turn" });
    expect(model.calls).toHaveLength(1);
  });
});

// Every chunk of a stream, once it ends.
async function chunksOf<T>(stream: ReadableStream<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("resume", () => {
  it("sends a connection resuming mid-turn the history stored during its handshake, the job's chunks, then the result once", async () => {
    captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, client } = session;
    const held = await gate(stub);
    const model = new ScriptedModel().add(
      [...text("answer one"), { hold: held }, finish()],
      answerScript("answer two"),
    );
    useCloudModel(model);
    await client.chat([Q1]);
    await held.reached();
    const job = await jobOf(stub, "q1");
    const result = `answer-${job.job_id}`;

    // A second connection resumes through the SDK's transport, as useAgentChat does on connect.
    const second = await session.open();
    const transport = new WebSocketChatTransport({ agent: second.transportConnection() });
    const probed = second.frames.length;
    const resuming = transport.reconnectToStream({ chatId: "chat" });
    const offer = await resumeOffer(second, probed);
    // Within its handshake (the offer sent, no ACK yet), the first connection's Q2 is stored.
    const asked = client.chat([Q1, Q2]);
    await client.received("q2");
    expect(transport.handleStreamResuming(offer)).toBe(true);
    const stream = await resuming;
    if (stream === null) {
      throw new Error("the stream was not resumed");
    }
    const chunks = chunksOf(stream);
    await vi.waitFor(() => expect(second.frames.slice(probed).some((frame) => frame["replay"] === true)).toBe(true));
    await held.open();
    const replayed = await chunks;
    await asked;
    await untilState(stub, "q2", "done");

    const frames = second.frames.slice(probed);
    const listed = frames.findIndex(
      (frame) => frame["type"] === "cf_agent_chat_messages" && JSON.stringify(frame["messages"]).includes('"id":"q2"'),
    );
    const firstReplay = frames.findIndex((frame) => frame["replay"] === true);
    const committed = frames.findIndex(
      (frame) => frame["type"] === "cf_agent_chat_messages" && JSON.stringify(frame["messages"]).includes(result),
    );
    expect(listed).toBeGreaterThanOrEqual(0);
    expect(listed).toBeLessThan(firstReplay);
    expect(firstReplay).toBeLessThan(committed);
    // The chunks are those of the result's message, under its ID.
    expect(replayed[0]).toMatchObject({ type: "start", messageId: result });
    expect(replayed.filter((chunk) => chunk.type === "text-delta")).toMatchObject([{ delta: "answer one" }]);
    expect(second.chatLists(probed + committed)[0]?.map((message) => message.id)).toEqual(["q1", "q2", result]);
  });
});

describe("races", () => {
  it("refuses a retry of a running job, supersedes only waiting analyses, and runs the newest head next", async () => {
    captureLogs();
    const session = await cloudSession("turn", sockets);
    const { stub, ref } = session;
    const held = await gate(stub);
    const model = new ScriptedModel().add(
      [...text("summary of a"), { hold: held }, finish()],
      answerScript("summary of c"),
    );
    useCloudModel(model);
    useWorkspace();
    await push(ref, "a");
    await held.reached();
    const [a] = await jobRows(stub);
    const rev = await revOf(stub, a?.job_id ?? "");

    expect(await stub.retryJob(a?.job_id ?? "", rev)).toMatchObject({ error: "not_retryable" });
    await push(ref, "b");
    await push(ref, "c");
    expect((await jobRows(stub)).map((row) => [row.target, row.state])).toEqual([
      [sha("a"), "running"],
      [sha("b"), "superseded"],
      [sha("c"), "pending"],
    ]);
    expect((await jobRows(stub))[0]?.rev).toBe(rev);
    await held.open();
    await untilState(stub, sha("c"), "done");

    expect((await jobRows(stub)).map((row) => [row.target, row.state])).toEqual([
      [sha("a"), "done"],
      [sha("b"), "superseded"],
      [sha("c"), "done"],
    ]);
    expect(model.calls).toHaveLength(2);
  });
});

// The text of each tool result a model call was sent, in order.
function toolResults(call: CallOptions | undefined): string[] {
  return (call?.prompt ?? []).flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" && part.output.type === "text" ? [part.output.value] : [],
        )
      : [],
  );
}

function toolNames(call: CallOptions | undefined): string[] {
  return (call?.tools ?? []).map((definition) => definition.name);
}

// A text file of the given number of lines, each 59 characters and a newline.
function lines(count: number, label: string): string {
  return Array.from({ length: count }, (_, index) => `${label} ${String(index + 1).padStart(4, "0")} `.padEnd(59, "x"))
    .map((line) => `${line}\n`)
    .join("");
}

describe("tools", () => {
  it("offers no tools to a question with no workspace commit, and the four tools to a job with one", async () => {
    captureLogs();
    const { stub, client, ref } = await cloudSession("turn", sockets);
    const model = new ScriptedModel().add(answerScript("answer one"), answerScript("the summary"));
    useCloudModel(model);
    // A workspace offered for every job: only the job's commit decides whether it has one.
    const workspace = new FakeWorkspace();
    vi.spyOn(prSessionSeams(PrSession.prototype), "workspaceFor").mockReturnValue(workspace);

    await client.chat([Q1]);
    await untilState(stub, "q1", "done");
    await push(ref, "a");
    await untilState(stub, sha("a"), "done");

    expect(model.calls[0]?.tools).toBeUndefined();
    expect(toolNames(model.calls[1])).toEqual(["diff", "grep", "list_files", "read_file"]);
    // The repository and installation of the pull request's webhooks, under the analysis turn's sequence (the second).
    expect(workspace.prepares).toEqual([
      { fullName: "octo/turn", installationId: INSTALLATION_ID, sha: sha("a"), baseSha: BASE, seq: 2 },
    ]);
  });

  it("fails a job whose workspace cannot be prepared, calling no model", async () => {
    captureLogs();
    const { stub, ref } = await cloudSession("turn", sockets);
    const model = new ScriptedModel();
    useCloudModel(model);
    const workspace = new FakeWorkspace();
    workspace.prepareFailure = new Error("the fetch of the commit failed");
    useWorkspace(workspace);

    await push(ref, "a");
    await untilState(stub, sha("a"), "failed");

    expect((await jobRows(stub))[0]?.failure).toBe("workspace: the fetch of the commit failed");
    expect(workspace.prepares).toEqual([
      { fullName: "octo/turn", installationId: INSTALLATION_ID, sha: sha("a"), baseSha: BASE, seq: 1 },
    ]);
    expect(model.calls).toHaveLength(0);
  });
});

describe("workspace prepare", () => {
  it("fails a job whose workspace does not answer its prepare at the backstop, not a tick sooner, and stops listening to the turn's signal", async () => {
    captureLogs();
    const { stub, ref } = await cloudSession("turn", sockets);
    const model = new ScriptedModel();
    useCloudModel(model);
    const workspace = new FakeWorkspace();
    workspace.prepareHangs = true;
    // The abort listeners added to the turn's signal once the prepare started, and those removed.
    const listeners = { added: [] as unknown[], removed: [] as unknown[] };
    const prepare = workspace.prepare.bind(workspace);
    vi.spyOn(workspace, "prepare").mockImplementation((target, signal) => {
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      vi.spyOn(signal, "addEventListener").mockImplementation((type, listener, options) => {
        listeners.added.push(...(type === "abort" ? [listener] : []));
        add(type, listener, options);
      });
      vi.spyOn(signal, "removeEventListener").mockImplementation((type, listener, options) => {
        listeners.removed.push(...(type === "abort" ? [listener] : []));
        remove(type, listener, options);
      });
      return prepare(target, signal);
    });
    useWorkspace(workspace);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await push(ref, "a");
    await until(() => workspace.prepares.length === 1, "the prepare");
    await advance(stub, WORKSPACE_CALL_MS - 1);
    expect((await jobRows(stub))[0]?.state).toBe("running");
    await advance(stub, 1);

    expect(await untilEnded(stub, sha("a"))).toEqual({
      state: "failed",
      failure: "workspace: no answer within 31 minutes",
    });
    expect(model.calls).toHaveLength(0);
    expect(listeners.added).not.toEqual([]);
    expect(listeners.added.filter((listener) => !listeners.removed.includes(listener))).toEqual([]);
  });

  it("ends the wait for the prepare at once when the turn is aborted", async () => {
    captureLogs();
    const { stub, ref } = await cloudSession("turn", sockets);
    const model = new ScriptedModel();
    useCloudModel(model);
    const workspace = new FakeWorkspace();
    workspace.prepareHangs = true;
    useWorkspace(workspace);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await push(ref, "a");
    await until(() => workspace.prepares.length === 1, "the prepare");
    // As a client's cancel aborts it.
    await runInDurableObject(stub, (instance) => prSessionSeams(instance).abortAllRequests());

    expect(await untilEnded(stub, sha("a"))).toEqual({ state: "failed", failure: "the turn was cancelled" });
    expect(model.calls).toHaveLength(0);
  });
});

describe("workspace base", () => {
  it("fails a job with a workspace commit whose pull request's base is not known, preparing nothing", async () => {
    captureLogs();
    const { stub, ref } = await cloudSession("turn", sockets);
    const model = new ScriptedModel();
    useCloudModel(model);
    await push(ref, "a");
    await untilState(stub, sha("a"), "failed");
    // The details lose a field, so the session no longer knows the pull request's base.
    await sessionSql(stub, "UPDATE prq_session SET title = NULL WHERE id = 1");
    const workspace = new FakeWorkspace();
    useWorkspace(workspace);

    const [job] = await jobRows(stub);
    await retryIn(stub, job?.job_id ?? "");

    expect(await untilEnded(stub, sha("a"))).toEqual({
      state: "failed",
      failure: "workspace: the pull request's base is not known",
    });
    expect(workspace.prepares).toEqual([]);
    expect(model.calls).toHaveLength(0);
  });
});

describe("no budgets", () => {
  it("goes on while the model calls tools: a 40-step turn completes as done", async () => {
    const logs = captureLogs();
    const { stub, ref } = await cloudSession("turn", sockets);
    const steps = Array.from({ length: 39 }, (_, step) => [
      toolCall("list_files", {}, `call-${step}`),
      finish("tool-calls"),
    ]);
    const model = new ScriptedModel().add(...steps, answerScript("the summary"));
    useCloudModel(model);
    useWorkspace(new FakeWorkspace({ head: { "src/a.ts": "a\n" } }));

    await push(ref, "a");

    expect(await untilEnded(stub, sha("a"))).toEqual({ state: "done", failure: null });
    expect(model.calls).toHaveLength(40);
    expect(toolResults(model.calls[39])).toHaveLength(39);
    expect(events(logs, "prq.job.usage").at(-1)).toMatchObject({ outcome: "done", steps: 40 });
  });
});

describe("room", () => {
  it("offers every step the tools while the latest request and what came after it stay under the window", async () => {
    captureLogs();
    const { stub, ref } = await cloudSession("turn", sockets);
    const file = lines(50, "row");
    // A 20,000-token start, each step's input grown by 5,000 tokens: its tool result and output.
    const steps = Array.from({ length: 8 }, (_, step) => [
      toolCall("read_file", { path: "src/a.ts" }, `call-${step}`),
      finish("tool-calls", { input: 20_000 + 5000 * step, output: 100 }),
    ]);
    const model = new ScriptedModel().add(...steps, answerScript("the summary", { input: 60_000, output: 100 }));
    model.contextTokens = 128_000;
    useCloudModel(model);
    useWorkspace(new FakeWorkspace({ head: { "src/a.ts": file } }));

    await push(ref, "a");

    const ended = await untilEnded(stub, sha("a"));
    expect(model.calls.map((call) => toolNames(call).length)).toEqual(Array.from({ length: 9 }, () => 4));
    expect(ended).toEqual({ state: "done", failure: null });
    expect(model.calls).toHaveLength(9);
    const results = toolResults(model.calls[8]);
    expect(results).toHaveLength(8);
    for (const result of results) {
      expect(result.split("\n")).toHaveLength(50);
    }
  });

  it("cuts results to the room left when the next request would exceed it, then withdraws the tools", async () => {
    captureLogs();
    const { stub, ref } = await cloudSession("turn", sockets);
    const window = 20_000;
    const left = 9000;
    // The step that called the tools measured the request at the window less the reserve, less `left` characters.
    const measured = window - contextBudget(window).reserve - left / CHARS_PER_TOKEN;
    const model = new ScriptedModel().add(
      [
        toolCall("read_file", { path: "a.txt" }, "call-a"),
        toolCall("read_file", { path: "b.txt" }, "call-b"),
        finish("tool-calls", { input: measured - 100, output: 100 }),
      ],
      answerScript("answered from what was read"),
    );
    model.contextTokens = window;
    useCloudModel(model);
    // Each file alone fits the room; both together do not.
    const file = lines(100, "row");
    expect(file.length).toBeLessThan(left - MIN_RESULT_CHARS);
    expect(2 * file.length).toBeGreaterThan(left);
    useWorkspace(new FakeWorkspace({ head: { "a.txt": file, "b.txt": file } }));

    await push(ref, "a");

    expect(await untilEnded(stub, sha("a"))).toEqual({ state: "done", failure: null });
    const results = toolResults(model.calls[1]);
    expect(results).toHaveLength(2);
    expect(results.reduce((sum, result) => sum + result.length, 0)).toBeLessThanOrEqual(left);
    expect(results.filter((result) => result.split("\n").length === 100)).toHaveLength(1);
    expect(results.filter((result) => /\[cut at line \d+ .*no room for more/.test(result))).toHaveLength(1);
    // The answer's step is offered no tools.
    expect(model.calls.map((call) => toolNames(call))).toEqual([["diff", "grep", "list_files", "read_file"], []]);
  });
});
