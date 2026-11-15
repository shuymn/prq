// A cloud-owned PrSession with the AI SDK mock model (no local agent ever joins the pool in this file).
// MOCK_CHUNK_DELAY_MS=250 makes each turn take ~1 s so events can land while a turn runs.
import { afterAll, beforeAll, expect, it } from "vitest";

import { ChatClient, delay, sendWebhook, sessionState, startDev, textOf, type Dev } from "./support.ts";

let dev: Dev;
beforeAll(async () => {
  dev = await startDev({ MOCK_CHUNK_DELAY_MS: "250" });
});
afterAll(async () => {
  await dev?.stop();
});

async function until<T>(f: () => Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("until: timed out");
    await delay(100);
  }
}

it("runs a model turn for a chat send and streams it to the client", async () => {
  const name = "octo~cloud~1";
  const chat = await ChatClient.connect(dev, name);
  const q = chat.send("hello there");
  await chat.waitFor(() => chat.streamed(q.requestId).done, 20_000);
  expect(chat.streamed(q.requestId).text).toBe("echo: hello there");
  const deltas = chat.frames.filter((f) => f.type === "cf_agent_use_chat_response" && f["id"] === q.requestId && String(f["body"]).includes("text-delta"));
  expect(deltas.length).toBeGreaterThan(1);
  const st = await sessionState(dev, name);
  expect(st.owner).toBe("cloud");
  expect(st.messages.map((m: any) => `${m.role}:${textOf(m)}`)).toEqual(["user:hello there", "assistant:echo: hello there"]);
  await chat.close();
});

it("runs webhook analyses with saveMessages after waitUntilStable: queued questions first, unstarted analyses coalesced", async () => {
  const repo = "octo/cloud";
  const name = "octo~cloud~2";
  const chat = await ChatClient.connect(dev, name);
  await sendWebhook(dev, { repo, number: 2, headSha: "aaa", action: "opened" });
  // Analysis A is running.
  await until(async () => (await sessionState(dev, name)).jobs.find((j: any) => j.target === "aaa" && j.state === "running"));
  await sendWebhook(dev, { repo, number: 2, headSha: "bbb" });
  const q = chat.send("question while analyzing");
  await delay(100);
  await sendWebhook(dev, { repo, number: 2, headSha: "ccc" });

  const st = await until(async () => {
    const s = await sessionState(dev, name);
    return s.jobs.every((j: any) => j.state === "done" || j.state === "superseded") &&
      s.messages.filter((m: any) => m.role === "assistant").length === 3 && s;
  }, 30_000);
  expect(st.jobs.map((j: any) => [j.target, j.state])).toEqual([
    ["aaa", "done"],
    ["bbb", "superseded"],
    ["ccc", "done"],
  ]);
  // The turns ran in this order: A, the queued question, then only the latest head.
  expect(st.messages.filter((m: any) => m.role === "assistant").map(textOf)).toEqual([
    "echo: analyze aaa",
    "echo: question while analyzing",
    "echo: analyze ccc",
  ]);
  // Transcript order is persistence order: the question sent during A sits before A's answer.
  expect(st.messages.map((m: any) => `${m.role}:${textOf(m)}`)).toEqual([
    "user:analyze aaa",
    "user:question while analyzing",
    "assistant:echo: analyze aaa",
    "assistant:echo: question while analyzing",
    "user:analyze ccc",
    "assistant:echo: analyze ccc",
  ]);
  // Transcript order is persistence order: the question sent during A sits before A's answer.
  expect(st.messages.map((m: any) => `${m.role}:${textOf(m)}`)).toEqual([
    "user:analyze aaa",
    "user:question while analyzing",
    "assistant:echo: analyze aaa",
    "assistant:echo: question while analyzing",
    "user:analyze ccc",
    "assistant:echo: analyze ccc",
  ]);
  expect(chat.streamed(q.requestId).text).toBe("echo: question while analyzing");
  await chat.close();
});
