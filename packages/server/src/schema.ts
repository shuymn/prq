// Each Durable Object class's schema, as ordered SQL statements. The constructor applies the ones above the version
// stored in prq_schema, all in one transaction, before the object handles any event. Steps are only appended, never
// edited or reordered: the stored version counts the steps already applied. PRAGMA user_version is not used because
// the Agents SDK keeps its own tables (cf_*) in the same database.
type SchemaSteps = readonly string[];

export const HUB_SCHEMA: SchemaSteps = [
  // gen: the Hub's counter, which only grows. Notification rows take their generation from it, and claim calls their
  // attempt number.
  "CREATE TABLE prq_hub (id INTEGER PRIMARY KEY CHECK (id = 1), gen INTEGER NOT NULL DEFAULT 0)",
  "INSERT INTO prq_hub (id) VALUES (1)",
  // The pool: each local agent ID and its last contact (epoch ms).
  "CREATE TABLE prq_agents (agent_id TEXT PRIMARY KEY, last_seen_at INTEGER NOT NULL)",
  // The notification queue: sessions that may have local work, with the generation of their latest notify.
  `CREATE TABLE prq_notifications (
    session TEXT PRIMARY KEY, gen INTEGER NOT NULL, notified_at INTEGER NOT NULL)`,
  // The ledger: each session's newest entry (JSON) with its revision, and the time of its latest event (NULL until
  // one), which orders the list.
  `CREATE TABLE prq_ledger (
    session TEXT PRIMARY KEY, rev INTEGER NOT NULL, latest_event_at INTEGER, entry TEXT NOT NULL)`,
  // The claims the ledger entries hold, per session and job: the agent ID and the claim's time on the Hub's clock.
  `CREATE TABLE prq_claims (
    session TEXT NOT NULL, job_id TEXT NOT NULL, agent_id TEXT NOT NULL, claimed_at INTEGER NOT NULL,
    PRIMARY KEY (session, job_id))`,
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
  // Intake: a row per question waiting for its job, written before the question and removed with the job's creation.
  "CREATE TABLE prq_intake (seq INTEGER PRIMARY KEY AUTOINCREMENT, question_id TEXT NOT NULL UNIQUE)",
  // Per agent ID, the newest of the Hub's claim attempts that claimed a job here. Kept apart from the jobs: a retry,
  // which clears a job's claim, does not lower it.
  "CREATE TABLE prq_claim_attempts (agent_id TEXT PRIMARY KEY, attempt INTEGER NOT NULL)",
  // rev: the job's revision, advanced by every change of the job in the statement that makes it. A retry names the
  // revision it was made from.
  "ALTER TABLE prq_jobs ADD COLUMN rev INTEGER NOT NULL DEFAULT 0",
  // run: the job's run, 1 at first, advanced only by a retry in its statement. A submit names the run its answer was
  // produced under.
  "ALTER TABLE prq_jobs ADD COLUMN run INTEGER NOT NULL DEFAULT 1",
  // The pull request as its webhooks describe it, NULL until the first. head_sha is the current head, which only a
  // push moves (the first webhook sets it); the others follow the latest webhook.
  "ALTER TABLE prq_session ADD COLUMN head_sha TEXT",
  "ALTER TABLE prq_session ADD COLUMN base_sha TEXT",
  "ALTER TABLE prq_session ADD COLUMN full_name TEXT",
  "ALTER TABLE prq_session ADD COLUMN title TEXT",
  "ALTER TABLE prq_session ADD COLUMN pr_state TEXT CHECK (pr_state IN ('open', 'closed', 'merged'))",
  "ALTER TABLE prq_session ADD COLUMN url TEXT",
  // GitHub's time (pull_request.updated_at, epoch ms) of the push that set head_sha, and of the webhook that set the
  // other details: what orders the webhooks, whenever the session gets to them. NULL until the first.
  "ALTER TABLE prq_session ADD COLUMN head_at INTEGER",
  "ALTER TABLE prq_session ADD COLUMN details_at INTEGER",
  // The webhook inbox: each verified delivery, stored before it is acknowledged and taken in by settle. Kept once
  // processed, so a delivery that comes again is known by its ID.
  `CREATE TABLE prq_inbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL,
    push INTEGER NOT NULL CHECK (push IN (0, 1)),
    at INTEGER NOT NULL,
    before_sha TEXT,
    head_sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    full_name TEXT NOT NULL,
    title TEXT NOT NULL,
    pr_state TEXT NOT NULL CHECK (pr_state IN ('open', 'closed', 'merged')),
    url TEXT NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0 CHECK (processed IN (0, 1)))`,
  // The ledger row's latest event (a push that changed the head, a question, a completed summary or answer) and the
  // session's time of it, NULL until the first.
  "ALTER TABLE prq_session ADD COLUMN latest_event_kind TEXT CHECK (latest_event_kind IN ('push', 'question', 'summary', 'answer'))",
  "ALTER TABLE prq_session ADD COLUMN latest_event_at INTEGER",
  // unresolved_failure: 1 from the statement that fails the job to the statement that completes it, whatever happens
  // between (a retry, a supersede, a revival).
  "ALTER TABLE prq_jobs ADD COLUMN unresolved_failure INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_failure IN (0, 1))",
  "UPDATE prq_jobs SET unresolved_failure = 1 WHERE state = 'failed'",
  // The outbox's second kind, ledger: the session's entry for the Hub. SQLite cannot change a CHECK in place.
  "CREATE TABLE prq_outbox_next (kind TEXT PRIMARY KEY CHECK (kind IN ('notify', 'ledger')), gen INTEGER NOT NULL)",
  "INSERT INTO prq_outbox_next (kind, gen) SELECT kind, gen FROM prq_outbox",
  "DROP TABLE prq_outbox",
  "ALTER TABLE prq_outbox_next RENAME TO prq_outbox",
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
