// The calls a local agent and the UI make to /cli/* and /api/*, through the Worker with the host's Access token, and a
// local session to make them against.

import { ClaimResponse, type PrRef, SubmitResponse, WaitResponse } from "@prq/protocol";
import type { UIMessage } from "ai";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { expect, vi } from "vitest";

import { createApp } from "../app.ts";
import type { CallBound } from "../http.ts";
import { WaitTimeout } from "../wait.ts";
import { request } from "./access.ts";
import type { AgentSocket } from "./chat.ts";
import { latch } from "./latch.ts";
import { gate, hub, hubSeams, newSession, setPool, submission } from "./session.ts";

// A local session (the agent "laptop" present) with the given questions asked over a chat connection.
export async function localSession(repo: string, sockets: AgentSocket[], ...questions: UIMessage[]) {
  await setPool(["laptop"]);
  const session = await newSession(repo, sockets);
  const client = await session.open();
  if (questions.length > 0) {
    await client.chat(questions);
  }
  return { ...session, client };
}

// A JSON POST; a string body is sent as it is.
export function postRequest(path: string, token: string | undefined, body: unknown, signal?: AbortSignal): Request {
  return request(path, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: signal ?? null,
  });
}

// A JSON POST through the Worker.
export function post(path: string, token: string | undefined, body: unknown, signal?: AbortSignal): Promise<Response> {
  return exports.default.fetch(postRequest(path, token, body, signal));
}

export function waitOver(token: string, agentId: string, timeoutMs?: number, signal?: AbortSignal): Promise<Response> {
  return post("/cli/wait", token, timeoutMs === undefined ? { agentId } : { agentId, timeoutMs }, signal);
}

export async function waitStatus(response: Promise<Response>): Promise<WaitResponse["status"]> {
  const res = await response;
  expect(res.status).toBe(200);
  return v.parse(WaitResponse, await res.json()).status;
}

export async function claimOver(token: string, agentId: string): Promise<ClaimResponse> {
  const res = await post("/cli/claim", token, { agentId });
  expect(res.status).toBe(200);
  return v.parse(ClaimResponse, await res.json());
}

export function submitOver(token: string, pr: PrRef, claim: ClaimResponse, agentId: string, text?: string) {
  return post("/cli/submit", token, { ...submission(claim, agentId, text), pr });
}

export async function accepted(response: Promise<Response>): Promise<SubmitResponse> {
  const res = await response;
  expect(res.status).toBe(200);
  return v.parse(SubmitResponse, await res.json());
}

export function retryPath(pr: PrRef, jobId: string): string {
  return `/api/pr/${pr.owner}/${pr.repo}/${pr.number}/jobs/${jobId}/retry`;
}

// A retry through the route, from the job's revision in the view the UI shows.
export function retryOver(token: string, pr: PrRef, jobId: string, expectedRev: number): Promise<Response> {
  return post(retryPath(pr, jobId), token, { expectedRev });
}

// Watches the checks the Hub's waits make (hasWork, which a wait calls on the instance): counts the ones that have
// answered, and holds the given call after it answered, until the gate opens.
export async function watchChecks(holdCall?: number) {
  const stub = await hub();
  const held = await gate(stub);
  let started = 0;
  let answered = 0;
  await runInDurableObject(stub, (instance) => {
    const check = instance.hasWork.bind(instance);
    vi.spyOn(instance, "hasWork").mockImplementation(async (agentId) => {
      started += 1;
      const call = started;
      const answer = await check(agentId);
      if (call === holdCall) {
        await held.wait();
      }
      answered += 1;
      return answer;
    });
  });
  return {
    held,
    answered: (count = 1) => vi.waitFor(() => expect(answered).toBeGreaterThanOrEqual(count), { timeout: 3000 }),
  };
}

// Sets every agent's last contact `ms` ago.
export async function lastSeenAgo(ms: number): Promise<void> {
  await runInDurableObject(await hub(), (_, state) => {
    state.storage.sql.exec("UPDATE prq_agents SET last_seen_at = ?", Date.now() - ms);
  });
}

// Takes over the timers that end the Hub's waits: each wait's bound is recorded with whether it was cancelled, and a
// wait reaches its bound only when the test expires it.
export async function controlWaitTimers() {
  const stub = await hub();
  const timers: { ms: number; end: () => void; cancelled: boolean }[] = [];
  await runInDurableObject(stub, (instance) => {
    vi.spyOn(hubSeams(instance), "waitTimer").mockImplementation((ms, end) => {
      const timer = { ms, end, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    });
  });
  return {
    timers: () => timers.map(({ ms, cancelled }) => ({ ms, cancelled })),
    started: (count = 1) => vi.waitFor(() => expect(timers.length).toBeGreaterThanOrEqual(count), { timeout: 3000 }),
    // Ends the latest wait as its bound passing would.
    expire: () => runInDurableObject(stub, () => timers.at(-1)?.end()),
  };
}

// A bound for the routes' calls (createApp) that the test ends by hand: it records each call's bound, and once
// expire() is called every call still pending fails with a WaitTimeout. late() is the outcome the first call lands
// with afterwards.
export function heldBound() {
  const bounds: { ms: number; what: string }[] = [];
  const outcomes: Promise<unknown>[] = [];
  const expiry = latch();
  const bound: CallBound = (call, ms, what) => {
    const outcome = Promise.resolve(call);
    bounds.push({ ms, what });
    outcomes.push(outcome.catch((error: unknown) => error));
    const expired = expiry.promise.then((): never => {
      throw new WaitTimeout(`${what} expired`);
    });
    return Promise.race([outcome, expired]);
  };
  const late = () => outcomes[0] ?? Promise.reject(new Error("no call was bounded"));
  return { bound, bounds, late, expire: () => expiry.open() };
}

// A request through the Worker's routes with the given bound on their calls to Durable Objects.
export async function fetchBounded(bound: CallBound, req: Request): Promise<Response> {
  return createApp(bound).fetch(req, env);
}
