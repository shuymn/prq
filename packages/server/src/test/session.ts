// Sessions, the Hub's pool and queue, and holds inside a Durable Object, for the job tests. Storage is shared by the
// tests of one file (and not across files), so each test takes a pull request of its own and sets the pool it needs.

import type { ClaimResponse, Owner, PrRef } from "@prq/protocol";
import type { UIMessage } from "ai";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";

import type { Hub } from "../hub.ts";
import { hubStub, prSessionStub } from "../names.ts";
import type { CloudAgent } from "../pr-session/cloud.ts";
import type { PrSession, Submission } from "../pr-session/index.ts";
import type { JobRow } from "../pr-session/jobs.ts";
import { type AgentSocket, connect, hostToken } from "./chat.ts";
import { latch } from "./latch.ts";

let counter = 0;

// A pull request no other test of the file uses, its session, and a way to open chat connections to it.
export async function newSession(repo: string, sockets: AgentSocket[]) {
  counter += 1;
  const ref: PrRef = { owner: "octo", repo, number: counter };
  const name = `octo~${repo}~${counter}`;
  const path = `/agents/pr-session/${name}`;
  const token = await hostToken();
  const stub = await prSessionStub(env, ref);
  const open = async () => {
    const socket = await connect(path, token);
    sockets.push(socket);
    return socket;
  };
  return { ref, name, path, token, stub, open };
}

export type Session = Awaited<ReturnType<typeof newSession>>;

export function hub(): Promise<DurableObjectStub<Hub>> {
  return hubStub(env);
}

// The pool as a test needs it: no agent present, or the given agents present (a contact just now).
export async function setPool(agentIds: readonly string[]): Promise<void> {
  const stub = await hub();
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec("DELETE FROM prq_agents");
  });
  for (const agentId of agentIds) {
    await stub.touch(agentId);
  }
}

// The sessions in the Hub's notification queue.
export async function queued(): Promise<string[]> {
  return runInDurableObject(await hub(), (_, state) =>
    state.storage.sql
      .exec<{ session: string }>("SELECT session FROM prq_notifications ORDER BY session")
      .toArray()
      .map((row) => row.session),
  );
}

export async function jobRows(stub: DurableObjectStub<PrSession>): Promise<JobRow[]> {
  return runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<JobRow>("SELECT * FROM prq_jobs ORDER BY seq").toArray(),
  );
}

// The job of a question.
export async function jobOf(stub: DurableObjectStub<PrSession>, questionId: string): Promise<JobRow> {
  const row = (await jobRows(stub)).find((job) => job.kind === "answer" && job.target === questionId);
  if (row === undefined) {
    throw new Error(`no job for ${questionId}`);
  }
  return row;
}

// Runs SQL inside the session (backdating, standing in for #5's completion of a cloud job).
export async function sessionSql(stub: DurableObjectStub<PrSession>, query: string, ...bindings: unknown[]) {
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec(query, ...bindings);
  });
}

// The settle wakes scheduled for a later second.
export async function laterWakes(stub: DurableObjectStub<PrSession>): Promise<number> {
  return runInDurableObject(stub, async (instance) => {
    const later = await instance.listSchedules({ timeRange: { start: new Date(Date.now() + 1000) } });
    return later.filter((schedule) => schedule.callback === "settle").length;
  });
}

// Every settle schedule row, due or not.
export async function wakes(stub: DurableObjectStub<PrSession>): Promise<number> {
  return runInDurableObject(
    stub,
    async (instance) => (await instance.listSchedules()).filter((schedule) => schedule.callback === "settle").length,
  );
}

export async function cancelWakes(stub: DurableObjectStub<PrSession>): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    for (const schedule of await instance.listSchedules()) {
      await instance.cancelSchedule(schedule.id);
    }
  });
}

// The cache (this.messages) as after a restart: the SDK's own hydration, under the given budget. Returns the cached IDs.
export async function hydrateRecent(stub: DurableObjectStub<PrSession>, budget: number): Promise<string[]> {
  return runInDurableObject(stub, async (instance) => {
    instance.hydrationByteBudget = budget;
    await Reflect.get(instance, "_hydrateMessages").call(instance);
    return instance.messages.map((message) => message.id);
  });
}

// A hold inside a Durable Object. Its latch is made and opened in the object's context (a promise continues in the
// context that settles it). A spy that holds a call awaits `wait()`; the test sees that `count` calls got there through
// `reached(count)` and lets them all go on at once with `open()`.
export type Gate = {
  wait(): Promise<void>;
  reached(count?: number): Promise<void>;
  isReached(): boolean;
  open(): Promise<void>;
};

export async function gate(stub: DurableObjectStub): Promise<Gate> {
  let waiting = 0;
  let open: (() => void) | null = null;
  let promise: Promise<void> | null = null;
  await runInDurableObject(stub, () => {
    const held = latch();
    open = () => held.open();
    promise = held.promise;
  });
  return {
    wait: async () => {
      waiting += 1;
      await promise;
    },
    reached: (count = 1) => vi.waitFor(() => expect(waiting).toBeGreaterThanOrEqual(count), { timeout: 3000 }),
    isReached: () => waiting > 0,
    open: () => runInDurableObject(stub, () => open?.()),
  };
}

// A promise's state, without waiting for it.
export function tracked<P extends PromiseLike<unknown>>(
  promise: P,
): { promise: Promise<Awaited<P>>; settled(): boolean } {
  let settled = false;
  const tracking: Promise<Awaited<P>> = Promise.resolve(promise).finally(() => {
    settled = true;
  });
  return { promise: tracking, settled: () => settled };
}

// The promise's outcome, or a rejection when it is still pending after ms (a bound, not an order of events).
export async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, pending]);
  } finally {
    clearTimeout(timer);
  }
}

// The protected members of PrSession (and AIChatAgent) that tests hold or replace. A type guard, not an assertion: it also fails a test
// at once when a member is renamed.
export type PrSessionSeams = {
  readPool(): Promise<boolean>;
  ownerOf(): Promise<Owner | null>;
  createJobs(): Promise<void>;
  insertMessages(messages: UIMessage[]): Promise<void>;
  deliver(): Promise<void>;
  cloudAgent(): CloudAgent | undefined;
  // AIChatAgent's own.
  waitUntilStable(options?: { timeout?: number }): Promise<boolean>;
};

const PR_SESSION_SEAMS = [
  "readPool",
  "ownerOf",
  "createJobs",
  "insertMessages",
  "deliver",
  "cloudAgent",
  "waitUntilStable",
] as const;

function hasPrSessionSeams(instance: object): instance is PrSessionSeams {
  return PR_SESSION_SEAMS.every((name) => typeof Reflect.get(instance, name) === "function");
}

export function prSessionSeams(instance: object): PrSessionSeams {
  if (!hasPrSessionSeams(instance)) {
    throw new TypeError("PrSession lacks a member the tests hold");
  }
  return instance;
}

// A claimed job's submit with the given text.
export function submission(claim: ClaimResponse, agentId: string, text = "the answer"): Submission {
  if (claim.job === null) {
    throw new Error("nothing was claimed");
  }
  return { agentId, jobId: claim.job.jobId, claimId: claim.claimId, target: claim.job.target, text };
}
