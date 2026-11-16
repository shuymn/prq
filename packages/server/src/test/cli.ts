// The calls a local agent and the UI make to /cli/* and /api/*, through the Worker with the host's Access token, and a
// local session to make them against.

import type { PrRef } from "@prq/protocol";
import type { UIMessage } from "ai";
import { exports } from "cloudflare:workers";

import { request } from "./access.ts";
import type { AgentSocket } from "./chat.ts";
import { newSession, setPool } from "./session.ts";

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

export function retryOver(token: string, pr: PrRef, jobId: string): Promise<Response> {
  return post(`/api/pr/${pr.owner}/${pr.repo}/${pr.number}/jobs/${jobId}/retry`, token, {});
}
