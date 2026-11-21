import { type Job, PROMPT_CHARS } from "@prq/protocol";
import type { UIMessage } from "ai";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { partsChars } from "./pr-session/compaction.ts";
import { contextBudget, contextLimit } from "./pr-session/context-budget.ts";
import type { PrSession } from "./pr-session/index.ts";
import { instructionPrefix } from "./pr-session/prefix.ts";
import { CHARS_PER_TOKEN } from "./pr-session/room.ts";
import { toolDefinitionsJson } from "./pr-session/turn-tools.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import { cloudSession, untilEnded, untilState } from "./test/cloud.ts";
import {
  cloudAnswer,
  contextRow,
  isSummaryCall,
  notesRow,
  prefixFingerprint,
  seedHistory,
  sized,
  WINDOW,
} from "./test/compaction.ts";
import {
  answerScript,
  textScript,
  type CallOptions,
  finish,
  ScriptedModel,
  text,
  useCloudModel,
  useWorkspace,
} from "./test/model.ts";
import { clearPrompts, gate, jobOf, prSessionSeams, savePrompt, sessionSql } from "./test/session.ts";
import { sentDefinitions, toolNames } from "./test/skill-turns.ts";
import { BASE, push, send, sha } from "./test/webhook.ts";
import { FakeWorkspace } from "./test/workspace.ts";

// The instruction prefix in the context's numbers (docs/design.md, Model context): a measurement counts only under the
// prefix it was taken under, the at-start cut leaves room for the prefix, and a turn whose start compacted sends its
// first request only when its estimate fits the window less the reserve.

const sockets: AgentSocket[] = [];

