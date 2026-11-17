import { afterEach, describe, expect, it } from "vitest";

import { checkCloud } from "./cloud.ts";
import type { ModelSettings } from "./worker.ts";

// The manual cloud check (cloud-check.ts) against a provider served from this process: the Worker's outbound
// requests reach this process's globalThis.fetch, which answers the provider's URL here. .example never resolves, so
// nothing reaches a network.

const ROOT = "https://provider.example/v1";
const KEY = "sk-test-0123456789abcdef0123456789abcdef";
const MODEL: ModelSettings = {
  MODEL_BASE_URL: ROOT,
  MODEL_API_KEY: KEY,
  MODEL_ID: "served-model",
  MODEL_CONTEXT_TOKENS: "131072",
};

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
});

// Answers every provider request with the reply; other requests go on as before.
function serveProvider(reply: () => Response): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  const before = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(ROOT)) {
      return before(input, init);
    }
    bodies.push(await request.json());
    return reply();
  };
  return { bodies };
}

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const choice = (delta: object, finish: string | null) => ({
  id: "c",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

describe("cloud check", () => {
  it("reports the stored answer with its author and usage", { timeout: 60_000 }, async () => {
    const provider = serveProvider(() =>
      sse([
        choice({ content: "A pull request proposes changes. " }, null),
        choice({ content: "Review catches mistakes." }, null),
        choice({}, "stop"),
        { id: "c", choices: [], usage: { prompt_tokens: 120, completion_tokens: 12, prompt_cache_hit_tokens: 64 } },
      ]),
    );
    const lines: string[] = [];

    const ok = await checkCloud(MODEL, false, (line) => lines.push(line));

    const report = lines.join("\n");
    expect(report).toMatch(/job: done after/);
    expect(report).toContain("answer: A pull request proposes changes. Review catches mistakes.");
    expect(report).toContain('author: {"kind":"cloud","model":"served-model"}');
    expect(report).toContain('usage: {"inputTokens":120,"outputTokens":12,"cachedInputTokens":64}');
    expect(ok).toBe(true);
    expect(provider.bodies).toMatchObject([{ model: "served-model", stream: true }]);
  });

  it("reports the provider's refusal of an unknown model as expected", { timeout: 60_000 }, async () => {
    serveProvider(() =>
      Response.json({ error: { message: "Model Not Exist", type: "invalid_request_error" } }, { status: 400 }),
    );
    const lines: string[] = [];

    const ok = await checkCloud({ ...MODEL, MODEL_ID: "no-such-model" }, true, (line) => lines.push(line));

    const report = lines.join("\n");
    expect(report).toMatch(/job: failed after [\d.]+ s: provider refused the request \(HTTP 400\): Model Not Exist/);
    expect(ok).toBe(true);
    expect(report).not.toContain(KEY.slice(0, 8));
  });
});
