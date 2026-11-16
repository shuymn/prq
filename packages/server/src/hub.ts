import { parseSessionName } from "@prq/protocol";
import { Agent, type Connection } from "agents";

import { refuseSubAgent, sendServerVersion } from "./agents.ts";
import { log } from "./log.ts";
import { HUB_SCHEMA, migrate } from "./schema.ts";

// An agent ID counts as present until this long after its last contact (docs/design.md, Presence).
export const PRESENCE_MS = 10 * 60_000;

// The one Hub (HUB_NAME): the pool of local agents and the queue of sessions that may have work for them. It holds no
// job state: each PrSession keeps its own, and asks the Hub about presence.
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

  // A contact from a local agent (a claim, wait, submit or context, from #4 on).
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
}
