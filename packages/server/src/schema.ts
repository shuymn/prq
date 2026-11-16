// Each Durable Object class's schema, as ordered SQL statements. The constructor applies the ones above the version
// stored in prq_schema, all in one transaction, before the object handles any event. Steps are only appended, never
// edited or reordered: the stored version counts the steps already applied. PRAGMA user_version is not used because
// the Agents SDK keeps its own tables (cf_*) in the same database.
type SchemaSteps = readonly string[];

export const HUB_SCHEMA: SchemaSteps = [
  // gen: the counter notification rows take their generation from; it only grows.
  "CREATE TABLE prq_hub (id INTEGER PRIMARY KEY CHECK (id = 1), gen INTEGER NOT NULL DEFAULT 0)",
  "INSERT INTO prq_hub (id) VALUES (1)",
  // The pool: each local agent ID and its last contact (epoch ms).
  "CREATE TABLE prq_agents (agent_id TEXT PRIMARY KEY, last_seen_at INTEGER NOT NULL)",
  // The notification queue: sessions that may have local work, with the generation of their latest notify.
  `CREATE TABLE prq_notifications (
    session TEXT PRIMARY KEY, gen INTEGER NOT NULL, notified_at INTEGER NOT NULL)`,
];

export const PR_SESSION_SCHEMA: SchemaSteps = [
  // owner: NULL until the first job, then set once. gen: the counter outbox rows take their generation from.
  `CREATE TABLE prq_session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner TEXT CHECK (owner IN ('local', 'cloud')),
    gen INTEGER NOT NULL DEFAULT 0)`,
  "INSERT INTO prq_session (id) VALUES (1)",
  // One job per target: an analysis's head SHA, or an answer's question message ID. Times are epoch ms.
  `CREATE TABLE prq_jobs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('analysis', 'answer')),
    target TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'finalizing', 'running', 'done', 'failed', 'superseded')),
    agent_id TEXT,
    claim_id TEXT,
    claimed_at INTEGER,
    workspace_sha TEXT,
    done_claim_id TEXT,
    result_message_id TEXT,
    failure TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (kind, target))`,
  // What still has to reach the Hub: one row per kind, with the generation of its latest change.
  "CREATE TABLE prq_outbox (kind TEXT PRIMARY KEY CHECK (kind IN ('notify')), gen INTEGER NOT NULL)",
];

export function migrate(storage: DurableObjectStorage, steps: SchemaSteps): void {
  storage.transactionSync(() => {
    const { sql } = storage;
    sql.exec("CREATE TABLE IF NOT EXISTS prq_schema (version INTEGER NOT NULL)");
    const stored = sql.exec<{ version: number }>("SELECT version FROM prq_schema").toArray()[0]?.version;
    if (stored === undefined) {
      sql.exec("INSERT INTO prq_schema (version) VALUES (0)");
    }
    for (const [index, step] of steps.entries()) {
      if (index >= (stored ?? 0)) {
        sql.exec(step);
        sql.exec("UPDATE prq_schema SET version = ?", index + 1);
      }
    }
  });
}
