// Hub: the local agent pool (presence per agent ID) and the notification list for prq. It holds no job state: each
// PrSession is the authority for its jobs, and the Hub only remembers which sessions may have local work.
import type { ClaimResponse, WaitResponse } from "@prq/protocol";
import { Agent, getAgentByName } from "agents";

export const HUB_NAME = "hub";

export class Hub extends Agent<Env> {
  /** Bumped on every notify; a waiter compares it to detect a notify that raced with its own check. */
  #generation = 0;
  #waiters = new Set<() => void>();
  /** Long-polls in flight per agent ID: an agent is present while it waits. */
  #waiting = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql`CREATE TABLE IF NOT EXISTS presence (agent_id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS work (session TEXT PRIMARY KEY, updated INTEGER NOT NULL)`;
  }

  #ttl(): number {
    return Number(this.env.PRESENCE_TTL_MS);
  }

  touch(agentId: string): void {
    const now = Date.now();
    this.sql`INSERT INTO presence (agent_id, last_seen) VALUES (${agentId}, ${now})
      ON CONFLICT(agent_id) DO UPDATE SET last_seen = excluded.last_seen`;
  }

  isLocalPresent(): boolean {
    for (const n of this.#waiting.values()) if (n > 0) return true;
    const since = Date.now() - this.#ttl();
    const rows = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM presence WHERE last_seen >= ${since}`;
    return (rows[0]?.n ?? 0) > 0;
  }

  notify(session: string): void {
    this.sql`INSERT INTO work (session, updated) VALUES (${session}, ${Date.now()})
      ON CONFLICT(session) DO UPDATE SET updated = excluded.updated`;
    this.#generation++;
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  #sessions(): string[] {
    return this.sql<{ session: string }>`SELECT session FROM work ORDER BY updated`.map((r) => r.session);
  }

  async #hasWork(agentId: string): Promise<boolean> {
    for (const session of this.#sessions()) {
      const stub = await getAgentByName(this.env.PrSession, session);
      const peek = await stub.peek(agentId);
      if (!peek.open) this.sql`DELETE FROM work WHERE session = ${session}`;
      if (peek.resume || peek.fresh) return true;
    }
    return false;
  }

  /**
   * Long-poll: returns "ready" as soon as some session has a job this agent can claim (including its own unfinished
   * claimed job), or "timeout" after timeoutMs. It never consumes a job; the job stays until a claim.
   */
  async wait(agentId: string, timeoutMs: number): Promise<WaitResponse> {
    const deadline = Date.now() + Math.min(timeoutMs, Number(this.env.WAIT_MAX_MS));
    this.touch(agentId);
    this.#waiting.set(agentId, (this.#waiting.get(agentId) ?? 0) + 1);
    try {
      for (;;) {
        const seen = this.#generation;
        if (await this.#hasWork(agentId)) return { status: "ready" };
        if (this.#generation !== seen) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { status: "timeout" };
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            this.#waiters.delete(wake);
            resolve();
          }, remaining);
          this.#waiters.add(wake);
        });
      }
    } finally {
      const n = (this.#waiting.get(agentId) ?? 1) - 1;
      if (n > 0) this.#waiting.set(agentId, n);
      else this.#waiting.delete(agentId);
      this.touch(agentId);
    }
  }

  /** The agent's own unfinished claimed job comes first (with a new claimId), then the oldest pending job. */
  async claim(agentId: string): Promise<ClaimResponse> {
    this.touch(agentId);
    for (const mode of ["resume", "fresh"] as const) {
      for (const session of this.#sessions()) {
        const stub = await getAgentByName(this.env.PrSession, session);
        const res = await stub.claim(agentId, mode);
        if (res.job) return res;
      }
    }
    return { job: null };
  }
}
