import { APICallError } from "ai";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prSessionStub } from "./names.ts";
import { notesText } from "./pr-session/compaction.ts";
import { PrSession } from "./pr-session/index.ts";
import { CHARS_PER_TOKEN } from "./pr-session/room.ts";
import { captureLogs, events } from "./test/access.ts";
import { type AgentSocket, question, storedMessages } from "./test/chat.ts";
import { cloudSession, expectAppended, messageRows, untilState, usageOf } from "./test/cloud.ts";
import {
  cloudAnswer,
  contextRow,
  isSummaryCall,
  notesRow,
  seedHistory,
  sized,
  summaryPrompt,
  WINDOW,
} from "./test/compaction.ts";
import {
  answerScript,
  finish,
  type Script,
  ScriptedModel,
  text,
  toolCall,
  useCloudModel,
  useWorkspace,
} from "./test/model.ts";
import { gate, jobOf, prSessionSeams, retryIn, sessionSql } from "./test/session.ts";
import { push, sha } from "./test/webhook.ts";
import { FakeWorkspace } from "./test/workspace.ts";

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

// The turns of three questions whose answers take 3,000 estimated tokens each, the last measured over the limit
// (17,500 at the test window): 15,000 input and 3,000 output tokens.
function threeTurns() {
  return [
    answerScript(sized("answer one", 3000), { input: 3000, output: 3000 }),
    answerScript(sized("answer two", 3000), { input: 9000, output: 3000 }),
    answerScript(sized("answer three", 3000), { input: 15_000, output: 3000 }),
  ];
}

describe("compaction after a commit", () => {
  it("runs before the next job is handed over, and changes no stored message", async () => {
    const logs = captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client } = session;
    const summary = await gate(stub);
    const model = new ScriptedModel().add(
      ...threeTurns(),
      [...text("the notes"), { hold: summary }, finish()],
      answerScript("the turn's start"),
      answerScript("answer four"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);

    await client.chat([Q1]);
    await untilState(stub, "q1", "done");
    await client.chat([Q1, Q2]);
    await untilState(stub, "q2", "done");
    await client.chat([Q1, Q2, Q3]);
    await untilState(stub, "q3", "done");
    await summary.reached();
    const before = await messageRows(session);
    const history = await runInDurableObject(stub, (instance) => instance.sessions.session().getHistory());

    // Q4 waits while the summary runs.
    await client.chat([Q1, Q2, Q3, Q4]);
    await untilState(stub, "q4", "pending");
    expect(model.calls.filter((call) => !isSummaryCall(call))).toHaveLength(3);

    await summary.open();
    await untilState(stub, "q4", "done");

    const q4 = await jobOf(stub, "q4");
    expectAppended(before, await messageRows(session), ["q4", `answer-${q4.job_id}`]);
    await runInDurableObject(stub, async (instance) => {
      const stored = instance.sessions.session();
      expect(await stored.getCompactions()).toEqual([]);
      expect((await stored.getHistory()).slice(0, history.length)).toEqual(history);
    });
    const a2 = `answer-${(await jobOf(stub, "q2")).job_id}`;
    expect(await notesRow(stub)).toMatchObject({ rev: 1, cut_message_id: a2, cut_step: 0 });
    expect(model.prompts().at(-1)).toEqual([
      {
        role: "user",
        text: notesText("the notes\n\n---\n\n**Turn Context (split turn):**\n\nthe turn's start"),
      },
      { role: "assistant", text: sized("answer two", 3000) },
      { role: "user", text: "question q3" },
      { role: "assistant", text: sized("answer three", 3000) },
      { role: "user", text: "question q4" },
    ]);
    const summaries = model.calls.filter(isSummaryCall).map(summaryPrompt);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toContain(`[User]: question q1\n\n[Assistant]: ${sized("answer one", 3000)}`);
    expect(summaries[1]).toContain("[User]: question q2");
    expect(events(logs, "prq.compaction.started")).toEqual([
      {
        event: "prq.compaction.started",
        pr: session.name,
        jobId: (await jobOf(stub, "q3")).job_id,
        notesRev: 0,
        cutMessageId: a2,
        cutStep: 0,
        summarizedSteps: 2,
        turnPrefixSteps: 1,
      },
    ]);
    expect(events(logs, "prq.compaction.done")).toMatchObject([{ rev: 1, cutMessageId: a2, calls: 2 }]);
  });
});

