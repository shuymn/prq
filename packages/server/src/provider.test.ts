import { MessageMetadata } from "@prq/protocol";
import type { UIMessage } from "ai";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readModelConfig } from "./config.ts";
import { createModel, NO_RESPONSE, RESPONSE_BOUND_MS } from "./pr-session/model.ts";
import { captureLogs, events } from "./test/access.ts";
import { type AgentSocket, question, storedMessages } from "./test/chat.ts";
import { type CloudSession, cloudSession, textOf, untilState } from "./test/cloud.ts";
import {
  advance,
  publishStream,
  delta,
  errorBody,
  finishChunk,
  MODEL_ENV,
  noResponse,
  serveProvider,
  sse,
  until,
  usageChunk,
  useModelEnv,
} from "./test/provider.ts";
import { jobOf } from "./test/session.ts";

// The production model (the OpenAI-compatible adapter behind the response bound), built from the session's env and
// served over HTTP: what the scripted model skips, the adapter's parsing, usage and error mapping, goes through the
// same commit path.

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
  const session = await cloudSession("provider", sockets);
  await useModelEnv(session.stub);
  return { ...session, provider: serveProvider() };
}

async function stored(session: CloudSession, id: string): Promise<UIMessage | undefined> {
  return (await storedMessages(session.path, session.token)).find((message) => message.id === id);
}

describe("answers", () => {
  it("stores the published text with the model and its usage, cached tokens from prompt_tokens_details", async () => {
    const logs = captureLogs();
    const session = await servedSession();
    session.provider.reply(
      publishStream("served answer", {
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 100 },
      }),
    );

    await session.client.chat([Q1]);
    await untilState(session.stub, "q1", "done");

    const job = await jobOf(session.stub, "q1");
    const result = await stored(session, `answer-${job.job_id}`);
    expect(textOf(result)).toBe("served answer");
    expect(v.parse(MessageMetadata, result?.metadata)).toMatchObject({
      by: { kind: "cloud", model: MODEL_ENV.MODEL_ID },
      usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 100 },
    });
    expect(events(logs, "prq.job.usage")).toMatchObject([
      { jobId: job.job_id, outcome: "done", inputTokens: 120, outputTokens: 30, cachedInputTokens: 100 },
    ]);
    // One request, for the configured model, streamed with usage.
    expect(session.provider.requests.map((request) => request.body)).toMatchObject([
      { model: MODEL_ENV.MODEL_ID, stream: true, stream_options: { include_usage: true } },
    ]);
  });

  it("reads cached tokens a provider reports only as prompt_cache_hit_tokens", async () => {
    const logs = captureLogs();
    const session = await servedSession();
    session.provider.reply(
      publishStream("served answer", { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 80 }),
    );

    await session.client.chat([Q1]);
    await untilState(session.stub, "q1", "done");

    const job = await jobOf(session.stub, "q1");
    const result = await stored(session, `answer-${job.job_id}`);
    expect(v.parse(MessageMetadata, result?.metadata).usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 80,
    });
    expect(events(logs, "prq.job.usage")).toMatchObject([{ jobId: job.job_id, cachedInputTokens: 80 }]);
  });
});

describe("reasoning effort", () => {
  it("sends MODEL_REASONING_EFFORT as reasoning_effort, and none when it is unset", async () => {
    const session = await servedSession();
    session.provider.reply(publishStream("first"));
    await session.client.chat([Q1]);
    await untilState(session.stub, "q1", "done");

    await useModelEnv(session.stub, { ...MODEL_ENV, MODEL_REASONING_EFFORT: "max" });
    session.provider.reply(publishStream("second"));
    await session.client.chat([Q1, Q2]);
    await untilState(session.stub, "q2", "done");

    const [first, second] = session.provider.requests.map((request) => request.body);
    expect(first).not.toHaveProperty("reasoning_effort");
    expect(second).toMatchObject({ model: MODEL_ENV.MODEL_ID, reasoning_effort: "max" });
  });
});

