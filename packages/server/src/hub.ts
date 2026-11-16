import { type ClaimResponse, parseSessionName, type PrRef } from "@prq/protocol";
import { Agent, type Connection } from "agents";

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

type Notification = { session: string; gen: number };

// The one Hub (HUB_NAME): the pool of local agents and the queue of sessions that may have work for them. It holds no
// job state: it asks each PrSession (peek, claim), and each PrSession asks it about presence.
export class Hub extends Agent<Env> {
  readonly #sql: SqlStorage;

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

  // A contact from a local agent: a claim (wait, submit and context too, from #4 on).
  touch(agentId: string): void {
    this.#sql.exec(
      `INSERT INTO prq_agents (agent_id, last_seen_at) VALUES (?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      agentId,
      Date.now(),
    );
  }

  // Whether any local agent is present: one whose last contact is less than PRESENCE_MS ago.
  isLocalPresent(): boolean {
    const since = Date.now() - PRESENCE_MS;
    return this.#sql.exec("SELECT 1 FROM prq_agents WHERE last_seen_at > ? LIMIT 1", since).toArray().length > 0;
  }

  // --- The notification queue ---

  // A session may have local work. Its row takes the next value of the Hub's counter, which only grows: a check that
  // read an older generation then never deletes it. Only a canonical session name is queued.
  notify(session: string): void {
    if (parseSessionName(session) === null) {
      log("prq.hub.notify_refused", {}, "warn");
      return;
    }
    const { gen } = this.#sql
      .exec<{ gen: number }>("UPDATE prq_hub SET gen = gen + 1 WHERE id = 1 RETURNING gen")
      .one();
    this.#sql.exec(
      `INSERT INTO prq_notifications (session, gen, notified_at) VALUES (?, ?, ?)
       ON CONFLICT (session) DO UPDATE SET gen = excluded.gen`,
      session,
      gen,
      Date.now(),
    );
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

  // The agent's own claimed job first, from any queued session (a resume, under a new claimId), then the next pending
  // job, session by session.
  async claim(agentId: string): Promise<ClaimResponse> {
    this.touch(agentId);
    for (const mode of ["resume", "fresh"] as const) {
      for (const { session } of this.#queue()) {
        let response: ClaimResponse;
        try {
          response = await this.claimSession(session, agentId, mode);
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

  // A session's claim. One that times out may still have claimed: the job is then the agent's own claimed job, which
  // its next claim resumes under a new claimId.
  protected async claimSession(session: string, agentId: string, mode: "resume" | "fresh"): Promise<ClaimResponse> {
    return this.#callSession<ClaimResponse>(session, "a session's claim", (stub) => stub.claim(agentId, mode));
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

function sessionRef(session: string): PrRef {
  const ref = parseSessionName(session);
  if (ref === null) {
    throw new TypeError("the queue holds canonical session names only");
  }
  return ref;
}