// The prompts of the model's turn calls (not its summary calls), as ScriptedModel.prompts() gives them.
function turnPrompts(model: ScriptedModel) {
  const prompts = model.prompts();
  return model.calls.flatMap((call, index) => (isSummaryCall(call) ? [] : [prompts[index] ?? []]));
}

// A summary script: its text and a normal finish.
function notes(summary: string): Script {
  return answerScript(summary, { input: 100, output: 50 });
}

describe("failed summaries", () => {
  it.for([
    ["ends at its output limit", [...text("cut notes"), finish("length")]],
    ["is empty", [...text("  "), finish("stop")]],
    [
      "holds only what prq generates",
      [...text("<summary>\n<read-files>\nsrc/a.ts\n</read-files>\n</summary>"), finish("stop")],
    ],
    ["errors", [...text("partial notes"), { fail: new Error("stream lost") }]],
  ] satisfies [string, Script][])(
    "does not adopt a summary that %s, tries it once more, then leaves the notes and runs the next job on the full context",
    async ([, failed]) => {
      const logs = captureLogs();
      const session = await cloudSession("compaction", sockets);
      const { stub, client } = session;
      const model = new ScriptedModel().add(...threeTurns(), failed, failed, answerScript("answer four"));
      model.contextTokens = WINDOW;
      useCloudModel(model);
      for (const asked of [[Q1], [Q1, Q2], [Q1, Q2, Q3]]) {
        await client.chat(asked);
        await untilState(stub, asked.at(-1)?.id ?? "", "done");
      }
      await client.chat([Q1, Q2, Q3, Q4]);
      await untilState(stub, "q4", "done");

      expect(model.calls.filter(isSummaryCall)).toHaveLength(2);
      expect(await notesRow(stub)).toMatchObject({ text: null, rev: 0, cut_message_id: null });
      const a3 = `answer-${(await jobOf(stub, "q3")).job_id}`;
      expect(await contextRow(stub)).toMatchObject({ compaction_failed_through: a3 });
      expect(
        turnPrompts(model)
          .at(-1)
          ?.map((message) => message.text),
      ).toEqual([
        "question q1",
        sized("answer one", 3000),
        "question q2",
        sized("answer two", 3000),
        "question q3",
        sized("answer three", 3000),
        "question q4",
      ]);
      expect(events(logs, "prq.compaction.retry")).toHaveLength(1);
      expect(events(logs, "prq.compaction.failed")).toMatchObject([{ calls: 2 }]);
    },
  );

  it("adopts the summary its second attempt makes", async () => {
    captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client } = session;
    const model = new ScriptedModel().add(
      ...threeTurns(),
      [...text("cut notes"), finish("length")],
      notes("the notes"),
      notes("the turn's start"),
      answerScript("answer four"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    for (const asked of [[Q1], [Q1, Q2], [Q1, Q2, Q3], [Q1, Q2, Q3, Q4]]) {
      await client.chat(asked);
      await untilState(stub, asked.at(-1)?.id ?? "", "done");
    }

    expect(model.calls.filter(isSummaryCall)).toHaveLength(3);
    expect(await notesRow(stub)).toMatchObject({
      text: "the notes\n\n---\n\n**Turn Context (split turn):**\n\nthe turn's start",
      rev: 1,
    });
  });

  it("adopts notes only at the revision they were built from: of two compactions, the later one is discarded", async () => {
    const logs = captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub } = session;
    // A history whose cut falls at Q2, a turn's start: one summary call per compaction.
    await seedHistory(stub, [
      Q1,
      cloudAnswer("q1", [{ type: "text", text: sized("answer one", 3000) }]),
      Q2,
      cloudAnswer("q2", [{ type: "text", text: sized("answer two", 5997) }]),
    ]);
    const held = await gate(stub);
    const model = new ScriptedModel().add([...text("first notes"), { hold: held }, finish()], notes("second notes"));
    useCloudModel(model);

    const compact = (jobId: string) =>
      runInDurableObject(stub, (instance) => prSessionSeams(instance).compactContext(model.model, WINDOW, { jobId }));
    const first = compact("first");
    await held.reached();
    const second = await compact("second");
    await held.open();

    expect([await first, second]).toEqual(["discarded", "adopted"]);
    expect(await notesRow(stub)).toMatchObject({ text: "second notes", rev: 1, cut_message_id: "q2", cut_step: 0 });
    expect(events(logs, "prq.compaction.discarded")).toMatchObject([{ jobId: "first", notesRev: 0 }]);
  });
});

