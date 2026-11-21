import { type Job, PROMPT_CHARS } from "@prq/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Hub } from "./hub.ts";
import { contextLimit } from "./pr-session/context-budget.ts";
import { HUB_CALL_MS, PrSession } from "./pr-session/index.ts";
import { instructionPrefix } from "./pr-session/prefix.ts";
import { systemPrompt } from "./pr-session/prompt.ts";
import { CHARS_PER_TOKEN } from "./pr-session/room.ts";
import { MIN_RESULT_CHARS, TOOL_RESULT_CHARS } from "./pr-session/tools.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import { cloudSession, untilEnded, untilState } from "./test/cloud.ts";
import {
  cloudAnswer,
  isSummaryCall,
  prefixFingerprint,
  seedHistory,
  sized,
  summaryPrompt,
  WINDOW,
} from "./test/compaction.ts";
import {
  answerScript,
  textScript,
  type CallOptions,
  finish,
  ScriptedModel,
  toolCall,
  useCloudModel,
  useWorkspace,
} from "./test/model.ts";
import { advance, until } from "./test/provider.ts";
import { clearPrompts, gate, hub, jobOf, prSessionSeams, retryIn, savePrompt, sessionSql } from "./test/session.ts";
import { BASE, push, sha } from "./test/webhook.ts";
import { FakeWorkspace } from "./test/workspace.ts";

// The host's prompts in cloud turns (docs/design.md, Instructions and skills; Model context): each turn reads its kind's
// prompt once at its start, before any compaction, and the system prompt keeps it apart from the core's text.

const sockets: AgentSocket[] = [];

beforeEach(async () => {
  await clearPrompts();
});

