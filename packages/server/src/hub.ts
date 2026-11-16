import { type ClaimResponse, parseSessionName, type PrRef, WaitRequest, type WaitResponse } from "@prq/protocol";
import { Agent, type Connection } from "agents";
import * as v from "valibot";

import { refuseSubAgent, sendServerVersion } from "./agents.ts";
import { errorName, log } from "./log.ts";
import { prSessionStub } from "./names.ts";
import type { PrSession } from "./pr-session/index.ts";
import type { Peek } from "./pr-session/jobs.ts";
import { HUB_SCHEMA, migrate } from "./schema.ts";
import { withTimeout } from "./wait.ts";

// An agent ID counts as present until this long after its last contact (docs/design.md, Presence).
export const PRESENCE_MS = 10 * 60_000;
// How long a call to a PrSession may take, the session's start included.
const SESSION_CALL_MS = 10_000;
// The longest a wait lasts; the agent then waits again.
export const WAIT_MAX_MS = 25_000;

type Notification = { session: string; gen: number };

// The one Hub (HUB_NAME): the pool of local agents and the queue of sessions that may have work for them. It holds no
// job state: it asks each PrSession (peek, claim), and each PrSession asks it about presence.
export class Hub extends Agent<Env> {
  readonly #sql: SqlStorage;
  // The waits in flight, each with the wake-up a notify gives it. In memory only: a wait ends with its request.
  readonly #waiters = new Set<{ wake(): void }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    migrate(ctx.storage, HUB_SCHEMA);
  }

  override onConnect(connection: Connection): void {
    sendServerVersion(connection);
  }

  override async onBeforeSubAgent(): Promise<Response> {
    return refuseSubAgent();
  }

  // --- The pool ---

  // A contact from a local agent: a wait (at its start and end), a claim or a submit (context too, from PR 5 on).
  touch(agentId: string): void {
    this.#sql.exec(
      `INSERT INTO prq_agents (agent_id, last_seen_at) VALUES (?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      agentId,
      Date.now(),
    );
  }

  // Whether any local agent is present: one in a wait, or one whose last contact is less than PRESENCE_MS ago.
  isLocalPresent(): boolean {
    if (this.#waiters.size > 0) {
      return true;
    }
    const since = Date.now() - PRESENCE_MS;
    return this.#sql.exec("SELECT 1 FROM prq_agents WHERE last_seen_at > ? LIMIT 1", since).toArray().length > 0;
  }

  // The next value of the Hub's counter, which only grows.
  #next(): number {
    return this.#sql.exec<{ gen: number }>("UPDATE prq_hub SET gen = gen + 1 WHERE id = 1 RETURNING gen").one().gen;
  }

  #gen(): number {
    return this.#sql.exec<{ gen: number }>("SELECT gen FROM prq_hub WHERE id = 1").one().gen;
  }

  // --- The notification queue ---

  // A session may have local work. Its row takes the next value of the Hub's counter: a check that read an older
  // generation then never deletes it. Only a canonical session name is queued.
  notify(session: string): void {
    if (parseSessionName(session) === null) {
      log("prq.hub.notify_refused", {}, "warn");
      return;
    }
    const gen = this.#next();
    this.#sql.exec(
      `INSERT INTO prq_notifications (session, gen, notified_at) VALUES (?, ?, ?)
       ON CONFLICT (session) DO UPDATE SET gen = excluded.gen`,
      session,
      gen,
      Date.now(),
    );
    for (const waiter of this.#waiters) {
      waiter.wake();
    }
  }

  // The queued sessions, first notified first.
  #queue(): Notification[] {
    return this.#sql
      .exec<Notification>("SELECT session, gen FROM prq_notifications ORDER BY notified_at, session")
      .toArray();
  }

  // Whether a queued session has work for the agent: its own claimed job or a pending one. A session with no open job
  // leaves the queue, unless it was notified again during the check. A session that cannot be asked stays queued.
  async hasWork(agentId: string): Promise<boolean> {
    for (const row of this.#queue()) {
      let peek: Peek;
      try {
        peek = await this.peekSession(row.session, agentId);
      } catch (error) {
        log("prq.hub.session_failed", { pr: row.session, call: "peek", error: errorName(error) }, "error");
        continue;
      }
      if (!peek.open) {
        this.#sql.exec("DELETE FROM prq_notifications WHERE session = ? AND gen = ?", row.session, row.gen);
      }
      if (peek.resume || peek.fresh) {
        return true;
      }
    }
    return false;
  }

  // --- Wait ---

  // /cli/wait reaches the Hub as an HTTP request from the Worker; the Agents route forwards only the Hub's WebSocket, so
  // nothing else reaches this handler. A request rather than an RPC call: its signal fires when the agent's request
  // goes away, which ends the wait at once, while an RPC callee never learns that its caller is gone.
  override async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/cli/wait") {
      return new Response(null, { status: 404 });
    }
    const { agentId, timeoutMs } = v.parse(WaitRequest, await request.json());
    return Response.json(await this.#wait(agentId, timeoutMs, request.signal));
  }

  // Ready as soon as a queued session has work for the agent, else timeout once the bound passes; it never takes a job.
  // The agent counts as present while it waits. Between checks it sleeps until a notify wakes it. A notify during a
  // check changes the Hub's counter, which the wait reads before the check and compares after it, so it checks again
  // rather than sleep past the notify.
  async #wait(agentId: string, timeoutMs: number | undefined, signal: AbortSignal): Promise<WaitResponse> {
    const waitMs = Math.min(timeoutMs ?? WAIT_MAX_MS, WAIT_MAX_MS);
    const end = waitEnd(signal, (ended) => this.waitTimer(waitMs, ended));
    const waiter = { wake: () => {} };
    this.#waiters.add(waiter);
    try {
      // The start is a contact. Written inside the try, so a failed write still drops the waiter and the timer.
      this.touch(agentId);
      while (!end.ended()) {
        const seen = this.#gen();
        if ((await end.race(this.hasWork(agentId))) === true) {
          return { status: "ready" };
        }
        if (!end.ended() && this.#gen() === seen) {
          await end.race(
            new Promise<void>((resolve) => {
              waiter.wake = resolve;
            }),
          );
        }
      }
      return { status: "timeout" };
    } finally {
      end.dispose();
      this.#waiters.delete(waiter);
      this.touch(agentId);
    }
  }

  // Ends a wait after ms, and returns the timer's cancel (spied on in tests, which end waits by hand).
  protected waitTimer(ms: number, end: () => void): () => void {
    const timer = setTimeout(end, ms);
    return () => clearTimeout(timer);
  }

  // --- Claim ---

  // The agent's own claimed job first, from any queued session (a resume, under a new claimId), then the next pending
  // job, session by session. The call is one attempt, numbered from the Hub's counter: a session lets no older attempt
  // of the agent replace what a newer one claimed.
  async claim(agentId: string): Promise<ClaimResponse> {
    this.touch(agentId);
    const attempt = this.#next();
    for (const mode of ["resume", "fresh"] as const) {
      for (const { session } of this.#queue()) {
        let response: ClaimResponse;
        try {
          response = await this.claimSession(session, agentId, mode, attempt);
        } catch (error) {
          log("prq.hub.session_failed", { pr: session, call: "claim", error: errorName(error) }, "error");
          continue;
        }
        if (response.job !== null) {
          return response;
        }
      }
    }
    return { job: null };
  }

  // A session's stub, once the session has started (spied on in tests).
  protected async sessionStub(session: string): Promise<DurableObjectStub<PrSession>> {
    return prSessionStub(this.env, sessionRef(session));
  }

  // The bound on a call to a session, its start included (spied on in tests).
  protected sessionCallMs(): number {
    return SESSION_CALL_MS;
  }

  // A session's peek (spied on in tests).
  protected async peekSession(session: string, agentId: string): Promise<Peek> {
    return this.#callSession<Peek>(session, "a session's peek", (stub) => stub.peek(agentId));
  }

  // A session's claim. One that times out keeps running and can still land: it claims nothing once a newer attempt of
  // the agent has claimed in the session, and otherwise its job is the agent's own claimed job, which the agent's next
  // claim resumes under a new claimId.
  protected async claimSession(
    session: string,
    agentId: string,
    mode: "resume" | "fresh",
    attempt: number,
  ): Promise<ClaimResponse> {
    return this.#callSession<ClaimResponse>(session, "a session's claim", (stub) => stub.claim(agentId, mode, attempt));
  }

  // A call to a session, bounded as a whole: getting the stub waits for the session's start.
  async #callSession<T>(
    session: string,
    what: string,
    call: (stub: DurableObjectStub<PrSession>) => PromiseLike<T>,
  ): Promise<T> {
    return withTimeout(this.sessionStub(session).then(call), this.sessionCallMs(), what);
  }
}

// A wait's end: its bound passing (the timer `start` sets) or its request's abort, whichever comes first.
function waitEnd(signal: AbortSignal, start: (end: () => void) => () => void) {
  let ended = false;
  let end!: () => void;
  const reached = new Promise<undefined>((resolve) => {
    end = () => {
      ended = true;
      resolve(undefined);
    };
  });
  const cancel = start(end);
  signal.addEventListener("abort", end);
  if (signal.aborted) {
    end();
  }
  return {
    ended: () => ended,
    // The promise's outcome, or undefined once the wait has ended.
    race: <T>(promise: Promise<T>): Promise<T | undefined> => Promise.race([promise, reached]),
    dispose: () => {
      cancel();
      signal.removeEventListener("abort", end);
    },
  };
}

function sessionRef(session: string): PrRef {
  const ref = parseSessionName(session);
  if (ref === null) {
    throw new TypeError("the queue holds canonical session names only");
  }
  return ref;
}