describe("the next turn's context", () => {
  it("is the system prompt, the notes, the projection's kept part (a split turn's kept steps) and its question", async () => {
    captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client } = session;
    // Q2's answer read a file in its first step and answered in its second: the cut falls between them.
    const read = {
      type: "tool-read_file",
      toolCallId: "call-1",
      state: "output-available",
      input: { path: "src/app.ts" },
      output: sized("1\tfile text", 3000),
    } as const;
    const a2 = cloudAnswer("q2", [
      { type: "step-start" },
      read,
      { type: "step-start" },
      { type: "text", text: sized("answer two", 6000) },
    ]);
    await seedHistory(stub, [Q1, cloudAnswer("q1", [{ type: "text", text: sized("answer one", 3000) }]), Q2, a2]);
    // The last turn measured its context over the limit, and no compaction ran after it (a reset lost it).
    await sessionSql(
      stub,
      "UPDATE prq_session SET context_tokens = 18000, context_through = ?, context_notes_rev = 0 WHERE id = 1",
      a2.id,
    );
    const model = new ScriptedModel().add(notes("the notes"), notes("the turn's start"), answerScript("answer three"));
    model.contextTokens = WINDOW;
    useCloudModel(model);

    await client.chat([Q3]);
    await untilState(stub, "q3", "done");

    expect(model.calls.map(isSummaryCall)).toEqual([true, true, false]);
    const [history, prefix] = model.calls.filter(isSummaryCall).map(summaryPrompt);
    expect(history).toContain(`[User]: question q1\n\n[Assistant]: ${sized("answer one", 3000)}`);
    expect(prefix).toContain('[User]: question q2\n\n[Assistant tool calls]: read_file(path="src/app.ts")');
    expect(prefix).toContain("[... 7000 more characters truncated]");
    const stored = await notesRow(stub);
    expect(stored).toMatchObject({ rev: 1, cut_message_id: a2.id, cut_step: 1, read_files: '["src/app.ts"]' });
    const call = model.calls.at(-1);
    expect(call?.prompt[0]?.role).toBe("system");
    expect(turnPrompts(model).at(-1)).toEqual([
      { role: "user", text: notesText(stored.text ?? "") },
      { role: "assistant", text: sized("answer two", 6000) },
      { role: "user", text: "question q3" },
    ]);
    expect(stored.text).toBe(
      "the notes\n\n---\n\n**Turn Context (split turn):**\n\nthe turn's start\n\n<read-files>\nsrc/app.ts\n</read-files>",
    );
  });
});