afterEach(() => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const ANALYSIS_PROMPT = "ANALYSIS-MARKER: write the summary as a list.";
const ANSWER_PROMPT = "ANSWER-MARKER: answer in one sentence.";

function systemOf(call: CallOptions | undefined): string {
  const [first] = call?.prompt ?? [];
  if (first?.role !== "system") {
    throw new Error("the call has no system message");
  }
  return first.content;
}

function hostBlock(kind: "summaries" | "answers", prompt: string): string {
  return `Instructions from the host for ${kind}:\n<host-instructions>\n${prompt}\n</host-instructions>`;
}

describe("the system prompt", () => {
  const pr = { owner: "octo", repo: "widgets", number: 7 };
  const head = sha("head");
  const details = {
    fullName: "octo/widgets",
    title: "A change",
    state: "open" as const,
    url: "https://github.com/octo/widgets/pull/7",
    headSha: head,
    baseSha: BASE,
  };
  const analysis: Job = {
    jobId: "00000000-0000-4000-8000-000000000001",
    pr,
    run: 1,
    target: { kind: "analysis", headSha: head },
    workspaceSha: head,
  };
  const early: Job = { ...analysis, target: { kind: "answer", messageId: "q1" }, workspaceSha: null };

  it("with no prompt, is the core's lines, the pull request's facts and the job's lines, byte for byte", () => {
    expect(systemPrompt({ pr, details, job: analysis, tools: true, hostPrompt: "" }).text).toBe(
      [
        "You work on one GitHub pull request: you summarize it and answer questions about it.",
        "You deliver your answer by calling publish with the complete answer; text you write outside it is not shown.",
        `A tool's result is cut at ${TOOL_RESULT_CHARS} characters; a note at its end says how to read the next page.`,
        "When the conversation has no room for more, the tools other than publish are withdrawn: answer from what you " +
          "have read.",
        "Pull request: octo/widgets#7",
        "Title: A change",
        "URL: https://github.com/octo/widgets/pull/7",
        "Repository: octo/widgets",
        `Base: ${BASE}`,
        `Head: ${head}`,
        `Your job: summarize the pull request at head ${head}.`,
        `Your tools read the repository at commit ${head} through git: list_files, read_file and grep read that ` +
          "commit, and diff shows the pull request's change against its base.",
      ].join("\n"),
    );
    // A blank prompt is no prompt.
    expect(systemPrompt({ pr, details: null, job: early, tools: false, hostPrompt: " \n" }).text).toBe(
      [
        "You work on one GitHub pull request: you summarize it and answer questions about it.",
        "You deliver your answer by calling publish with the complete answer; text you write outside it is not shown.",
        "Pull request: octo/widgets#7",
        "Its details are not known yet: no webhook has arrived.",
        "Your job: answer the last question. No push has been seen yet, so there is no code to read.",
      ].join("\n"),
    );
  });

  it("puts the host's prompt after the core's lines and before the pull request, the job's lines last", () => {
    const { text: system, instructions } = systemPrompt({
      pr,
      details,
      job: analysis,
      tools: true,
      hostPrompt: ANALYSIS_PROMPT,
    });
    const slots = [
      "You work on one GitHub pull request",
      "When the conversation has no room for more",
      hostBlock("summaries", ANALYSIS_PROMPT),
      "Pull request: octo/widgets#7",
      `Head: ${head}`,
      "Your job: summarize",
      "Your tools read the repository at commit",
    ].map((slot) => system.indexOf(slot));
    expect(slots.every((at) => at >= 0)).toBe(true);
    expect(slots).toEqual(slots.toSorted((a, b) => a - b));
    // The instruction part, which the measurement's fingerprint covers, ends with the host's prompt.
    expect(system.startsWith(`${instructions}\nPull request:`)).toBe(true);
    expect(instructions.endsWith(hostBlock("summaries", ANALYSIS_PROMPT))).toBe(true);
    expect(system).not.toContain("for answers");
  });
});

describe("a cloud turn's prompt", () => {
  it("is its job kind's: an analysis carries the analysis prompt and an answer the answer prompt, never the other", async () => {
    captureLogs();
    const session = await cloudSession("prompts", sockets);
    const { stub, client, ref } = session;
    await savePrompt("analysis", ANALYSIS_PROMPT);
    await savePrompt("answer", ANSWER_PROMPT);
    const model = new ScriptedModel().add(answerScript("the summary"), answerScript("the answer"));
    useCloudModel(model);
    useWorkspace(new FakeWorkspace());

    await push(ref, "a");
    await untilState(stub, sha("a"), "done");
    await client.chat([question("q1")]);
    await untilState(stub, "q1", "done");

    const [summary, answer] = model.calls.map(systemOf);
    expect(summary).toContain(hostBlock("summaries", ANALYSIS_PROMPT));
    expect(summary).not.toContain("ANSWER-MARKER");
    expect(answer).toContain(hostBlock("answers", ANSWER_PROMPT));
    expect(answer).not.toContain("ANALYSIS-MARKER");
  });

  it("stays the one its turn started with while a prompt is saved, and the next job's turn carries the new one", async () => {
    captureLogs();
    const session = await cloudSession("prompts", sockets);
    const { stub, client, ref } = session;
    await savePrompt("analysis", ANALYSIS_PROMPT);
    const held = await gate(stub);
    const model = new ScriptedModel().add(
      // The first step calls a tool and holds before it finishes; the second step's request follows the tool's result.
      [toolCall("read_file", { path: "src/a.ts" }), { hold: held }, finish("tool-calls")],
      answerScript("the summary"),
      answerScript("the answer"),
      answerScript("the second summary"),
    );
    useCloudModel(model);
    useWorkspace(new FakeWorkspace({ head: { "src/a.ts": "export const a = 1;\n" } }));

    await push(ref, "a");
    await held.reached();
    await savePrompt("analysis", "SAVED-DURING-THE-TURN");
    await savePrompt("answer", ANSWER_PROMPT);
    await held.open();
    await untilState(stub, sha("a"), "done");
    await client.chat([question("q1")]);
    await untilState(stub, "q1", "done");
    // The next analysis, of a second head, reads the prompt saved during the first.
    await push(ref, "b");
    await untilState(stub, sha("b"), "done");

    const [first, second, next, later] = model.calls.map(systemOf);
    expect(first).toContain(hostBlock("summaries", ANALYSIS_PROMPT));
    expect(second).toBe(first);
    expect(next).toContain(hostBlock("answers", ANSWER_PROMPT));
    expect([first, second, next].some((system) => system?.includes("SAVED-DURING-THE-TURN"))).toBe(false);
    expect(later).toContain(hostBlock("summaries", "SAVED-DURING-THE-TURN"));
  });

  it("reaches no compaction: summary requests carry neither prompt", async () => {
    captureLogs();
    const session = await cloudSession("prompts", sockets);
    const { stub, client } = session;
    await savePrompt("analysis", ANALYSIS_PROMPT);
    await savePrompt("answer", ANSWER_PROMPT);
    // Three answers of 3,000 estimated tokens each, the last measured over the limit: a compaction after its commit.
    const model = new ScriptedModel().add(
      answerScript(sized("answer one", 3000), { input: 3000, output: 3000 }),
      answerScript(sized("answer two", 3000), { input: 9000, output: 3000 }),
      answerScript(sized("answer three", 3000), { input: 15_000, output: 3000 }),
      textScript("## Key facts\nthe notes", { input: 100, output: 50 }),
      textScript("## Progress So Far\nthe turn's start", { input: 100, output: 50 }),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    const asked = [question("q1"), question("q2"), question("q3")];
    for (const [index, message] of asked.entries()) {
      await client.chat(asked.slice(0, index + 1));
      await untilState(stub, message.id, "done");
    }
    await vi.waitFor(() => expect(model.calls.filter(isSummaryCall)).toHaveLength(2));

    const summaries = model.calls.filter(isSummaryCall);
    for (const call of summaries) {
      const request = `${systemOf(call)}\n${summaryPrompt(call)}`;
      expect(request).not.toContain("MARKER");
      expect(request).not.toContain("host-instructions");
    }
    const turns = model.calls.filter((call) => !isSummaryCall(call));
    expect(turns.every((call) => systemOf(call).includes(hostBlock("answers", ANSWER_PROMPT)))).toBe(true);
  });
});

// Holds the Hub's instruction reads at a gate, which no test opens: the read never answers.
async function holdInstructions(): Promise<void> {
  const held = await gate(await hub());
  vi.spyOn(Hub.prototype, "instructions").mockImplementation(async () => {
    await held.wait();
    throw new Error("the held read was released");
  });
}

describe("the instruction read at a turn's start", () => {
  it("fails the job, retryably, when the Hub does not answer within the bound, before any model call or compaction", async () => {
    captureLogs();
    const session = await cloudSession("prompts", sockets);
    const { stub, client } = session;
    // A context measured over the limit: a summary call is due at the next turn's start.
    const a2 = cloudAnswer("q2", [{ type: "text", text: sized("answer two", 9000) }]);
    await seedHistory(stub, [
      question("q1"),
      cloudAnswer("q1", [{ type: "text", text: sized("answer one", 9000) }]),
      question("q2"),
      a2,
    ]);
    await sessionSql(
      stub,
      `UPDATE prq_session SET context_tokens = 18000, context_through = ?, context_notes_rev = 0,
         context_fingerprint = ? WHERE id = 1`,
      a2.id,
      await prefixFingerprint(),
    );
    const model = new ScriptedModel().add(
      textScript("## Key facts\nthe notes", { input: 100, output: 50 }),
      textScript("## Progress So Far\nthe turn's start", { input: 100, output: 50 }),
      answerScript("answer three"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    await holdInstructions();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await client.chat([question("q3")]);
    await until(async () => (await jobOf(stub, "q3")).state === "running", "the turn's start");
    await advance(stub, HUB_CALL_MS - 1);
    expect((await jobOf(stub, "q3")).state).toBe("running");
    await advance(stub, 1);
    await until(async () => (await jobOf(stub, "q3")).state === "failed", "the failure");

    expect((await jobOf(stub, "q3")).failure).toBe(`instructions: the Hub's instructions took over ${HUB_CALL_MS} ms`);
    expect(model.calls).toEqual([]);

    // The host's retry runs the job again, once the Hub answers.
    vi.useRealTimers();
    vi.restoreAllMocks();
    useCloudModel(model);
    expect(await retryIn(stub, (await jobOf(stub, "q3")).job_id)).toEqual({ status: "retried" });
    await untilState(stub, "q3", "done");
    expect(model.calls.map(isSummaryCall)).toEqual([true, true, false]);
  });

  it("fails a job with tools whose prefix and own message leave no room for one tool result, before any model call", async () => {
    captureLogs();
    const hostPrompt = "x".repeat(PROMPT_CHARS);
    await savePrompt("answer", hostPrompt);
    const window = 16_384;
    const room = contextLimit(window);
    const model = new ScriptedModel().add(
      answerScript("the summary"),
      answerScript("the summary"),
      answerScript("the answer"),
    );
    model.contextTokens = window;
    useCloudModel(model);
    useWorkspace(new FakeWorkspace());
    // After a push, an answer reads the workspace through tools: the longest question that fits beside the prefix and
    // one tool result, and one character more.
    const fits = async (sessionRef: { owner: string; repo: string; number: number }) => {
      const details = {
        fullName: `${sessionRef.owner}/${sessionRef.repo}`,
        title: "A change",
        state: "open" as const,
        url: `https://github.com/${sessionRef.owner}/${sessionRef.repo}/pull/${sessionRef.number}`,
        headSha: sha("a"),
        baseSha: BASE,
      };
      const job: Job = {
        jobId: "00000000-0000-4000-8000-000000000001",
        pr: sessionRef,
        run: 1,
        target: { kind: "answer", messageId: "q" },
        workspaceSha: sha("a"),
      };
      const prefix = await instructionPrefix({ pr: sessionRef, details, job, tools: true, hostPrompt });
      return { prefix, longest: room * CHARS_PER_TOKEN - prefix.chars - MIN_RESULT_CHARS };
    };

    const over = await cloudSession("prompts", sockets);
    await push(over.ref, "a");
    await untilState(over.stub, sha("a"), "done");
    const { prefix, longest } = await fits(over.ref);
    await over.client.chat([question("q-long", "y".repeat(longest + 1))]);
    expect(await untilEnded(over.stub, "q-long")).toEqual({
      state: "failed",
      failure:
        "instructions: the system prompt with the host's prompt and the tool definitions takes about " +
        `${Math.ceil(prefix.chars / 3)} tokens and the question about ${Math.ceil((longest + 1) / 3)}, of the ${room} ` +
        "tokens this model's window leaves for a request: too little room for one tool result; shorten the prompt or " +
        "the question",
    });
    expect(model.calls).toHaveLength(1);

    const inside = await cloudSession("prompts", sockets);
    await push(inside.ref, "a");
    await untilState(inside.stub, sha("a"), "done");
    const atLimit = await fits(inside.ref);
    await inside.client.chat([question("q-long", "y".repeat(atLimit.longest))]);
    await untilState(inside.stub, "q-long", "done");
    expect(model.calls).toHaveLength(3);
  });

  it("runs a job offered publish alone whose prefix and own message fit, leaving no room for a tool result", async () => {
    captureLogs();
    const window = 16_384;
    const room = contextLimit(window);
    const model = new ScriptedModel().add(answerScript("the answer"));
    model.contextTokens = window;
    useCloudModel(model);
    // Before any push, an answer is offered publish alone: the longest question that fits beside the prefix alone, which leaves
    // less than one tool result's room, and one character more.
    const inside = await cloudSession("prompts", sockets);
    const job: Job = {
      jobId: "00000000-0000-4000-8000-000000000001",
      pr: inside.ref,
      run: 1,
      target: { kind: "answer", messageId: "q" },
      workspaceSha: null,
    };
    const prefix = await instructionPrefix({ pr: inside.ref, details: null, job, tools: false, hostPrompt: "" });
    const longest = room * CHARS_PER_TOKEN - prefix.chars;
    await inside.client.chat([question("q-long", "y".repeat(longest))]);
    expect(await untilEnded(inside.stub, "q-long")).toEqual({ state: "done", failure: null });
    expect(model.calls).toHaveLength(1);

    const over = await cloudSession("prompts", sockets);
    await over.client.chat([question("q-long", "y".repeat(longest + 1))]);
    expect(await untilEnded(over.stub, "q-long")).toEqual({
      state: "failed",
      failure:
        `instructions: the system prompt with the host's prompt and the tool definitions takes about ` +
        `${Math.ceil(prefix.chars / 3)} tokens and ` +
        `the question about ${Math.ceil((longest + 1) / 3)}, of the ${room} tokens this model's window leaves for a ` +
        "request: too little room for the answer; shorten the prompt or the question",
    });
    expect(model.calls).toHaveLength(1);
  });
});

describe("the instruction read", () => {
  it("happens once per turn", async () => {
    captureLogs();
    const session = await cloudSession("prompts", sockets);
    const read = vi.spyOn(prSessionSeams(PrSession.prototype), "readInstructions");
    useCloudModel(new ScriptedModel().add(answerScript("the answer")));
    await session.client.chat([question("q1")]);
    await untilState(session.stub, "q1", "done");
    expect(read).toHaveBeenCalledOnce();
  });
});
