import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SUMMARIZATION_SYSTEM_PROMPT } from "./pr-session/compaction.ts";
import { OUTPUT_STALL_MS, RESPONSE_BOUND_MS } from "./pr-session/model.ts";
import { captureLogs, events } from "./test/access.ts";
import { type AgentSocket, question, storedMessages } from "./test/chat.ts";
import { cloudSession, untilState } from "./test/cloud.ts";
import { contextRow, notesRow, sized, WINDOW } from "./test/compaction.ts";
import {
  advance,
  answerStream,
  errorBody,
  heldSse,
  MODEL_ENV,
  noResponse,
  serveProvider,
  sse,
  until,
  useModelEnv,
} from "./test/provider.ts";
import { jobOf } from "./test/session.ts";

// Compaction through the production model (the OpenAI-compatible adapter behind the response bound), served over HTTP
// at the test window: the context-length refusals as the adapter surfaces them, and summary calls that stall or get no
// response.

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

async function servedSession() {
  const session = await cloudSession("compaction-provider", sockets);
  await useModelEnv(session.stub, { ...MODEL_ENV, MODEL_CONTEXT_TOKENS: String(WINDOW) });
  return { ...session, provider: serveProvider() };
}

const Request = v.object({ messages: v.looseTuple([v.object({ role: v.string(), content: v.unknown() })]) });

// Whether a served request was a summary call: its system prompt is the summarizer's.
function isSummary(request: { body: Record<string, unknown> }): boolean {
  const parsed = v.safeParse(Request, request.body);
  return parsed.success && parsed.output.messages[0].content === SUMMARIZATION_SYSTEM_PROMPT;
}

describe("a context-length refusal through the adapter", () => {
  it.for([
    [
      "an HTTP 400 after a retried 503, its body carrying only the code",
      [
        errorBody(503, { error: { message: "busy" } }, { "retry-after-ms": "0" }),
        errorBody(400, { error: { message: "Invalid request", code: "context_length_exceeded" } }),
      ],
    ],
    [
      "an error event inside an HTTP 200 stream, carrying only the code",
      [sse([{ error: { message: "Invalid request", code: "context_length_exceeded" } }])],
    ],
  ] as const)("compacts and re-runs the job once on %s", async ([, refusals]) => {
    const logs = captureLogs();
    const session = await servedSession();
    const { stub, client, provider } = session;
    provider.reply(
      answerStream(sized("answer one", 7000), { prompt_tokens: 6000, completion_tokens: 7000 }),
      ...refusals,
      answerStream("## Progress So Far\nthe turn's start"),
      answerStream("answer two"),
    );
    await client.chat([Q1]);
    await untilState(stub, "q1", "done");

    await client.chat([Q1, Q2]);
    await untilState(stub, "q2", "done");

    expect(provider.requests.map(isSummary)).toEqual([false, ...refusals.map(() => false), true, false]);
    expect(await notesRow(stub)).toMatchObject({ rev: 1, cut_step: 0 });
    const q2 = await jobOf(stub, "q2");
    expect(events(logs, "prq.job.rerun")).toMatchObject([{ jobId: q2.job_id }]);
    expect((await storedMessages(session.path, session.token)).at(-1)?.id).toBe(`answer-${q2.job_id}`);
  });
});

describe("a stalled summary", () => {
  it("ends each attempt at its bound, then fails the compaction, leaves the notes and runs the waiting job once, without compacting again at its start", async () => {
    const logs = captureLogs();
    const session = await servedSession();
    const { stub, client, provider } = session;
    // The first summary's stream sends nothing after its headers; the retry's request gets no response.
    const silent = heldSse([]);
    provider.reply(
      answerStream(sized("answer one", 7000), { prompt_tokens: 11_000, completion_tokens: 7000 }),
      silent.reply,
      noResponse(),
      answerStream("answer two"),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await client.chat([Q1]);
    await until(() => provider.requests.length === 2, "the first summary's request");
    await client.chat([Q1, Q2]);
    await until(async () => (await jobOf(stub, "q2")).state === "pending", "Q2 waiting");

    // The first attempt ends at the output bound, not a tick sooner.
    await advance(stub, OUTPUT_STALL_MS - 1);
    expect(provider.requests).toHaveLength(2);
    await advance(stub, 1);
    await until(() => provider.requests.length === 3, "the retry's request");
    // The retry ends at the response bound, not a tick sooner; then Q2 starts.
    await advance(stub, RESPONSE_BOUND_MS - 1);
    expect(provider.requests).toHaveLength(3);
    expect((await jobOf(stub, "q2")).state).toBe("pending");
    await advance(stub, 1);
    await until(async () => (await jobOf(stub, "q2")).state === "done", "Q2 done");

    expect(provider.requests.map(isSummary)).toEqual([false, true, true, false]);
    expect(await notesRow(stub)).toMatchObject({ text: null, rev: 0 });
    const a1 = `answer-${(await jobOf(stub, "q1")).job_id}`;
    expect(await contextRow(stub)).toMatchObject({ compaction_failed_through: a1 });
    expect(events(logs, "prq.compaction.failed")).toMatchObject([{ calls: 2 }]);
  });
});