beforeEach(async () => {
  await clearPrompts();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const LIMIT = contextLimit(WINDOW);

function estimate(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// A recorded request's estimate as the context count makes it: its system message, the text of its messages and the
// tool definitions, characters ÷ 3. Only for requests offered publish alone, whose messages hold text only.
function requestEstimate(call: CallOptions | undefined): number {
  let chars = 0;
  for (const message of call?.prompt ?? []) {
    if (typeof message.content === "string") {
      chars += message.content.length;
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "text") {
        throw new Error(`a ${part.type} part in a request without tools`);
      }
      chars += part.text.length;
    }
  }
  expect(toolNames(call)).toEqual(["publish"]);
  return estimate(chars + sentDefinitions(call).length);
}

function summaryReply(heading: string, tokens: number) {
  return textScript(sized(`## ${heading}\nfacts`, tokens), { input: 100, output: 50 });
}

// A turn's prefix as an answer to a question asked before any push reads it.
async function answerPrefix(pr: { owner: string; repo: string; number: number }, hostPrompt: string) {
  const job: Job = {
    jobId: "00000000-0000-4000-8000-000000000001",
    pr,
    run: 1,
    target: { kind: "answer", messageId: "q" },
    workspaceSha: null,
  };
  return instructionPrefix({ pr, details: null, job, tools: false, hostPrompt });
}

describe("a measurement under another prefix", () => {
  it("is not reused: after a prompt edit, the count and the first step's room are estimated", async () => {
    captureLogs();
    const session = await cloudSession("prefix", sockets);
    const { stub, client, ref } = session;
    const hostPrompt = "Answer in the language of the question. ".repeat(50);
    // The answer's prefix with the edited prompt, as its turn will read it after the analysis of the push below.
    const details = {
      fullName: `${ref.owner}/${ref.repo}`,
      title: "A change",
      state: "open" as const,
      url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      headSha: sha("a"),
      baseSha: BASE,
    };
    const job: Job = {
      jobId: "00000000-0000-4000-8000-000000000001",
      pr: ref,
      run: 1,
      target: { kind: "answer", messageId: "q1" },
      workspaceSha: sha("a"),
    };
    const edited = await instructionPrefix({ pr: ref, details, job, tools: true, hostPrompt });
    const own = question("q1");
    const ownChars = "question q1".length;
    // An analysis whose text, with the edited prefix and the question, is estimated just under the limit, while the
    // provider measured its turn at 9,000 tokens.
    const summary = "s".repeat((LIMIT - 20) * CHARS_PER_TOKEN - edited.chars - ownChars);
    const model = new ScriptedModel().add(
      answerScript(summary, { input: 6000, output: 3000 }),
      answerScript("answer one"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    useWorkspace(new FakeWorkspace());
    await push(ref, "a");
    await untilState(stub, sha("a"), "done");
    expect((await stub.view()).details).toEqual(details);
    expect(await contextRow(stub)).toMatchObject({ context_tokens: 9000 });

    await savePrompt("answer", hostPrompt);
    const counts = await runInDurableObject(stub, async (instance) => {
      const seams = prSessionSeams(instance);
      const fingerprint = await prefixFingerprint({ kind: "analysis", tools: true });
      const before = { chars: 0, fingerprint, bare: null, toolChars: 0 };
      return {
        measuredPrefix: (await seams.measureContext(own, before)).tokens,
        editedPrefix: (await seams.measureContext(own, edited)).tokens,
      };
    });
    expect(counts).toEqual({ measuredPrefix: 9000 + estimate(ownChars), editedPrefix: LIMIT - 20 });

    await client.chat([own]);
    await untilState(stub, "q1", "done");
    // Started from the estimate, the turn's first step has no room for a tool result: publish alone is offered.
    expect(model.calls.map((call) => call.tools?.length ?? 0)).toEqual([5, 1]);
    expect(model.calls.filter(isSummaryCall)).toEqual([]);
  });
});

// Q1 and its answer of 3,000 estimated tokens, then Q2's answer in two steps: a read of `read` tokens, then text of
// `last` tokens. Measured just under the limit under the empty prompt, through Q2's answer.
async function seedTwoExchanges(stub: DurableObjectStub<PrSession>, read: number, last: number): Promise<void> {
  const a2: UIMessage = cloudAnswer("q2", [
    { type: "step-start" },
    {
      type: "tool-read_file",
      toolCallId: "call-1",
      state: "output-available",
      input: { path: "src/a.ts" },
      output: "r".repeat(read * CHARS_PER_TOKEN),
    },
    { type: "step-start" },
    { type: "text", text: sized("answer two", last) },
  ]);
  await seedHistory(stub, [
    question("q1"),
    cloudAnswer("q1", [{ type: "text", text: sized("answer one", 3000) }]),
    question("q2"),
    a2,
  ]);
  await sessionSql(
    stub,
    `UPDATE prq_session SET context_tokens = ?, context_through = ?, context_notes_rev = 0, context_fingerprint = ?
     WHERE id = 1`,
    LIMIT - 500,
    a2.id,
    await prefixFingerprint(),
  );
}

describe("a prompt that takes the context over the limit", () => {
  // A legal prompt and a long question (1,500 estimated tokens) at a 20,000-token window.
  const hostPrompt = "p".repeat(PROMPT_CHARS);
  const longQuestion = "q".repeat(1500 * CHARS_PER_TOKEN);

  it("compacts first when a prompt saved after a measured turn takes the count over the limit", async () => {
    captureLogs();
    const session = await cloudSession("prefix", sockets);
    const { stub, client } = session;
    // Measured 500 tokens under the limit under the empty prompt; the prompt at its cap adds about 2,700.
    await seedTwoExchanges(stub, 8900, 3000);
    await savePrompt("answer", hostPrompt);
    const model = new ScriptedModel().add(
      summaryReply("Key facts", 2000),
      summaryReply("Progress So Far", 50),
      answerScript("answer three"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);

    await client.chat([question("q3")]);
    expect(await untilEnded(stub, "q3")).toEqual({ state: "done", failure: null });

    expect(model.calls.map(isSummaryCall)).toEqual([true, true, false]);
  });

  it("compacts at the turn's start to a tail that fits beside the prefix: the first request is within the limit", async () => {
    captureLogs();
    const session = await cloudSession("prefix", sockets);
    const { stub, client, ref } = session;
    // Kept whole, the read and the text after it (11,910 tokens) would leave the request over the limit beside the
    // prefix, the notes and the question.
    await seedTwoExchanges(stub, 8900, 3000);
    await savePrompt("answer", hostPrompt);
    const model = new ScriptedModel().add(
      summaryReply("Key facts", 2000),
      summaryReply("Progress So Far", 50),
      answerScript("answer three"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);

    await client.chat([question("q3", longQuestion)]);
    expect(await untilEnded(stub, "q3")).toEqual({ state: "done", failure: null });

    expect(model.calls.map(isSummaryCall)).toEqual([true, true, false]);
    // The cut keeps the text step only.
    expect(await notesRow(stub)).toMatchObject({ rev: 1, cut_message_id: "answer-job-q2", cut_step: 1 });
    const prefix = await answerPrefix(ref, hostPrompt);
    const first = model.calls.at(-1);
    expect(requestEstimate(first)).toBeLessThanOrEqual(LIMIT);
    expect(first?.prompt[0]).toEqual({ role: "system", content: prefix.system });
  });

  it("fails before any answer request when the compacted request still does not fit, naming the sizes", async () => {
    captureLogs();
    const session = await cloudSession("prefix", sockets);
    const { stub, client } = session;
    // The newest step alone is 9,000 tokens, and a split cut makes two summaries of 3,000 tokens each.
    await seedTwoExchanges(stub, 3000, 9000);
    await savePrompt("answer", hostPrompt);
    const model = new ScriptedModel().add(
      summaryReply("Key facts", 3000),
      summaryReply("Progress So Far", 3000),
      answerScript("answer three"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);

    await client.chat([question("q3", longQuestion)]);
    const ended = await untilEnded(stub, "q3");

    expect(model.calls.map(isSummaryCall)).toEqual([true, true]);
    expect(await notesRow(stub)).toMatchObject({ rev: 1, cut_message_id: "answer-job-q2", cut_step: 1 });
    expect(ended.state).toBe("failed");
    expect(ended.failure).toMatch(
      new RegExp(
        `^context: after compacting, the request takes about \\d+ of the ${LIMIT} tokens this model's window leaves ` +
          "for it \\(the system prompt with the host's prompt and the tool definitions about \\d+, the notes about " +
          "\\d+, the kept conversation about 9000, the question about 1500\\); shorten the prompt or the question, " +
          "or use a model with a larger window$",
      ),
    );
    expect((await jobOf(stub, "q3")).state).toBe("failed");
  });
});

describe("a split cut at a turn's start", () => {
  it("leaves room for both summaries: a cut at the last step fits where one at the turn's first step would not", async () => {
    captureLogs();
    const window = 16_384;
    const session = await cloudSession("prefix", sockets);
    const { stub, client } = session;
    // An older exchange, then a question whose answer has two text steps of 10,500 and 3,000 characters.
    await seedHistory(stub, [
      question("q0", "a".repeat(15_000)),
      cloudAnswer("q0", [{ type: "text", text: "b".repeat(15_000) }]),
      question("q1", "c".repeat(15_000)),
      cloudAnswer("q1", [
        { type: "step-start" },
        { type: "text", text: "d".repeat(10_500) },
        { type: "step-start" },
        { type: "text", text: "e".repeat(3000) },
      ]),
    ]);
    await savePrompt("answer", "p".repeat(PROMPT_CHARS));
    // The history's summary and the turn's checkpoint, each 9,000 characters, within the notes' output limit.
    expect(contextBudget(window).notesOutput).toBeGreaterThan(3000);
    const model = new ScriptedModel().add(
      summaryReply("Key facts", 3000),
      summaryReply("Progress So Far", 3000),
      answerScript("answer two"),
    );
    model.contextTokens = window;
    useCloudModel(model);

    await client.chat([question("q2", "q".repeat(9000))]);
    expect(await untilEnded(stub, "q2")).toEqual({ state: "done", failure: null });

    expect(model.calls.map(isSummaryCall)).toEqual([true, true, false]);
    expect(await notesRow(stub)).toMatchObject({ rev: 1, cut_message_id: "answer-job-q1", cut_step: 1 });
    expect(requestEstimate(model.calls.at(-1))).toBeLessThanOrEqual(contextLimit(window));
  });
});

describe("a delivery taken in during the at-start compaction", () => {
  it("gives the first request the pull request's base as it is after the compaction", async () => {
    captureLogs();
    const session = await cloudSession("prefix", sockets);
    const { stub, client, ref } = session;
    const workspace = new FakeWorkspace();
    useWorkspace(workspace);
    const held = await gate(stub);
    const model = new ScriptedModel().add(
      answerScript("the summary"),
      [...text("## Key facts\nthe notes"), { hold: held }, finish()],
      textScript("## Progress So Far\nthe turn's start"),
      answerScript("answer two"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    await push(ref, "h");
    await untilState(stub, sha("h"), "done");
    // A question and its answer, the context then measured over the window by a refusal: the next turn compacts first.
    const a1 = cloudAnswer("q1", [{ type: "text", text: sized("answer one", 9000) }]);
    await seedHistory(stub, [question("q1"), a1]);
    await sessionSql(
      stub,
      `UPDATE prq_session SET context_tokens = ?, context_through = ?, context_notes_rev = 0, context_overflow = 1
       WHERE id = 1`,
      WINDOW,
      a1.id,
    );

    await client.chat([question("q2")]);
    await held.reached();
    await send(ref, { action: "edited", head: sha("h"), base: sha("B") });
    await vi.waitFor(async () => expect((await stub.view()).details?.baseSha).toBe(sha("B")));
    await held.open();
    expect(await untilEnded(stub, "q2")).toEqual({ state: "done", failure: null });

    expect(model.calls.map(isSummaryCall)).toEqual([false, true, true, false]);
    expect(workspace.prepares.at(-1)?.baseSha).toBe(sha("B"));
    const system = model.calls.at(-1)?.prompt[0];
    expect(system?.role === "system" ? system.content : "").toContain(`\nBase: ${sha("B")}\n`);
  });
});

describe("a split cut and a whole-turn cut at a turn's start", () => {
  it("takes the whole-turn cut that fits where a later split cut, with its two summaries, would not", async () => {
    captureLogs();
    const window = 16_384;
    const session = await cloudSession("prefix", sockets);
    const { stub, client } = session;
    // An older exchange, then a short question whose answer has steps of 1,500 and 5,700 characters.
    await seedHistory(stub, [
      question("q0", "a".repeat(15_000)),
      cloudAnswer("q0", [{ type: "text", text: "b".repeat(15_000) }]),
      question("q1", "c".repeat(150)),
      cloudAnswer("q1", [
        { type: "step-start" },
        { type: "text", text: "d".repeat(1500) },
        { type: "step-start" },
        { type: "text", text: "e".repeat(5700) },
      ]),
    ]);
    await savePrompt("answer", "p".repeat(PROMPT_CHARS));
    // A summary of about 9,500 characters, within the notes' output limit, then the answer.
    const model = new ScriptedModel().add(summaryReply("Key facts", 3166), answerScript("answer two"));
    model.contextTokens = window;
    useCloudModel(model);

    await client.chat([question("q2", "q".repeat(13_000))]);
    expect(await untilEnded(stub, "q2")).toEqual({ state: "done", failure: null });

    // The cut at Q1 keeps its whole exchange and needs the history's summary only.
    expect(model.calls.map(isSummaryCall)).toEqual([true, false]);
    expect(await notesRow(stub)).toMatchObject({ rev: 1, cut_message_id: "q1", cut_step: 0 });
    expect(requestEstimate(model.calls.at(-1))).toBeLessThanOrEqual(contextLimit(window));
  });

  it("sizes each candidate as the notes it makes are sent: a whole-turn cut at the limit before their wrappers does not fit", async () => {
    captureLogs();
    const window = 16_384;
    const { notesOutput } = contextBudget(window);
    const session = await cloudSession("prefix", sockets);
    const { stub, client, ref } = session;
    // An older exchange, then a question of 9,000 characters whose answer has two steps of 3,000.
    await seedHistory(stub, [
      question("q0", "a".repeat(15_000)),
      cloudAnswer("q0", [{ type: "text", text: "b".repeat(15_000) }]),
      question("q1", "c".repeat(9000)),
      cloudAnswer("q1", [
        { type: "step-start" },
        { type: "text", text: "d".repeat(3000) },
        { type: "step-start" },
        { type: "text", text: "e".repeat(3000) },
      ]),
    ]);
    const hostPrompt = "p".repeat(PROMPT_CHARS);
    await savePrompt("answer", hostPrompt);
    // The prefix and the new question take 18,180 characters: beside them, the cut at Q1 keeps 15,000 and one summary
    // at the notes' output limit reaches the limit exactly, before the notice and tags the notes are sent in.
    const fixed = 18_180;
    expect(estimate(fixed) + estimate(15_000) + notesOutput).toBe(contextLimit(window));
    const prefix = await answerPrefix(ref, hostPrompt);
    const model = new ScriptedModel().add(
      summaryReply("Key facts", notesOutput),
      summaryReply("Progress So Far", notesOutput),
      answerScript("answer two"),
    );
    model.contextTokens = window;
    useCloudModel(model);

    await client.chat([question("q2", "q".repeat(fixed - prefix.chars))]);
    expect(await untilEnded(stub, "q2")).toEqual({ state: "done", failure: null });

    // The cut at the answer's last step fits with both summaries as they are sent.
    expect(model.calls.map(isSummaryCall)).toEqual([true, true, false]);
    expect(await notesRow(stub)).toMatchObject({ rev: 1, cut_message_id: "answer-job-q1", cut_step: 1 });
    expect(requestEstimate(model.calls.at(-1))).toBeLessThanOrEqual(contextLimit(window));
  });
});

describe("a measurement taken after the tools were withdrawn", () => {
  const window = 16_384;
  const limit = contextLimit(window);
  const SUMMARY = "the summary";

  // An analysis offered publish alone from its first step: with its prefix, the conversation before it is estimated at
  // 14,260 tokens, which leaves less room than a tool result needs. The provider measures its one step at `measured`
  // tokens, and its text is `summary`.
  async function withdrawnAnalysis(measured: number, summary: string) {
    const session = await cloudSession("prefix", sockets);
    const { stub, ref } = session;
    useWorkspace(new FakeWorkspace());
    const details = {
      fullName: `${ref.owner}/${ref.repo}`,
      title: "A change",
      state: "open" as const,
      url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      headSha: sha("a"),
      baseSha: BASE,
    };
    const job: Job = {
      jobId: "00000000-0000-4000-8000-000000000001",
      pr: ref,
      run: 1,
      target: { kind: "analysis", headSha: sha("a") },
      workspaceSha: sha("a"),
    };
    const prefix = await instructionPrefix({ pr: ref, details, job, tools: true, hostPrompt: "" });
    const asked = question("q0");
    const history = 14_260 * CHARS_PER_TOKEN - prefix.chars - partsChars(asked.parts);
    await seedHistory(stub, [asked, cloudAnswer("q0", [{ type: "text", text: "h".repeat(history) }])]);
    // Two spare replies, which a compaction's summary calls would take, so a question still gets an answer.
    const model = new ScriptedModel().add(
      answerScript(summary, { input: measured - 10, output: 10 }),
      answerScript("answer one"),
      answerScript("spare one"),
      answerScript("spare two"),
    );
    model.contextTokens = window;
    useCloudModel(model);
    await push(ref, "a");
    await untilState(stub, sha("a"), "done");
    expect((await stub.view()).details).toEqual(details);
    expect(toolNames(model.calls[0])).toEqual(["publish"]);
    return { ...session, model };
  }

  it("counts the tool definitions the next request adds, so it offers publish alone where they would not fit", async () => {
    captureLogs();
    // Measured 40 tokens plus the definitions the withdrawal left out under the limit: with them, the next question
    // leaves less room than a tool result needs.
    const definitions = Math.ceil(
      ((await toolDefinitionsJson({ workspace: true, skills: false })).length -
        (await toolDefinitionsJson({ workspace: false, skills: false })).length) /
        CHARS_PER_TOKEN,
    );
    const { stub, client, model } = await withdrawnAnalysis(limit - definitions - 40, SUMMARY);

    await client.chat([question("q1")]);
    await untilState(stub, "q1", "done");
    expect(model.calls.map((call) => call.tools?.length ?? 0)).toEqual([1, 1]);
    expect(model.calls.filter(isSummaryCall)).toEqual([]);
  });

  it("starts the next question from the measurement and the definitions, offering its tools", async () => {
    captureLogs();
    // The estimate of the whole request would leave no room for a tool result; the measurement and the definitions,
    // about 14,000, do.
    const { stub, client, model } = await withdrawnAnalysis(13_200, SUMMARY);

    await client.chat([question("q1")]);
    await untilState(stub, "q1", "done");
    expect(model.calls.map((call) => call.tools?.length ?? 0)).toEqual([1, 5]);
    expect(model.calls.filter(isSummaryCall)).toEqual([]);
  });

  it("does not compact after the commit when the estimate alone would be over the limit", async () => {
    captureLogs();
    // 390 characters more of text take the estimate over the limit; the measurement and the definitions stay under.
    const { stub, client, model } = await withdrawnAnalysis(13_200, `${SUMMARY}${"s".repeat(390)}`);

    await client.chat([question("q1")]);
    await untilState(stub, "q1", "done");
    expect(model.calls.filter(isSummaryCall)).toEqual([]);
    expect(model.calls.map((call) => call.tools?.length ?? 0)).toEqual([1, 5]);
  });
});