describe("a lost compaction and a context-length refusal", () => {
  it("compacts at the next turn's start when a reset lost the compaction after a commit", async () => {
    const logs = captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { client } = session;
    const held = await gate(session.stub);
    const model = new ScriptedModel().add(...threeTurns(), [...text("lost notes"), { hold: held }, finish()]);
    model.contextTokens = WINDOW;
    useCloudModel(model);
    for (const asked of [[Q1], [Q1, Q2], [Q1, Q2, Q3]]) {
      await client.chat(asked);
      await untilState(session.stub, asked.at(-1)?.id ?? "", "done");
    }
    await held.reached();
    await client.chat([Q1, Q2, Q3, Q4]);
    await untilState(session.stub, "q4", "pending");

    await abortAllDurableObjects();
    model.add(notes("the notes"), notes("the turn's start"), answerScript("answer four"));
    const stub = await prSessionStub(env, session.ref);
    await untilState(stub, "q4", "done");

    expect(model.calls.map(isSummaryCall)).toEqual([false, false, false, true, true, true, false]);
    expect(await notesRow(stub)).toMatchObject({ rev: 1 });
    expect(turnPrompts(model).at(-1)?.[0]?.text).toBe(
      notesText("the notes\n\n---\n\n**Turn Context (split turn):**\n\nthe turn's start"),
    );
    expect(events(logs, "prq.compaction.done")).toMatchObject([{ jobId: (await jobOf(stub, "q4")).job_id }]);
  });

  it("compacts and re-runs a job once on a context-length refusal, then fails it with the provider's reason", async () => {
    const logs = captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client } = session;
    const message = "This model's maximum context length is 20000 tokens. However, you requested 21000 tokens.";
    const refusal = () =>
      new APICallError({
        message,
        url: "https://provider.example/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 400,
        responseBody: JSON.stringify({ error: { message, code: "invalid_request_error" } }),
        data: { error: { message, code: "invalid_request_error" } },
        isRetryable: false,
      });
    const model = new ScriptedModel().add(
      answerScript(sized("answer one", 7000), { input: 6000, output: 7000 }),
      { refuse: refusal() },
      notes("the turn's start"),
      { refuse: refusal() },
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    await client.chat([Q1]);
    await untilState(stub, "q1", "done");
    const before = await messageRows(session);

    await client.chat([Q1, Q2]);
    await untilState(stub, "q2", "failed");

    const q2 = await jobOf(stub, "q2");
    expect(q2.failure).toBe(`provider refused the request (HTTP 400): ${message}`);
    expect(model.calls.map(isSummaryCall)).toEqual([false, false, true, false]);
    // The re-run read the notes: the conversation before Q1's answer, which is kept.
    expect(
      turnPrompts(model)
        .at(-1)
        ?.map((entry) => entry.role),
    ).toEqual(["user", "assistant", "user"]);
    expect(await usageOf(stub, q2.job_id)).toMatchObject([{ run: 1, starts: 1, steps: 0 }]);
    expectAppended(before, await messageRows(session), ["q2"]);
    expect(events(logs, "prq.job.rerun")).toMatchObject([{ jobId: q2.job_id, run: 1 }]);
    expect(events(logs, "prq.job.usage").at(-1)).toMatchObject({ jobId: q2.job_id, overflowRerun: true });
  });
});

describe("the count after a compaction", () => {
  it.for([
    ["", false],
    [" after a reset", true],
  ] as const)(
    "estimates the new context%s until a model call measures it, so the next turn does not compact again",
    async ([, reset]) => {
      captureLogs();
      const session = await cloudSession("compaction", sockets);
      const model = new ScriptedModel().add(...threeTurns(), notes("the notes"), notes("the turn's start"));
      model.contextTokens = WINDOW;
      useCloudModel(model);
      for (const asked of [[Q1], [Q1, Q2], [Q1, Q2, Q3]]) {
        await session.client.chat(asked);
        await untilState(session.stub, asked.at(-1)?.id ?? "", "done");
      }
      await vi.waitFor(async () => expect((await notesRow(session.stub)).rev).toBe(1));
      if (reset) {
        await abortAllDurableObjects();
      }
      const stub = await prSessionStub(env, session.ref);
      const compact = vi.spyOn(prSessionSeams(PrSession.prototype), "compactContext");

      const { text: stored } = await notesRow(stub);
      const kept = 2 * sized("answer two", 3000).length + "question q3".length;
      const expected = Math.ceil((notesText(stored ?? "").length + kept + "question q4".length) / CHARS_PER_TOKEN);
      const counted = await runInDurableObject(stub, (instance) => prSessionSeams(instance).measureContext(Q4));
      expect(counted.tokens).toBe(expected);
      expect(counted.tokens).toBeLessThan(WINDOW - 2500);

      model.add(answerScript("answer four"));
      const client = reset ? await session.open() : session.client;
      await client.chat([Q1, Q2, Q3, Q4]);
      await untilState(stub, "q4", "done");
      expect(compact).not.toHaveBeenCalled();
    },
  );
});

