// The model provider. The prototype has no API key, so it uses the AI SDK mock (ai/test): the reply echoes the last
// user text, streamed word by word with a delay so tests can interleave events with a running turn.
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

export function createModel(reply: string, chunkDelayMs: number): MockLanguageModelV4 {
  const words = reply.split(/(?<= )/);
  const chunks: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    ...words.map((w): LanguageModelV4StreamPart => ({ type: "text-delta", id: "t0", delta: w })),
    { type: "text-end", id: "t0" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: words.length, text: words.length, reasoning: 0 },
      },
    },
  ];
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, initialDelayInMs: chunkDelayMs, chunkDelayInMs: chunkDelayMs }),
    }),
  });
}
