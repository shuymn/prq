// A scripted model for the checks that need a deterministic turn (check:skills's context step, the PR detail's cloud
// scenarios): the Worker's model settings name a provider under .example, which never resolves, and the harness hands
// the Worker's request to this process's globalThis.fetch, which a wrapper answers here as an OpenAI-compatible provider
// streams: a tool call or a text, then the finish and the usage. What it answers is the check's script, given each
// request's body.

import * as v from "valibot";

import type { Latch } from "./latch.ts";
import type { ModelSettings } from "./worker.ts";

const ROOT = "https://scripted.prq.example/v1";
const COMPLETIONS = `${ROOT}/chat/completions`;

export const SCRIPTED_MODEL: ModelSettings = {
  MODEL_BASE_URL: ROOT,
  MODEL_API_KEY: "scripted-key",
  MODEL_ID: "scripted",
  MODEL_CONTEXT_TOKENS: "131072",
};

// A request as the Worker's adapter sends it: its messages (a tool call's arguments as JSON text, a tool result's
// content as text) and the tools offered.
const ChatRequest = v.looseObject({
  messages: v.array(
    v.looseObject({
      role: v.string(),
      content: v.nullish(v.unknown()),
      tool_call_id: v.optional(v.string()),
      tool_calls: v.optional(
        v.array(
          v.looseObject({ id: v.string(), function: v.looseObject({ name: v.string(), arguments: v.string() }) }),
        ),
      ),
    }),
  ),
  tools: v.optional(
    v.array(v.looseObject({ function: v.looseObject({ name: v.string(), description: v.optional(v.string()) }) })),
  ),
});

export type ChatRequest = v.InferOutput<typeof ChatRequest>;

export function chatRequest(body: string): ChatRequest {
  return v.parse(ChatRequest, JSON.parse(body));
}

// A stream that stops after its first `after` text chunks, opening reached, until release opens or the Worker cancels it.
export type Hold = { after: number; reached: Latch; release: Latch };

// What the script answers a request with: one tool call, or a final text, streamed as one chunk or as the chunks given.
export type Scripted = { tool: string; input: Record<string, unknown> } | { text: string | string[]; hold?: Hold };

function stream(chunks: unknown[], hold?: Hold): Response {
  const events = [...chunks.map((entry) => `data: ${JSON.stringify(entry)}\n\n`), "data: [DONE]\n\n"];
  const encoder = new TextEncoder();
  const cancelled = Promise.withResolvers<void>();
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (hold !== undefined && next === hold.after) {
        hold.reached.open();
        await Promise.race([hold.release.promise, cancelled.promise]);
      }
      const event = events[next];
      next += 1;
      if (event === undefined) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(event));
      }
    },
    cancel() {
      cancelled.resolve();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function chunk(choice: Record<string, unknown>): Record<string, unknown> {
  return { id: "scripted", model: "scripted", choices: [{ index: 0, finish_reason: null, ...choice }] };
}

export type Script = (request: ChatRequest) => Scripted;

// Serves the scripted model until stopped, installed before the Worker starts so that the Worker's harness records each
// request (worker.ts) before this answers it: each chat completion request is answered by the script last played, with
// usage of a quarter of the request's characters; a request with no script played, or any other request to the
// scripted provider, fails. Other fetches go on to the fetch installed before.
export function serveScripted(): { play: (script: Script) => void; stop: () => void } {
  const before = globalThis.fetch;
  let calls = 0;
  let script: Script | null = null;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(ROOT)) {
      return before(input, init);
    }
    if (request.url !== COMPLETIONS || request.method !== "POST" || script === null) {
      return new Response("not scripted", { status: 404 });
    }
    const body = await request.text();
    const reply = script(chatRequest(body));
    const usage = {
      id: "scripted",
      model: "scripted",
      choices: [],
      usage: { prompt_tokens: Math.ceil(body.length / 4), completion_tokens: 8 },
    };
    if ("tool" in reply) {
      calls += 1;
      const call = {
        index: 0,
        id: `call_${calls}`,
        type: "function",
        function: { name: reply.tool, arguments: JSON.stringify(reply.input) },
      };
      return stream([
        chunk({ delta: { role: "assistant", tool_calls: [call] } }),
        chunk({ delta: {}, finish_reason: "tool_calls" }),
        usage,
      ]);
    }
    const texts = typeof reply.text === "string" ? [reply.text] : reply.text;
    return stream(
      [
        ...texts.map((text, index) =>
          chunk({ delta: index === 0 ? { role: "assistant", content: text } : { content: text } }),
        ),
        chunk({ delta: {}, finish_reason: "stop" }),
        usage,
      ],
      reply.hold,
    );
  };
  return {
    play: (next) => {
      script = next;
    },
    stop: () => {
      globalThis.fetch = before;
    },
  };
}
