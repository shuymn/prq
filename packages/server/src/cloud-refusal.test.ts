import { MessageMetadata } from "@prq/protocol";
import { APICallError } from "ai";
import { runInDurableObject } from "cloudflare:test";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureLogs, events } from "./test/access.ts";
import { type AgentSocket, question, storedMessages } from "./test/chat.ts";
import { type CloudSession, cloudSession, textOf, untilState } from "./test/cloud.ts";
import { ScriptedModel, text, useCloudModel } from "./test/model.ts";
import {
  delta,
  errorBody,
  finishChunk,
  heldSse,
  serveProvider,
  sse,
  TEST_KEY,
  until,
  useModelEnv,
} from "./test/provider.ts";
import { hub, jobOf } from "./test/session.ts";

// A provider that refuses a call (its spend limit, a bad key) fails the job with the provider's reason, never as done,
// and the API key never shows in what the job leaves.

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q1 = question("q1");

// A refusal as the adapter raises it for a 402 with a JSON error body.
function insufficientBalance(): APICallError {
  const body = { error: { message: "Insufficient Balance", type: "unknown_error", code: "invalid_request_error" } };
  return new APICallError({
    message: "Insufficient Balance",
    url: "https://provider.example/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 402,
    responseBody: JSON.stringify(body),
    data: body,
    isRetryable: false,
  });
}

const REFUSED = "provider refused the request (HTTP 402): Insufficient Balance";

describe("refusals", () => {
  it("fails a job the provider refuses before its stream with the status and the provider's message", async () => {
    const logs = captureLogs();
    const session = await cloudSession("refusal", sockets);
    const model = new ScriptedModel().add({ refuse: insufficientBalance() });
    useCloudModel(model);

    await session.client.chat([Q1]);
    await untilState(session.stub, "q1", "failed");

    expect((await session.stub.view()).jobs).toMatchObject([{ state: "failed", failure: REFUSED }]);
    expect(events(logs, "prq.job.failed").at(-1)).toMatchObject({ reason: REFUSED });
    // Not retried; nothing stored but the question.
    expect(model.calls).toHaveLength(1);
    expect((await storedMessages(session.path, session.token)).map((message) => message.id)).toEqual(["q1"]);
  });

  it("keeps the text of an answer the provider refuses midway as incomplete", async () => {
    captureLogs();
    const session = await cloudSession("refusal", sockets);
    // An adapter reports an error after the stream has started as an error part.
    useCloudModel(
      new ScriptedModel().add([...text("partial answer"), { type: "error", error: insufficientBalance() }]),
    );

    await session.client.chat([Q1]);
    await untilState(session.stub, "q1", "failed");

    const job = await jobOf(session.stub, "q1");
    expect(job.failure).toBe(REFUSED);
    const incomplete = (await storedMessages(session.path, session.token)).find(
      (message) => message.id === `answer-${job.job_id}-r1-incomplete`,
    );
    expect(textOf(incomplete)).toBe("partial answer");
    expect(v.parse(MessageMetadata, incomplete?.metadata).incomplete).toEqual({ reason: REFUSED });
  });
});

// Every row of every table of a Durable Object, as JSON.
async function allRows(stub: DurableObjectStub): Promise<string> {
  return runInDurableObject(stub, (_, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'",
      )
      .toArray();
    return JSON.stringify(
      tables.map(({ name }) => [name, state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()]),
    );
  });
}

const REFUSED_400 = "provider refused the request (HTTP 400): ";
// A message that puts the key across character 500 of the reason: cut first, its first 10 characters would remain.
const STRADDLING = `${"x".repeat(490 - REFUSED_400.length)}${TEST_KEY} and more`;

describe("redaction", () => {
  it.for([
    [
      "a 4xx body before the stream",
      errorBody(401, { error: { message: `Incorrect API key provided: ${TEST_KEY}`, code: "invalid_api_key" } }),
      "provider refused the request (HTTP 401): Incorrect API key provided: [redacted]",
    ],
    [
      "an error frame in the stream",
      sse([delta("partial answer"), { error: { message: `upstream rejected ${TEST_KEY}`, code: "bad_key" } }]),
      "provider error during the answer (bad_key): upstream rejected [redacted]",
    ],
    [
      "a key across the 500th character",
      errorBody(400, { error: { message: STRADDLING } }),
      `${REFUSED_400}${"x".repeat(490 - REFUSED_400.length)}[redacted]`,
    ],
    [
      "an unknown finish reason",
      sse([delta("partial answer"), finishChunk(`bad_key:${TEST_KEY}`)]),
      "the model stopped with finish reason bad_key:[redacted]",
    ],
  ] as const)(
    "keeps the API key out of every text the job leaves when the provider echoes it in %s",
    async ([, reply, failure]) => {
      const logs = captureLogs();
      const session = await cloudSession("redaction", sockets);
      await useModelEnv(session.stub);
      serveProvider().reply(reply);

      await session.client.chat([Q1]);
      await untilState(session.stub, "q1", "failed");

      const job = await jobOf(session.stub, "q1");
      expect(job.failure).toBe(failure);
      expect(job.failure?.length).toBeLessThanOrEqual(500);
      // The client is shown the same text (the UI stream's error frame, the view's failure).
      expect(JSON.stringify(session.client.frames)).toContain("[redacted]");
      await expectKeyNowhere(session, logs);
    },
  );

  it.for([
    [
      "the provider's response body",
      async (session: CloudSession) => {
        const held = heldSse([delta("partial answer")]);
        serveProvider().reply(held.reply);
        await session.client.chat([Q1]);
        await until(() => JSON.stringify(session.client.frames).includes("partial answer"), "the partial answer");
        // Failed inside the session, as the runtime fails a response body there.
        await runInDurableObject(session.stub, () =>
          held.fail(new DOMException(`transport rejected ${TEST_KEY}`, "AbortError")),
        );
      },
    ],
    [
      "a model's stream",
      async (session: CloudSession) => {
        useCloudModel(
          new ScriptedModel().add([...text("partial answer"), { fail: new Error(`transport rejected ${TEST_KEY}`) }]),
        );
        await session.client.chat([Q1]);
      },
    ],
  ] as const)(
    "keeps the API key out of the SDK's terminal frame when %s fails midway with it",
    async ([, failMidway]) => {
      const logs = captureLogs();
      const session = await cloudSession("redaction", sockets);
      await useModelEnv(session.stub);

      await failMidway(session);
      await untilState(session.stub, "q1", "failed");

      expect((await jobOf(session.stub, "q1")).failure).toBe("transport rejected [redacted]");
      // The stream's exception reaches the client as the SDK's terminal error frame, with the job's reason.
      expect(session.client.frames).toContainEqual(
        expect.objectContaining({
          type: "cf_agent_use_chat_response",
          error: true,
          done: true,
          body: "transport rejected [redacted]",
        }),
      );
      await expectKeyNowhere(session, logs);
    },
  );
});

// The key, or its first 8 characters, in nothing the job left: the client's frames, the stored history, any row of
// the session or the hub, the view, the logs.
async function expectKeyNowhere(session: CloudSession, logs: unknown): Promise<void> {
  const shown = [
    JSON.stringify(session.client.frames),
    JSON.stringify(await storedMessages(session.path, session.token)),
    await allRows(session.stub),
    await allRows(await hub()),
    JSON.stringify(await session.stub.view()),
    JSON.stringify(logs),
  ];
  for (const seen of shown) {
    expect(seen).not.toContain(TEST_KEY.slice(0, 8));
  }
}
