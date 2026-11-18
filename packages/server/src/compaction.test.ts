import { APICallError } from "ai";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prSessionStub } from "./names.ts";
import {
  assembleNotes,
  notesText,
  requestTokens,
  TURN_PREFIX_UPDATE_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
} from "./pr-session/compaction.ts";
import { PrSession } from "./pr-session/index.ts";
import { CHARS_PER_TOKEN } from "./pr-session/room.ts";
import { captureLogs, events } from "./test/access.ts";
import { type AgentSocket, question, storedMessages } from "./test/chat.ts";
import { cloudSession, expectAppended, messageRows, untilState, usageOf } from "./test/cloud.ts";
import {
  cloudAnswer,
  contextRow,
  fileRead,
  fourStepAnswer,
  isSummaryCall,
  type NotesRow,
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
      [...text(facts("the notes")), { hold: summary }, finish()],
      answerScript(progress("the turn's start")),
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
        text: notesText(splitNotes(facts("the notes"), progress("the turn's start"))),
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

// A summary script: its reply and a normal finish.
function notes(reply: string): Script {
  return answerScript(reply, { input: 100, output: 50 });
}

// Replies as their prompts ask for them: a history with text in one of the notes' sections, and a split turn's
// checkpoint with text in one of its own.
function facts(body: string): string {
  return `## Key facts\n${body}`;
}

function progress(body: string): string {
  return `## Progress So Far\n${body}`;
}

// The notes from a history and a split turn's checkpoint, before any file list.
function splitNotes(history: string, checkpoint: string): string {
  return `${history}\n\n---\n\n**Turn Context (split turn):**\n\n${checkpoint}`;
}

// Q1 and Q2 with their answers of 3,000 estimated tokens, as their commits stored them: the projection before the third
// of threeTurns, which then runs alone and compacts after its commit.
async function twoExchanges(stub: DurableObjectStub<PrSession>): Promise<void> {
  await seedHistory(stub, [
    Q1,
    cloudAnswer("q1", [{ type: "text", text: sized("answer one", 3000) }]),
    Q2,
    cloudAnswer("q2", [{ type: "text", text: sized("answer two", 3000) }]),
  ]);
}

// The third of threeTurns: its answer, measured over the limit.
function thirdTurn(): Script {
  return answerScript(sized("answer three", 3000), { input: 15_000, output: 3000 });
}

describe("failed summaries", () => {
  it.for([
    ["ends at its output limit", [...text("cut notes"), finish("length")]],
    ["is empty", [...text("  "), finish("stop")]],
    [
      "holds only wrappers prq generates, one inside another",
      [...text("<summary>\n<previous-summary>\n</previous-summary>\n</summary>"), finish("stop")],
    ],
    ["errors", [...text("partial notes"), { fail: new Error("stream lost") }]],
  ] satisfies [string, Script][])(
    "does not adopt a summary that %s, tries it once more, then leaves the notes and runs the next job on the full context",
    async ([, failed]) => {
      const logs = captureLogs();
      const session = await cloudSession("compaction", sockets);
      const { stub, client } = session;
      await twoExchanges(stub);
      const model = new ScriptedModel().add(thirdTurn(), failed, failed, answerScript("answer four"));
      model.contextTokens = WINDOW;
      useCloudModel(model);
      await client.chat([Q1, Q2, Q3]);
      await untilState(stub, "q3", "done");
      await client.chat([Q1, Q2, Q3, Q4]);
      await untilState(stub, "q4", "done");

      // The compaction ran after Q3's commit, not at Q4's start.
      const q3 = (await jobOf(stub, "q3")).job_id;
      expect(events(logs, "prq.compaction.started")).toMatchObject([{ jobId: q3 }]);
      expect(model.calls.filter(isSummaryCall)).toHaveLength(2);
      expect(await notesRow(stub)).toMatchObject({ text: null, rev: 0, cut_message_id: null });
      const a3 = `answer-${q3}`;
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

  it("keeps a tag the summary names in its body, and removes only the wrapper around it", async () => {
    captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client } = session;
    const body = [
      "## Decisions",
      "- Keep the `<summary>` element.",
      "- List the files between `<read-files>` and `</read-files>`, as `<conversation>` does its messages.",
    ].join("\n");
    await twoExchanges(stub);
    const model = new ScriptedModel().add(
      thirdTurn(),
      notes(`<summary>\n${body}\n</summary>`),
      notes(progress("the turn's start")),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    await client.chat([Q1, Q2, Q3]);
    await untilState(stub, "q3", "done");
    await vi.waitFor(async () => expect((await notesRow(stub)).rev).toBe(1));

    expect(await notesRow(stub)).toMatchObject({
      history: body,
      text: splitNotes(body, progress("the turn's start")),
    });
  });

  it("adopts the summary its second attempt makes", async () => {
    const logs = captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client } = session;
    await twoExchanges(stub);
    const model = new ScriptedModel().add(
      thirdTurn(),
      [...text("cut notes"), finish("length")],
      notes(facts("the notes")),
      notes(progress("the turn's start")),
      answerScript("answer four"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    for (const asked of [
      [Q1, Q2, Q3],
      [Q1, Q2, Q3, Q4],
    ]) {
      await client.chat(asked);
      await untilState(stub, asked.at(-1)?.id ?? "", "done");
    }

    expect(events(logs, "prq.compaction.started")).toMatchObject([{ jobId: (await jobOf(stub, "q3")).job_id }]);
    expect(model.calls.filter(isSummaryCall)).toHaveLength(3);
    expect(await notesRow(stub)).toMatchObject({
      text: splitNotes(facts("the notes"), progress("the turn's start")),
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
    const model = new ScriptedModel().add(
      [...text(facts("first notes")), { hold: held }, finish()],
      notes(facts("second notes")),
    );
    useCloudModel(model);

    const compact = (jobId: string) =>
      runInDurableObject(stub, (instance) => prSessionSeams(instance).compactContext(model.model, WINDOW, { jobId }));
    const first = compact("first");
    await held.reached();
    const second = await compact("second");
    await held.open();

    expect([await first, second]).toEqual(["discarded", "adopted"]);
    expect(await notesRow(stub)).toMatchObject({
      text: facts("second notes"),
      rev: 1,
      cut_message_id: "q2",
      cut_step: 0,
    });
    expect(events(logs, "prq.compaction.discarded")).toMatchObject([{ jobId: "first", notesRev: 0 }]);
  });
});

describe("a cut that stays inside a split turn", () => {
  it("updates that turn's checkpoint with the steps it removed, and leaves the history as it was", async () => {
    captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub } = session;
    // The notes were made with the cut at the third step of Q1's answer: the history before Q1, and Q1's turn up to
    // that step in its checkpoint.
    const a1 = fourStepAnswer();
    await seedHistory(stub, [Q1, a1, Q2, cloudAnswer("q2", [{ type: "text", text: sized("answer two", 3334) }])]);
    await sessionSql(
      stub,
      `UPDATE prq_notes SET text = ?, history = ?, turn_context = ?, rev = 1, cut_message_id = ?, cut_step = 2
       WHERE id = 1`,
      assembleNotes("the history", "the checkpoint", []),
      "the history",
      "the checkpoint",
      a1.id,
    );
    const model = new ScriptedModel().add(notes(progress("the checkpoint, read on")));
    useCloudModel(model);

    const result = await runInDurableObject(stub, (instance) =>
      prSessionSeams(instance).compactContext(model.model, WINDOW, { jobId: "job" }),
    );

    expect(result).toBe("adopted");
    const [call] = model.calls.filter(isSummaryCall);
    expect(model.calls).toHaveLength(1);
    const prompt = call === undefined ? "" : summaryPrompt(call);
    expect(prompt).toContain("<previous-summary>\nthe checkpoint\n</previous-summary>");
    expect(prompt).toContain('read_file(path="src/2.ts"); read_file(path="src/3.ts")');
    expect(prompt).not.toContain("src/1.ts");
    expect(prompt.endsWith(TURN_PREFIX_UPDATE_PROMPT)).toBe(true);
    expect(await notesRow(stub)).toMatchObject({
      text: assembleNotes("the history", progress("the checkpoint, read on"), ["src/2.ts", "src/3.ts"]),
      history: "the history",
      turn_context: progress("the checkpoint, read on"),
      rev: 2,
      cut_message_id: a1.id,
      cut_step: 3,
    });
  });
});

// Notes made with the cut at Q1, holding a decision and a read of src/a.ts, then Q1's answer, which read src/b.ts, and
// Q2's: the next cut falls in Q2's answer.
const DECIDED = "## Decisions\n- Keep the compatibility fallback";
// The notes' stored text: the history, then the list of src/a.ts.
const DECIDED_NOTES = `${DECIDED}\n\n<read-files>\nsrc/a.ts\n</read-files>`;

async function notesBeforeARead(stub: DurableObjectStub<PrSession>): Promise<void> {
  await seedHistory(stub, [
    Q1,
    cloudAnswer("q1", [
      { type: "step-start" },
      {
        type: "tool-read_file",
        toolCallId: "call-0",
        state: "output-available",
        input: { path: "src/b.ts" },
        output: "1\texport const fallback = true;",
      },
      { type: "step-start" },
      { type: "text", text: sized("answer one", 3000) },
    ]),
    Q2,
    cloudAnswer("q2", [{ type: "text", text: sized("answer two", 6000) }]),
  ]);
  await sessionSql(
    stub,
    `UPDATE prq_notes SET text = ?, history = ?, rev = 1, cut_message_id = 'q1', cut_step = 0, read_files = ?
     WHERE id = 1`,
    DECIDED_NOTES,
    DECIDED,
    JSON.stringify(["src/a.ts"]),
  );
}

// The compaction's outcome: failed, with the notes as they were, or adopted, with the reply as the history.
const NOT_ADOPTED = {
  result: "failed",
  notes: { history: DECIDED, text: DECIDED_NOTES, rev: 1 },
};

function adoptedWith(history: string) {
  const assembled = `${splitNotes(history, progress("the turn's start"))}\n\n<read-files>\nsrc/a.ts\nsrc/b.ts\n</read-files>`;
  return { result: "adopted", notes: { history, text: assembled, rev: 2 } };
}

describe("a summary's reply", () => {
  const ordinary = `${DECIDED}\n\n## Key facts\n- src/b.ts sets the fallback.`;
  const japanese = "## 目的\n互換性のための代替処理を残す。\n\n## 重要な事実\n- src/b.ts が代替処理を有効にしている。";
  const deeper = "### Decisions\n- Keep the compatibility fallback\n\n### Key facts\n- src/b.ts sets the fallback.";
  const indented =
    "## Key facts\n- Keep this exact block:\n\n  <read-files>\n  ALLOW_ONLY_CHANGED_FILES=false\n  </read-files>";
  const fixture = "## Decisions\n- Use this list as the fixture:\n\n<read-files>\nsrc/b.ts\n</read-files>";
  const fenced = `\`\`\`\n${DECIDED}\n\`\`\``;
  it.for([
    [
      "wrappers one inside another around only a file list",
      "<summary>\n<previous-summary>\n<read-files>\nsrc/a.ts\n</read-files>\n</previous-summary>\n</summary>",
      NOT_ADOPTED,
    ],
    [
      "wrappers the other way round around only a file list",
      "<previous-summary>\n<summary>\n<read-files>\nsrc/a.ts\n</read-files>\n</summary>\n</previous-summary>",
      NOT_ADOPTED,
    ],
    ["its prompt's headings with only blank sections", "## Decisions\n\n## Key facts\n   \n", NOT_ADOPTED],
    ["headings of its own language and level with only blank sections", "## 決定事項\n\n### 重要な事実\n", NOT_ADOPTED],
    ["blank sections inside a code fence", "```markdown\n## Decisions\n\n## Key facts\n```", NOT_ADOPTED],
    ["blank sections split by thematic breaks", "## Decisions\n---\n## Key facts\n\n* * *\n", NOT_ADOPTED],
    ["a summary inside a code fence", fenced, adoptedWith(fenced)],
    ["an ordinary summary", ordinary, adoptedWith(ordinary)],
    ["a summary with Japanese headings", japanese, adoptedWith(japanese)],
    ["a summary with third-level headings", deeper, adoptedWith(deeper)],
    [
      "an ordinary summary inside wrappers",
      `<previous-summary>\n<summary>\n${ordinary}\n</summary>\n</previous-summary>`,
      adoptedWith(ordinary),
    ],
    ["an indented <read-files> example inside a section", indented, adoptedWith(indented)],
    ["a file list it writes inside a section", fixture, adoptedWith(fixture)],
  ] satisfies [string, string, { result: string; notes: Partial<NotesRow> }][])(
    "is adopted only with a heading that has text under it, the file list its own: %s",
    async ([, reply, expected]) => {
      captureLogs();
      const session = await cloudSession("compaction", sockets);
      const { stub } = session;
      await notesBeforeARead(stub);
      // The reply tried twice when it is not adopted; otherwise the reply, then the split turn's start.
      const model = new ScriptedModel().add(
        notes(reply),
        expected.result === "failed" ? notes(reply) : notes(progress("the turn's start")),
      );
      useCloudModel(model);

      const result = await runInDurableObject(stub, (instance) =>
        prSessionSeams(instance).compactContext(model.model, WINDOW, { jobId: "job" }),
      );

      // The update request shows the stored history only, never a file list prq rendered.
      const [first] = model.calls.filter(isSummaryCall).map(summaryPrompt);
      expect(first).toContain(`<previous-summary>\n${DECIDED}\n</previous-summary>`);
      expect(first).toContain('read_file(path="src/b.ts")');
      expect(first).not.toContain("<read-files>");
      expect(result).toBe(expected.result);
      expect(await notesRow(stub)).toMatchObject(expected.notes);
    },
  );

  it("rejects a file-list-only reply naming the newly read file, and the next question still reads the decision", async () => {
    captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client } = session;
    await notesBeforeARead(stub);
    const reply = "<summary>\n<read-files>\nsrc/b.ts\n</read-files>\n</summary>";
    const model = new ScriptedModel().add(notes(reply), notes(reply), answerScript("answer after compact"));
    model.contextTokens = WINDOW;
    useCloudModel(model);

    const result = await runInDurableObject(stub, (instance) =>
      prSessionSeams(instance).compactContext(model.model, WINDOW, { jobId: "probe" }),
    );
    await client.chat([Q1, Q2, Q3]);
    await untilState(stub, "q3", "done");

    const stored = await notesRow(stub);
    const sawDecision = turnPrompts(model)
      .at(-1)
      ?.some((entry) => entry.text.includes(DECIDED));
    expect({ result, rev: stored.rev, cut: stored.cut_message_id, sawDecision }).toEqual({
      result: "failed",
      rev: 1,
      cut: "q1",
      sawDecision: true,
    });
  });

  it("keeps a file list the history holds as an example, after later cuts through the same turn carry it forward", async () => {
    captureLogs();
    const { stub, client } = await cloudSession("compaction", sockets);
    const path = "src/routes/<slug>.ts";
    const example = `<read-files>\nsrc/0.ts\nsrc/1.ts\nsrc/3.ts\n${path}\n</read-files>`;
    const history = `## Decisions\n- Use this exact list as the route-audit fixture:\n\n${example}`;
    // Q1's answer in five steps: reads of src/0.ts, src/1.ts, then src/<slug> and src/3.ts, then src/z.ts, then its
    // text, so that later cuts fall at its third, fourth and fifth steps.
    const a1 = cloudAnswer("q1", [
      { type: "step-start" },
      fileRead(0, "src/0.ts"),
      { type: "step-start" },
      fileRead(1, "src/1.ts"),
      { type: "step-start" },
      fileRead(2, path),
      fileRead(3, "src/3.ts"),
      { type: "step-start" },
      fileRead(4, "src/z.ts"),
      { type: "step-start" },
      { type: "text", text: "y".repeat(9000) },
    ]);
    await seedHistory(stub, [
      { ...question("q0"), parts: [{ type: "text", text: history }] },
      cloudAnswer("q0", [{ type: "text", text: "Keep that fixture exactly." }]),
      Q1,
      a1,
    ]);
    const model = new ScriptedModel().add(
      notes(history),
      notes(progress("initial checkpoint")),
      notes(progress("checkpoint after more reads")),
      notes(progress("checkpoint after one more read")),
      answerScript("next answer"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    const compact = async (jobId: string, window = WINDOW) =>
      runInDurableObject(stub, (instance) => prSessionSeams(instance).compactContext(model.model, window, { jobId }));

    expect(await compact("first", 30_000)).toBe("adopted");
    const first = await notesRow(stub);
    expect(first).toMatchObject({ rev: 1, cut_message_id: a1.id, cut_step: 2, history });
    expect(first.text).toContain(`${history}\n\n---`);

    expect(await compact("second")).toBe("adopted");
    const second = await notesRow(stub);
    expect(second).toMatchObject({
      rev: 2,
      cut_message_id: a1.id,
      cut_step: 3,
      history,
      read_files: JSON.stringify(["src/0.ts", "src/1.ts", "src/3.ts", path]),
    });
    expect(model.calls.filter(isSummaryCall).map(summaryPrompt).at(-1)).toContain(TURN_PREFIX_UPDATE_PROMPT);
    await seedHistory(stub, [Q2, cloudAnswer("q2", [{ type: "text", text: sized("answer two", 3334) }])]);
    expect(await compact("third")).toBe("adopted");
    const third = await notesRow(stub);
    expect(third).toMatchObject({
      rev: 3,
      cut_message_id: a1.id,
      cut_step: 4,
      history,
      read_files: JSON.stringify(["src/0.ts", "src/1.ts", "src/3.ts", path, "src/z.ts"]),
    });
    await client.chat([Q1, Q2, Q3]);
    await untilState(stub, "q3", "done");

    expect({
      secondBodyInNotes: second.text?.includes(`${history}\n\n---`),
      thirdExampleInNotes: third.text?.includes(example),
      thirdExampleInPrompt: turnPrompts(model)
        .at(-1)
        ?.some((entry) => entry.text.includes(example)),
    }).toEqual({ secondBodyInNotes: true, thirdExampleInNotes: true, thirdExampleInPrompt: true });
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
    const model = new ScriptedModel().add(
      notes(facts("the notes")),
      notes(progress("the turn's start")),
      answerScript("answer three"),
    );
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
      `${splitNotes(facts("the notes"), progress("the turn's start"))}\n\n<read-files>\nsrc/app.ts\n</read-files>`,
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
    model.add(notes(facts("the notes")), notes(progress("the turn's start")), answerScript("answer four"));
    const stub = await prSessionStub(env, session.ref);
    await untilState(stub, "q4", "done");

    expect(model.calls.map(isSummaryCall)).toEqual([false, false, false, true, true, true, false]);
    expect(await notesRow(stub)).toMatchObject({ rev: 1 });
    expect(turnPrompts(model).at(-1)?.[0]?.text).toBe(
      notesText(splitNotes(facts("the notes"), progress("the turn's start"))),
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
      notes(progress("the turn's start")),
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
      const model = new ScriptedModel().add(
        ...threeTurns(),
        notes(facts("the notes")),
        notes(progress("the turn's start")),
      );
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
      [...text(progress("the turn's start")), { hold: summary }, finish()],
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
      [...text(facts("the notes")), { hold: summary }, finish()],
      notes(progress("the turn's start")),
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

// Each summary call's request with its output allowance, estimated as compaction sizes it (characters ÷ 3): within the
// window. A provider counting fewer tokens per character counts it lower still.
function expectWithinWindow(model: ScriptedModel): void {
  for (const call of model.calls.filter(isSummaryCall)) {
    const prompt = summaryPrompt(call);
    const output = call.maxOutputTokens ?? 0;
    expect(output).toBe(4000);
    expect(requestTokens({ kind: "notes", prompt }, output)).toBeLessThanOrEqual(WINDOW);
  }
}

// A conversation of ten exchanges, each answer 9,000 characters (3,000 estimated tokens): about 30,000 estimated
// tokens, as a session that ran at a larger window holds when the window becomes 20,000.
async function tenExchanges(stub: DurableObjectStub<PrSession>): Promise<void> {
  await seedHistory(
    stub,
    Array.from({ length: 10 }, (_, index) => [
      { id: `q${index}`, role: "user" as const, parts: [{ type: "text" as const, text: "x".repeat(100) }] },
      cloudAnswer(`q${index}`, [{ type: "text", text: sized(`answer ${index}`, 3000) }]),
    ]).flat(),
  );
}

describe("a small window", () => {
  it("compacts a 20,000-token window's context at 18,000 tokens and not at 12,000, each request within the window", async () => {
    const logs = captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client } = session;
    const model = new ScriptedModel().add(
      ...threeTurns(),
      notes(facts("the notes")),
      notes(progress("the turn's start")),
    );
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

  it("summarizes a part too large for one request in batches, each updating the one before", async () => {
    captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client } = session;
    // Text-heavy answers the provider measured below their estimate: the last turn measures 19,800, while the part
    // before the kept answer is estimated at about 26,700 tokens.
    const model = new ScriptedModel().add(
      answerScript("a".repeat(40_000), { input: 200, output: 8000 }),
      answerScript("b".repeat(40_000), { input: 8200, output: 8000 }),
      answerScript("c".repeat(18_000), { input: 16_200, output: 3600 }),
      notes(facts("the first part")),
      notes(facts("both parts")),
      notes(progress("the turn's start")),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    for (const asked of [[Q1], [Q1, Q2], [Q1, Q2, Q3]]) {
      await client.chat(asked);
      await untilState(stub, asked.at(-1)?.id ?? "", "done");
    }
    await vi.waitFor(async () => expect((await notesRow(stub)).rev).toBe(1));

    const prompts = model.calls.filter(isSummaryCall).map(summaryPrompt);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("[User]: question q2");
    expect(prompts[0]).not.toContain("bbb");
    expect(prompts[1]).toContain(`<previous-summary>\n${facts("the first part")}\n</previous-summary>`);
    expect(prompts[1]).toContain("bbb");
    expect(prompts[1]?.endsWith(UPDATE_SUMMARIZATION_PROMPT)).toBe(true);
    expect(prompts[2]).toContain("[User]: question q3");
    expectWithinWindow(model);
    expect(await notesRow(stub)).toMatchObject({
      text: splitNotes(facts("both parts"), progress("the turn's start")),
      cut_message_id: `answer-${(await jobOf(stub, "q3")).job_id}`,
    });
  });

  it("fails, adopting nothing, when one step alone does not fit a request, and runs the next job on the full context", async () => {
    const logs = captureLogs();
    const session = await cloudSession("compaction", sockets);
    const { stub, client } = session;
    // An answer that alone does not fit a request at the window, with a decision at its end.
    const decided = "FINAL_DECISION_use_src_final_ts";
    const model = new ScriptedModel().add(
      answerScript(`${"a".repeat(60_000)}${decided}`, { input: 800, output: 12_010 }),
      answerScript("b".repeat(18_000), { input: 15_000, output: 3600 }),
      // A summary for each request the compaction could make, so that only the step's failure stops it; the next turn
      // takes the first one left as its answer.
      notes(facts("the first question")),
      notes(facts("the long answer")),
      notes(progress("the turn's start")),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    for (const asked of [[Q1], [Q1, Q2]]) {
      await client.chat(asked);
      await untilState(stub, asked.at(-1)?.id ?? "", "done");
    }
    await vi.waitFor(() =>
      expect([...events(logs, "prq.compaction.failed"), ...events(logs, "prq.compaction.done")]).toHaveLength(1),
    );

    // The batch before the answer was summarized; the answer itself was sent to no summary.
    const prompts = model.calls.filter(isSummaryCall).map(summaryPrompt);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("[User]: question q1");
    expect(prompts[0]).not.toContain("aaa");
    expect(await notesRow(stub)).toMatchObject({ text: null, rev: 0, cut_message_id: null });
    const a2 = `answer-${(await jobOf(stub, "q2")).job_id}`;
    expect(await contextRow(stub)).toMatchObject({ compaction_failed_through: a2 });
    expect(events(logs, "prq.compaction.failed")).toMatchObject([
      { calls: 1, reason: expect.stringContaining("does not fit") },
    ]);
    await client.chat([Q1, Q2, Q3]);
    await untilState(stub, "q3", "done");
    expect(
      turnPrompts(model)
        .at(-1)
        ?.some((message) => message.text.includes(decided)),
    ).toBe(true);
  });

  const failedBatch: Script = [...text("cut"), finish("length")];
  it.for([
    [
      "adopts the notes once every batch succeeded",
      [notes(facts("first")), notes(facts("second")), notes(progress("turn"))],
      {
        result: "adopted",
        notes: { history: facts("second"), turn_context: progress("turn"), rev: 1 },
        failedThrough: null,
      },
    ],
    [
      "leaves the notes as they were when a batch fails",
      [notes(facts("first")), failedBatch, failedBatch],
      { result: "failed", notes: { text: null, rev: 0 }, failedThrough: "answer-job-q9" },
    ],
  ] satisfies [string, Script[], { result: string; notes: Partial<NotesRow>; failedThrough: string | null }][])(
    "after the window shrank, %s",
    async ([, scripts, expected]) => {
      captureLogs();
      const session = await cloudSession("compaction", sockets);
      const { stub } = session;
      await tenExchanges(stub);
      const model = new ScriptedModel().add(...scripts);
      useCloudModel(model);

      const result = await runInDurableObject(stub, (instance) =>
        prSessionSeams(instance).compactContext(model.model, WINDOW, { jobId: "job" }),
      );

      expect(result).toBe(expected.result);
      expectWithinWindow(model);
      // Two batches of the part before the cut, the second updating the first's summary, then the split turn's start
      // (or the second batch tried once more).
      const prompts = model.calls.filter(isSummaryCall).map(summaryPrompt);
      expect(prompts).toHaveLength(3);
      expect(prompts[0]).toContain(sized("answer 0", 3000));
      expect(prompts[0]).not.toContain(sized("answer 7", 3000));
      expect(prompts[1]).toContain(`<previous-summary>\n${facts("first")}\n</previous-summary>`);
      expect(prompts[1]).toContain(sized("answer 7", 3000));
      expect(await notesRow(stub)).toMatchObject(expected.notes);
      expect(await contextRow(stub)).toMatchObject({ compaction_failed_through: expected.failedThrough });
    },
  );
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
