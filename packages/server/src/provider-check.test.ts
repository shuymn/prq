import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkProvider } from "../scripts/provider-report.ts";
import { readModelConfig } from "./config.ts";
import {
  answerStream,
  errorBody,
  finishChunk,
  MODEL_ENV,
  serveProvider,
  sse,
  TEST_KEY,
  usageChunk,
} from "./test/provider.ts";

// The manual provider check (scripts/provider-check.ts) against the served provider: what it reports, and that it
// never prints the key.

afterEach(() => {
  vi.restoreAllMocks();
});

function config() {
  const result = readModelConfig({ ...MODEL_ENV });
  if (result?.ok !== true) {
    throw new Error("MODEL_ENV is not a valid configuration");
  }
  return result.config;
}

function toolCall(index: number, fields: Record<string, unknown>): Record<string, unknown> {
  return { id: "chunk", choices: [{ index: 0, delta: { tool_calls: [{ index, ...fields }] }, finish_reason: null }] };
}

const USAGE = { prompt_tokens: 2400, completion_tokens: 1 };

describe("provider check", () => {
  it("reports each check as the provider answers it", async () => {
    const provider = serveProvider();
    provider.reply(
      answerStream("1\n2\n3"),
      answerStream("OK", { ...USAGE, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 2400 }),
      answerStream("OK", { ...USAGE, prompt_cache_hit_tokens: 2304, prompt_cache_miss_tokens: 96 }),
      sse([
        toolCall(0, { id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }),
        toolCall(0, { function: { arguments: '{"path":' } }),
        toolCall(0, { function: { arguments: '"README.md"}' } }),
        finishChunk("tool_calls"),
        usageChunk(USAGE),
      ]),
      answerStream("I cannot read files here."),
      errorBody(400, {
        error: {
          message: "This model's maximum context length is 131072 tokens. However, you requested 163856 tokens.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
    );
    const lines: string[] = [];

    const ok = await checkProvider(config(), (line) => lines.push(line));

    const report = lines.join("\n");
    // The report first, so a failing check shows what it printed.
    expect(report).toContain("5 of 5 checks as expected");
    expect(ok).toBe(true);
    expect(report).toContain("text chunks: 2 (more than one: yes)");
    expect(report).toContain('second raw usage: {"prompt_tokens":2400');
    expect(report).toContain("cached input prq logs 2304");
    expect(report).toContain("cached tokens reported in: prompt_cache_hit_tokens");
    expect(report).toContain('tool call: lookup {"path":"README.md"}');
    expect(report).toContain("finish reason: tool-calls (raw: tool_calls)");
    expect(report).toContain("tool calls: 0; text: yes");
    expect(report).toContain('"status":400,"code":"context_length_exceeded"');
    expect(report).toContain("recognised as a context-length refusal: yes");
    // The context-length prompt was over the window, and toolChoice "none" was sent with the tools.
    const sent = provider.requests.map((request) => request.body);
    expect(JSON.stringify(sent[5]).length).toBeGreaterThan(Number(MODEL_ENV.MODEL_CONTEXT_TOKENS) * 2);
    expect(v.parse(v.object({ tool_choice: v.string(), tools: v.array(v.unknown()) }), sent[4])).toMatchObject({
      tool_choice: "none",
    });
  });

  it("reports a refusal of every check, without the key it echoes, and fails", async () => {
    const provider = serveProvider();
    const refusal = errorBody(401, { error: { message: `Incorrect API key provided: ${TEST_KEY}` } });
    provider.reply(refusal, refusal, refusal, refusal, refusal, refusal);
    const lines: string[] = [];

    const ok = await checkProvider(config(), (line) => lines.push(line));

    const report = lines.join("\n");
    expect(ok).toBe(false);
    expect(report).toContain(
      "job failure: provider refused the request (HTTP 401): Incorrect API key provided: [redacted]",
    );
    expect(report).toContain("0 of 5 checks as expected");
    expect(report).not.toContain(TEST_KEY.slice(0, 8));
  });
});