describe("finish reasons", () => {
  it.for([
    ["length", "the model stopped at its output limit"],
    ["content_filter", "the provider's content filter stopped the answer"],
  ] as const)(
    "fails a stream that ends with %s after text, keeping the text as incomplete",
    async ([reason, failure]) => {
      captureLogs();
      const session = await servedSession();
      session.provider.reply(
        sse([
          delta("cut "),
          delta("short"),
          finishChunk(reason),
          usageChunk({ prompt_tokens: 10, completion_tokens: 2 }),
        ]),
      );

      await session.client.chat([Q1]);
      await untilState(session.stub, "q1", "failed");

      const job = await jobOf(session.stub, "q1");
      expect(job.failure).toBe(failure);
      expect(await stored(session, `answer-${job.job_id}`)).toBeUndefined();
      const incomplete = await stored(session, `answer-${job.job_id}-r1-incomplete`);
      expect(textOf(incomplete)).toBe("cut short");
      expect(v.parse(MessageMetadata, incomplete?.metadata).incomplete).toEqual({ reason: failure });
    },
  );
});

describe("provider errors", () => {
  it("fails a job the provider refuses before any byte with its status and message", async () => {
    const logs = captureLogs();
    const session = await servedSession();
    session.provider.reply(
      errorBody(401, { error: { message: "Invalid API key", type: "authentication_error", code: "invalid_api_key" } }),
    );

    await session.client.chat([Q1]);
    await untilState(session.stub, "q1", "failed");

    const failure = "provider refused the request (HTTP 401): Invalid API key";
    expect((await session.stub.view()).jobs).toMatchObject([{ state: "failed", failure }]);
    expect(events(logs, "prq.job.failed").at(-1)).toMatchObject({ reason: failure });
    // Not retried, and nothing but the question stored.
    expect(session.provider.requests).toHaveLength(1);
    expect((await storedMessages(session.path, session.token)).map((message) => message.id)).toEqual(["q1"]);
  });

  it("fails a job with a body the adapter cannot parse, quoting the body", async () => {
    captureLogs();
    const session = await servedSession();
    session.provider.reply(errorBody(400, "bad request: model not found"));

    await session.client.chat([Q1]);
    await untilState(session.stub, "q1", "failed");

    expect((await jobOf(session.stub, "q1")).failure).toBe(
      "provider refused the request (HTTP 400): bad request: model not found",
    );
  });

  it.for<[string, Record<string, string>, string]>([
    ["its code", { message: "upstream overloaded", code: "overloaded" }, "(overloaded): upstream overloaded"],
    ["its type", { message: "upstream overloaded", type: "server_error" }, "(server_error): upstream overloaded"],
  ])(
    "fails a job whose stream carries an error frame after text, labelled by %s, keeping the text",
    async ([, error, label]) => {
      captureLogs();
      const session = await servedSession();
      session.provider.reply(sse([delta("partial answer"), { error }]));

      await session.client.chat([Q1]);
      await untilState(session.stub, "q1", "failed");

      const job = await jobOf(session.stub, "q1");
      const failure = `provider error during the answer ${label}`;
      expect(job.failure).toBe(failure);
      const incomplete = await stored(session, `answer-${job.job_id}-r1-incomplete`);
      expect(textOf(incomplete)).toBe("partial answer");
      expect(v.parse(MessageMetadata, incomplete?.metadata).incomplete).toEqual({ reason: failure });
    },
  );
});

describe("retries", () => {
  it("completes a job whose provider answers 503 and then the stream, within the AI SDK's retries", async () => {
    captureLogs();
    const session = await servedSession();
    session.provider.reply(
      errorBody(503, { error: { message: "busy" } }, { "retry-after-ms": "0" }),
      publishStream("after a retry"),
    );

    await session.client.chat([Q1]);
    await untilState(session.stub, "q1", "done");

    const job = await jobOf(session.stub, "q1");
    expect(textOf(await stored(session, `answer-${job.job_id}`))).toBe("after a retry");
    expect(session.provider.requests).toHaveLength(2);
  });
});

