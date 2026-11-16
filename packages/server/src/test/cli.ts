// The calls a local agent and the UI make to /cli/* and /api/*, through the Worker with the host's Access token, and a
// local session to make them against.

import { ClaimResponse, type PrRef, SubmitResponse, WaitResponse } from "@prq/protocol";
import type { UIMessage } from "ai";
import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import * as v from "valibot";
import { expect, vi } from "vitest";

import { request } from "./access.ts";
import type { AgentSocket } from "./chat.ts";
import { gate, hub, newSession, setPool, submission } from "./session.ts";

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

// A JSON POST through the Worker; a string body is sent as it is.
export function post(path: string, token: string | undefined, body: unknown, signal?: AbortSignal): Promise<Response> {
  return exports.default.fetch(
    request(path, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: signal ?? null,
    }),
  );
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

export function retryOver(token: string, pr: PrRef, jobId: string): Promise<Response> {
  return post(`/api/pr/${pr.owner}/${pr.repo}/${pr.number}/jobs/${jobId}/retry`, token, {});
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
