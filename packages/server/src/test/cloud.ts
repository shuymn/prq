// Cloud sessions for the cloud turn tests: a session whose owner is the cloud agent, its job rows, the stored
// conversation as rows, and the frames of the chat turns.

import type { UIMessage } from "ai";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";

import type { PrSession } from "../pr-session/index.ts";
import { type AgentSocket, storedMessages } from "./chat.ts";
import { jobRows, newSession, setPool } from "./session.ts";

// A session the first job of which goes to the cloud agent (no local agent present), and a connection to it.
export async function cloudSession(repo: string, sockets: AgentSocket[]) {
  await setPool([]);
  const session = await newSession(repo, sockets);
  const client = await session.open();
  return { ...session, client };
}

export type CloudSession = Awaited<ReturnType<typeof cloudSession>>;

// Waits until the job of the target (a question's message ID or a head SHA) is in the state.
export async function untilState(stub: DurableObjectStub<PrSession>, target: string, state: string): Promise<void> {
  await vi.waitFor(async () => expect((await jobRows(stub)).find((row) => row.target === target)?.state).toBe(state), {
    timeout: 5000,
    interval: 20,
  });
}

// The stored conversation, each message by ID as JSON: what an append-only history keeps byte for byte.
export async function messageRows(session: { path: string; token: string }): Promise<Map<string, string>> {
  return new Map(
    (await storedMessages(session.path, session.token)).map((message) => [message.id, JSON.stringify(message)]),
  );
}

// The history after a scenario holds every earlier row unchanged, in its place, and adds exactly the given IDs after
// them.
export function expectAppended(
  before: Map<string, string>,
  after: Map<string, string>,
  added: readonly string[],
): void {
  expect([...after.keys()]).toEqual([...before.keys(), ...added]);
  for (const [id, row] of before) {
    expect(after.get(id)).toBe(row);
  }
}

// The run's usage row of a job.
export async function usageOf(stub: DurableObjectStub<PrSession>, jobId: string) {
  return runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ run: number; starts: number; steps: number; input_tokens: number; output_tokens: number }>(
        "SELECT run, starts, steps, input_tokens, output_tokens FROM prq_job_usage WHERE job_id = ? ORDER BY run",
        jobId,
      )
      .toArray(),
  );
}

// The response frames of a chat turn (cf_agent_use_chat_response with its request ID), as the client received them.
export function turnFrames(client: AgentSocket, requestId: string): Record<string, unknown>[] {
  return client.frames.filter((frame) => frame["type"] === "cf_agent_use_chat_response" && frame["id"] === requestId);
}

// Whether any of the frames streams model output.
export function streamsText(frames: Record<string, unknown>[]): boolean {
  return frames.some((frame) => typeof frame["body"] === "string" && frame["body"].includes("text-delta"));
}

// The server's offer to resume a stream (its request ID), answering the resume request a connection sent from frame
// `from` on.
export async function resumeOffer(client: AgentSocket, from: number): Promise<{ id: string }> {
  const offer = await client.next(
    (frame) => frame["type"] === "cf_agent_stream_resuming" && frame["probeId"] !== undefined,
    from,
  );
  const id = offer["id"];
  if (typeof id !== "string") {
    throw new Error("a resume offer without a request ID");
  }
  return { id };
}

export function textOf(message: UIMessage | undefined): string {
  return (message?.parts ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

// A session's instance after a reset, reached without starting it: the Agents SDK starts an instance (onStart, so
// settle) at the first call through its named stub, and a test makes its holds in the new instance before that.
export function unstarted(name: string): DurableObjectStub<PrSession> {
  return env.PrSession.get(env.PrSession.idFromName(name));
}