// Sends a chat request without waiting for its response: its turn queues behind the running job's.
function ask(client: AgentSocket, messages: UIMessage[]): string {
  const id = crypto.randomUUID();
  client.send({
    type: "cf_agent_use_chat_request",
    id,
    init: { method: "POST", body: JSON.stringify({ messages, trigger: "submit-message" }) },
  });
  return id;
}

async function stateOf(session: CloudSession, target: string): Promise<string | undefined> {
  return (await session.stub.view()).jobs.find((job) => job.target.kind === "answer" && job.target.messageId === target)
    ?.state;
}

describe("no response", () => {
  it.for([
    ["honours its abort", false],
    ["ignores its abort", true],
  ] as const)(
    "aborts a request whose response does not arrive within the bound, which %s, fails its job and runs the next",
    async ([, ignoreAbort]) => {
      const logs = captureLogs();
      const session = await servedSession();
      const { stub, client, provider } = session;
      provider.reply(noResponse({ ignoreAbort }), publishStream("answer two"));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      await client.chat([Q1]);
      await until(() => provider.requests.length === 1, "Q1's request");
      ask(client, [Q1, Q2]);
      await until(async () => (await storedMessages(session.path, session.token)).length === 2, "Q2 stored");
      await stub.settle();
      expect(await stateOf(session, "q2")).toBe("pending");

      await advance(stub, RESPONSE_BOUND_MS - 1);
      expect(await stateOf(session, "q1")).toBe("running");
      expect(provider.requests[0]?.signal?.aborted).toBe(false);

      await advance(stub, 1);
      await until(async () => (await stateOf(session, "q1")) === "failed", "Q1 failed");
      expect(provider.requests[0]?.signal?.aborted).toBe(true);
      expect((await jobOf(stub, "q1")).failure).toBe(NO_RESPONSE);
      expect(events(logs, "prq.job.failed").at(-1)).toMatchObject({ reason: NO_RESPONSE });
      // The next job was handed over: its request went out, and its answer is stored.
      await until(async () => (await stateOf(session, "q2")) === "done", "Q2 done");
      expect(provider.requests).toHaveLength(2);
    },
  );

  it(
    "ends a call at its caller's abort though the request ignores it, and leaves no timer behind",
    { timeout: 10_000 },
    async () => {
      const config = readModelConfig({ ...MODEL_ENV });
      if (config?.ok !== true) {
        throw new Error("MODEL_ENV is not a valid configuration");
      }
      const provider = serveProvider();
      provider.reply(noResponse({ ignoreAbort: true }));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const caller = new AbortController();
      let ended: unknown = "pending";
      createModel(config.config)
        .doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
          abortSignal: caller.signal,
        })
        .then(
          () => {
            ended = "answered";
          },
          (error: unknown) => {
            ended = error;
          },
        );
      await until(() => provider.requests.length === 1, "the request");
      expect(vi.getTimerCount()).toBe(1);

      const reason = new Error("the caller is gone");
      caller.abort(reason);

      await until(() => ended !== "pending", "the call's end");
      expect(ended).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds a retry's request on its own, and names the attempts", async () => {
    captureLogs();
    const session = await servedSession();
    const { stub, client, provider } = session;
    provider.reply(errorBody(503, { error: { message: "busy" } }, { "retry-after-ms": "0" }), noResponse());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await client.chat([Q1]);
    // The retry waits 0 ms on the fake clock.
    await until(async () => {
      await advance(stub, 0);
      return provider.requests.length === 2;
    }, "the retry");

    await advance(stub, RESPONSE_BOUND_MS - 1);
    expect(await stateOf(session, "q1")).toBe("running");
    await advance(stub, 1);
    await until(async () => (await stateOf(session, "q1")) === "failed", "Q1 failed");
    expect((await jobOf(stub, "q1")).failure).toBe(`${NO_RESPONSE} (after 2 attempts)`);
  });
});
