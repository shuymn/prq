// Pool presence and the owner decision, with a short idle window (PRESENCE_TTL_MS=1500 instead of 10 minutes).
import { afterAll, beforeAll, expect, it } from "vitest";

import { accessToken, delay, prq, sessionState, startDev, type Dev } from "./support.ts";

let dev: Dev;
let token: string;
beforeAll(async () => {
  dev = await startDev({ PRESENCE_TTL_MS: "1500" });
  token = await accessToken("service");
});
afterAll(async () => {
  await dev?.stop();
});

it("fixes the owner at creation from the pool, and drops an agent from the pool after the idle window", async () => {
  expect((await sessionState(dev, "octo~p~1")).owner).toBe("cloud");

  await prq(dev, ["wait", "--poll-ms", "200", "--max-wait-ms", "200"], { token, agentId: "p-agent" });
  expect((await sessionState(dev, "octo~p~2")).owner).toBe("local");

  await delay(2000);
  expect((await sessionState(dev, "octo~p~3")).owner).toBe("cloud");
  // Fixed at creation: the local session stays local after the agent left the pool.
  expect((await sessionState(dev, "octo~p~2")).owner).toBe("local");
});

it("counts an agent as present for the whole of a long-poll longer than the idle window", async () => {
  await delay(2000);
  const waiting = prq(dev, ["wait", "--poll-ms", "4000", "--max-wait-ms", "4000"], { token, agentId: "p-long" });
  await delay(2500);
  expect((await sessionState(dev, "octo~p~4")).owner).toBe("local");
  expect((await waiting).code).toBe(2);
});