describe("waiting questions", () => {
  it("are not summarized, and enter the kept part with their answers, though stored before the cut", async () => {
    captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client } = session;
    const turn = await gate(stub);
    const summary = await gate(stub);
    const QW = question("qw");
    const Q5 = question("q5");
    const model = new ScriptedModel().add(
      [...text(sized("answer one", 7000)), { hold: turn }, finish("stop", { input: 11_000, output: 7000 })],
      [...text("the turn's start"), { hold: summary }, finish()],
      answerScript("answer w"),
      answerScript("answer five"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);

    // QW is stored while Q1's turn runs, before Q1's answer, which the cut then falls on. Its request's turn waits
    // behind Q1's, so settle gives it its job.
    await client.chat([Q1]);
    await turn.reached();
    client.send({
      type: "cf_agent_use_chat_request",
      id: crypto.randomUUID(),
      init: { method: "POST", body: JSON.stringify({ messages: [Q1, QW], trigger: "submit-message" }) },
    });
    await vi.waitFor(async () => expect(await storedMessages(session.path, session.token)).toHaveLength(2));
    await stub.settle();
    await untilState(stub, "qw", "pending");
    await turn.open();
    await summary.reached();
    expect((await jobOf(stub, "qw")).state).toBe("pending");
    await summary.open();
    await untilState(stub, "qw", "done");
    await client.chat([Q1, QW, Q5]);
    await untilState(stub, "q5", "done");

    const a1 = `answer-${(await jobOf(stub, "q1")).job_id}`;
    expect(await notesRow(stub)).toMatchObject({ cut_message_id: a1, cut_step: 0 });
    const summaries = model.calls.filter(isSummaryCall).map(summaryPrompt);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("[User]: question q1");
    expect(summaries[0]).not.toContain("question qw");
    const texts = turnPrompts(model).map((prompt) => prompt.slice(1).map((message) => message.text));
    expect(texts[1]).toEqual([sized("answer one", 7000), "question qw"]);
    expect(texts[2]).toEqual([sized("answer one", 7000), "question qw", "answer w", "question q5"]);
  });
});

describe("the gate", () => {
  it("starts no job while a summary runs, whichever path hands it over, then exactly one", async () => {
    captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client, ref } = session;
    const summary = await gate(stub);
    const next = await gate(stub);
    const Q0 = question("q0");
    const model = new ScriptedModel().add(
      [...text("partial"), { fail: new Error("lost") }],
      ...threeTurns(),
      [...text("the notes"), { hold: summary }, finish()],
      notes("the turn's start"),
      [...text("answer zero"), { hold: next }, finish()],
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    useWorkspace();
    await client.chat([Q0]);
    await untilState(stub, "q0", "failed");
    for (const asked of [
      [Q0, Q1],
      [Q0, Q1, Q2],
      [Q0, Q1, Q2, Q3],
    ]) {
      await client.chat(asked);
      await untilState(stub, asked.at(-1)?.id ?? "", "done");
    }
    await summary.reached();
    const turns = () => model.calls.filter((call) => !isSummaryCall(call)).length;
    expect(turns()).toBe(4);

    // A chat question, a push, a retry of a failed job and a settle wake, while the summary runs.
    await client.chat([Q0, Q1, Q2, Q3, Q4]);
    await push(ref, "a");
    expect(await retryIn(stub, (await jobOf(stub, "q0")).job_id)).toEqual({ status: "retried" });
    await stub.settle();
    const states = async () =>
      (
        await runInDurableObject(stub, (_, state) =>
          state.storage.sql
            .exec<{ state: string }>("SELECT state FROM prq_jobs WHERE state IN ('pending', 'running')")
            .toArray(),
        )
      ).map((row) => row.state);
    expect((await states()).toSorted()).toEqual(["pending", "pending", "pending"]);
    expect(turns()).toBe(4);

    await summary.open();
    await next.reached();
    expect((await states()).toSorted()).toEqual(["pending", "pending", "running"]);
    expect(turns()).toBe(5);
    expect((await jobOf(stub, "q0")).state).toBe("running");
    await next.open();
  });
});

