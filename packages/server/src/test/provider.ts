// A served OpenAI-compatible provider for the real adapter: a globalThis.fetch spy answers the chat completions URL
// with the responses a test queues (SSE streams, error bodies, requests that never answer), and records each request
// with its signal. Any other provider URL fails the request; other fetches keep the implementation installed before.
// Sessions read the model's configuration from env, which a test sets on the live instance.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";

import type { PrSession } from "../pr-session/index.ts";

const PROVIDER_ROOT = "https://provider.example/v1";
const COMPLETIONS = `${PROVIDER_ROOT}/chat/completions`;

// A key in the shape providers use; tests look for it, and for its first 8 characters, wherever text is shown.
export const TEST_KEY = "sk-test-0123456789abcdef0123456789abcdef";

export const MODEL_ENV = {
  MODEL_BASE_URL: PROVIDER_ROOT,
  MODEL_API_KEY: TEST_KEY,
  MODEL_ID: "served-model",
  MODEL_CONTEXT_TOKENS: "131072",
};

// The session reads its model configuration from exactly these variables (the test env's empty ones left out) from
// now on. The instance keeps them until it is reset.
export async function useModelEnv(
  stub: DurableObjectStub<PrSession>,
  vars: Partial<Record<keyof typeof MODEL_ENV, string>> = MODEL_ENV,
): Promise<void> {
  const base = Object.fromEntries(Object.entries(env).filter(([name]) => !(name in MODEL_ENV)));
  await runInDurableObject(stub, (instance) => {
    Reflect.set(instance, "env", { ...base, ...vars });
  });
}

type Reply = (signal: AbortSignal | undefined) => Promise<Response>;

type ServedRequest = { body: Record<string, unknown>; signal: AbortSignal | undefined };

export type Provider = {
  readonly requests: ServedRequest[];
  // Replies for the next requests, in order.
  reply(...replies: Reply[]): void;
};

export function serveProvider(): Provider {
  const requests: ServedRequest[] = [];
  const replies: Reply[] = [];
  const spy = vi.isMockFunction(globalThis.fetch) ? vi.mocked(globalThis.fetch) : vi.spyOn(globalThis, "fetch");
  const earlier = spy.getMockImplementation();
  spy.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(PROVIDER_ROOT)) {
      if (earlier === undefined) {
        throw new Error(`unexpected fetch: ${request.url}`);
      }
      return earlier(input, init);
    }
    if (request.url !== COMPLETIONS || request.method !== "POST") {
      throw new Error(`unexpected provider request: ${request.method} ${request.url}`);
    }
    const signal = init?.signal ?? undefined;
    requests.push({ body: await request.json(), signal });
    const reply = replies.shift();
    if (reply === undefined) {
      throw new Error("no reply left for this provider request");
    }
    return reply(signal);
  });
  return {
    requests,
    reply: (...added) => {
      replies.push(...added);
    },
  };
}

// A chat completion chunk: a text delta, or a finish, or usage alone.
export function delta(content: string): Record<string, unknown> {
  return { id: "chunk", model: "served-model", choices: [{ index: 0, delta: { content }, finish_reason: null }] };
}

export function finishChunk(reason: string): Record<string, unknown> {
  return { id: "chunk", model: "served-model", choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

export function usageChunk(usage: Record<string, unknown>): Record<string, unknown> {
  return { id: "chunk", model: "served-model", choices: [], usage };
}

// A 200 event stream of the chunks, then [DONE]; with `open`, the stream stays open after them instead.
export function sse(chunks: unknown[], { open = false } = {}): Reply {
  return async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        if (!open) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
}

// A whole answer: its text in two deltas, a stop, and usage.
export function answerStream(
  text: string,
  usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 5 },
) {
  const half = Math.ceil(text.length / 2);
  return sse([delta(text.slice(0, half)), delta(text.slice(half)), finishChunk("stop"), usageChunk(usage)]);
}

// An error response before any byte of a stream.
export function errorBody(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

// A request whose response never arrives; it rejects when its signal aborts, unless `ignoreAbort`.
export function noResponse({ ignoreAbort = false } = {}): Reply {
  return (signal) =>
    new Promise((_, reject) => {
      if (!ignoreAbort) {
        signal?.addEventListener("abort", () => reject(signal.reason));
      }
    });
}

// Waits for a condition without timers: vi.waitFor advances fake timers (in the test's context, not the session's), so
// tests on a fake clock poll with the runtime's own scheduler instead.
export async function until(check: () => boolean | Promise<boolean>, what = "condition"): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await check()) {
      return;
    }
    await scheduler.wait(20);
  }
  throw new Error(`${what} not reached within 5 s`);
}

// Advances the fake clock inside the session, so the timers that fire do their I/O in the session's context.
export async function advance(stub: DurableObjectStub<PrSession>, ms: number): Promise<void> {
  await runInDurableObject(stub, () => vi.advanceTimersByTimeAsync(ms));
}
