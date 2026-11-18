import { ErrorResponse, Instructions, Prompt, PROMPT_CHARS, ROUTE_CALL_MS } from "@prq/protocol";
import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CallBound } from "./http.ts";
import { captureLogs, events, request } from "./test/access.ts";
import { hostToken } from "./test/chat.ts";
import { fetchBounded } from "./test/cli.ts";
import { clearPrompts, hub, hubSeams } from "./test/session.ts";
import { WaitTimeout } from "./wait.ts";

// The host's prompts through /api (docs/design.md, Instructions and skills): stored by the Hub before the answer, read
// back with the settings, and refused over their cap.

const SAVED_AT = Date.UTC(2026, 10, 18, 10, 2);

beforeEach(async () => {
  await clearPrompts();
  await runInDurableObject(await hub(), (instance) => {
    vi.spyOn(hubSeams(instance), "clock").mockReturnValue(SAVED_AT);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function save(token: string | undefined, kind: string, body: unknown): Promise<Response> {
  return exports.default.fetch(
    request(`/api/prompts/${kind}`, token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function instructions(token: string): Promise<Instructions> {
  const res = await exports.default.fetch(request("/api/instructions", token));
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return v.parse(Instructions, await res.json());
}

async function refusal(response: Promise<Response>): Promise<{ status: number; body: ErrorResponse }> {
  const res = await response;
  return { status: res.status, body: v.parse(ErrorResponse, await res.json()) };
}

describe("the host's prompts", () => {
  it("reads both prompts as empty and never saved, then each as its last save stored it", async () => {
    const logs = captureLogs();
    const token = await hostToken();
    const never = { text: "", savedAt: null };
    expect(await instructions(token)).toEqual({ prompts: { analysis: never, answer: never }, skills: [] });

    const res = await save(token, "answer", { text: "Answer in the language of the question." });
    expect(res.status).toBe(200);
    expect(v.parse(Prompt, await res.json())).toEqual({
      text: "Answer in the language of the question.",
      savedAt: SAVED_AT,
    });
    expect((await save(token, "analysis", { text: "Write the summary in Japanese." })).status).toBe(200);
    expect((await save(token, "answer", { text: "Answer briefly." })).status).toBe(200);

    expect(await instructions(token)).toEqual({
      prompts: {
        analysis: { text: "Write the summary in Japanese.", savedAt: SAVED_AT },
        answer: { text: "Answer briefly.", savedAt: SAVED_AT },
      },
      skills: [],
    });
    // The log carries the kind and the length, never the text.
    expect(events(logs, "prq.prompt.saved").at(-1)).toEqual({
      event: "prq.prompt.saved",
      kind: "answer",
      chars: "Answer briefly.".length,
    });
  });

  it("stores a prompt at its cap and refuses one past it with 400, changing nothing", async () => {
    captureLogs();
    const token = await hostToken();
    const atCap = "あ".repeat(PROMPT_CHARS);
    expect((await save(token, "analysis", { text: atCap })).status).toBe(200);

    expect(await refusal(save(token, "analysis", { text: `${atCap}x` }))).toEqual({
      status: 400,
      body: { error: "bad_request", detail: "invalid text" },
    });
    expect(await refusal(save(token, "summary", { text: "x" }))).toEqual({
      status: 400,
      body: { error: "bad_request", detail: "invalid kind" },
    });
    expect((await instructions(token)).prompts.analysis).toEqual({ text: atCap, savedAt: SAVED_AT });
    // The Hub refuses the same text on its own, whoever calls it.
    expect(await (await hub()).savePrompt("analysis", `${atCap}x`)).toMatchObject({ error: "bad_request" });
    expect((await instructions(token)).prompts.analysis.text).toBe(atCap);
  });

  it("answers 401 without a token, and 503 when the Hub does not answer in time", async () => {
    captureLogs();
    const token = await hostToken();
    expect((await exports.default.fetch(request("/api/instructions"))).status).toBe(401);
    expect((await save(undefined, "answer", { text: "x" })).status).toBe(401);

    const bounds: { ms: number; what: string }[] = [];
    const timedOut: CallBound = (call, ms, what) => {
      bounds.push({ ms, what });
      void Promise.resolve(call).catch(() => undefined);
      return Promise.reject(new WaitTimeout(`${what} expired`));
    };
    const put = request("/api/prompts/answer", token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    for (const req of [request("/api/instructions", token), put]) {
      expect((await refusal(fetchBounded(timedOut, req))).status).toBe(503);
    }
    expect(bounds).toEqual([
      { ms: ROUTE_CALL_MS, what: "the Hub's instructions" },
      { ms: ROUTE_CALL_MS, what: "the Hub's prompt save" },
    ]);
  });
});