describe("a small window", () => {
  it("compacts a 20,000-token window's context at 18,000 tokens and not at 12,000, each request within the window", async () => {
    const logs = captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client } = session;
    const model = new ScriptedModel().add(...threeTurns(), notes("the notes"), notes("the turn's start"));
    model.contextTokens = WINDOW;
    useCloudModel(model);
    const compact = vi.spyOn(prSessionSeams(PrSession.prototype), "compactContext");

    await client.chat([Q1]);
    await untilState(stub, "q1", "done");
    await client.chat([Q1, Q2]);
    await untilState(stub, "q2", "done");
    expect(await contextRow(stub)).toMatchObject({ context_tokens: 12_000 });
    expect(compact).not.toHaveBeenCalled();

    await client.chat([Q1, Q2, Q3]);
    await untilState(stub, "q3", "done");
    await vi.waitFor(async () => expect((await notesRow(stub)).rev).toBe(1));

    expect(compact).toHaveBeenCalledOnce();
    expect(events(logs, "prq.compaction.skipped")).toEqual([]);
    // The kept part: Q2's answer, Q3 and its answer.
    const a2 = `answer-${(await jobOf(stub, "q2")).job_id}`;
    expect((await notesRow(stub)).cut_message_id).toBe(a2);
    const kept = [sized("answer two", 3000), "question q3", sized("answer three", 3000)];
    expect(Math.ceil(kept.join("").length / CHARS_PER_TOKEN)).toBeGreaterThanOrEqual(6000);
    for (const call of model.calls.filter(isSummaryCall)) {
      const prompt = summaryPrompt(call);
      const system = call.prompt[0]?.role === "system" ? call.prompt[0].content : "";
      expect(call.maxOutputTokens).toBe(4000);
      expect(Math.ceil((system.length + prompt.length) / CHARS_PER_TOKEN) + 4000).toBeLessThanOrEqual(WINDOW);
    }
  });
});

describe("the first step's room", () => {
  it("starts from the measured count, so a turn under the limit is offered its tools however large the request's estimate", async () => {
    captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client, ref } = session;
    // The analysis's text alone is estimated over the limit (18,000 tokens), while the provider measured its turn at
    // 12,000: the ratio a JSON-heavy context showed against DeepSeek's count.
    const model = new ScriptedModel().add(
      answerScript(sized("the summary", 18_000), { input: 9000, output: 3000 }),
      [toolCall("read_file", { path: "src/a.ts" }), finish("tool-calls", { input: 13_000, output: 50 })],
      answerScript("answer one", { input: 13_100, output: 50 }),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    useWorkspace(new FakeWorkspace({ head: { "src/a.ts": "export const a = 1;\n" } }));
    await push(ref, "a");
    await untilState(stub, sha("a"), "done");
    expect(await contextRow(stub)).toMatchObject({ context_tokens: 12_000, compaction_failed_through: null });

    await client.chat([Q1]);
    await untilState(stub, "q1", "done");

    expect(model.calls.slice(1).map((call) => call.tools?.length ?? 0)).toEqual([4, 4]);
    expect(model.calls.filter(isSummaryCall)).toEqual([]);
  });
});
