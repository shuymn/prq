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
  // The ledger: each session's newest entry (JSON) with its revision, and what the list's order, its filters and the
  // Hub's totals read without parsing it: the latest event's time (-1 without one), the repository (owner/name,
  // canonical), whether the pull request is open (or its state not known yet), whether its problem needs attention with
  // a local agent present and without one, and its jobs.
  `CREATE TABLE prq_ledger (
    session TEXT PRIMARY KEY, rev INTEGER NOT NULL, entry TEXT NOT NULL,
    sort_at INTEGER NOT NULL, repo TEXT NOT NULL, open INTEGER NOT NULL CHECK (open IN (0, 1)),
    attention_present INTEGER NOT NULL CHECK (attention_present IN (0, 1)),
    attention_absent INTEGER NOT NULL CHECK (attention_absent IN (0, 1)),
    jobs_waiting INTEGER NOT NULL, jobs_running INTEGER NOT NULL, jobs_failed INTEGER NOT NULL)`,
  // The list's order, walked backwards, under each filter the ledger's pages take (prq_ledger_repo_open below is the
  // last): every page is a range of one index that holds only the rows the filter keeps.
  "CREATE INDEX prq_ledger_order ON prq_ledger (sort_at, session)",
  "CREATE INDEX prq_ledger_open ON prq_ledger (sort_at, session) WHERE open = 1",
  "CREATE INDEX prq_ledger_repo ON prq_ledger (repo, sort_at, session)",
  "CREATE INDEX prq_ledger_attention_present ON prq_ledger (sort_at, session) WHERE attention_present = 1",
  "CREATE INDEX prq_ledger_attention_absent ON prq_ledger (sort_at, session) WHERE attention_absent = 1",
  // The claims the ledger entries hold, per session and job: the agent ID and the claim's time on the Hub's clock.
  `CREATE TABLE prq_claims (
    session TEXT NOT NULL, job_id TEXT NOT NULL, agent_id TEXT NOT NULL, claimed_at INTEGER NOT NULL,
    PRIMARY KEY (session, job_id))`,
  "CREATE INDEX prq_claims_agent ON prq_claims (agent_id)",
  // The repositories the ledger has rows of (owner/name, canonical), with their owner and their name in GitHub's display
  // case once an entry has given it.
  "CREATE TABLE prq_repos (repo TEXT PRIMARY KEY, owner TEXT NOT NULL, full_name TEXT NOT NULL)",
  "CREATE INDEX prq_repos_owner ON prq_repos (owner)",
  // The ledger's totals, kept with each stored entry so the Hub's view reads no row: its version (advanced by every
  // stored entry), the rows that need attention with a local agent present and without one, the jobs of every row, and
  // the owners of the repositories.
  `CREATE TABLE prq_ledger_totals (
    id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0,
    attention_present INTEGER NOT NULL DEFAULT 0, attention_absent INTEGER NOT NULL DEFAULT 0,
    jobs_waiting INTEGER NOT NULL DEFAULT 0, jobs_running INTEGER NOT NULL DEFAULT 0,
    jobs_failed INTEGER NOT NULL DEFAULT 0, owners INTEGER NOT NULL DEFAULT 0)`,
  "INSERT INTO prq_ledger_totals (id) VALUES (1)",
  // One repository's open rows in the list's order, for the list under both of its filters (state=open with repo).
  "CREATE INDEX prq_ledger_repo_open ON prq_ledger (repo, sort_at, session) WHERE open = 1",
  // Each agent's last contact and each claim by its time, so presence reads only the contacts and claims recent enough
  // to make an agent present, however many came before.
  "CREATE INDEX prq_agents_seen ON prq_agents (last_seen_at)",
  "CREATE INDEX prq_claims_claimed ON prq_claims (claimed_at)",
  // Each agent's claims by time, so a present agent's latest claim is one row however many it holds; it takes the place
  // of the index on the agent alone.
  "CREATE INDEX prq_claims_agent_claimed ON prq_claims (agent_id, claimed_at)",
  "DROP INDEX prq_claims_agent",
  // The host's two prompts (docs/design.md, Instructions and skills): each kind's text and when it was saved (epoch ms).
  // A kind without a row has never been saved and reads as the empty prompt.
  `CREATE TABLE prq_prompts (
    kind TEXT PRIMARY KEY CHECK (kind IN ('analysis', 'answer')), text TEXT NOT NULL, saved_at INTEGER NOT NULL)`,
  // The host's skills (docs/design.md, Instructions and skills): per name, the registration's revision (from the Hub's
  // counter, on every register and update), where it came from (repository, the directory's path, the ref as named and
  // its kind), the pinned commit, the frontmatter the settings show (allowed-tools as a JSON array of its entries as
  // written, NULL when absent), and when it was registered and last updated (epoch ms).
  `CREATE TABLE prq_skills (
    name TEXT PRIMARY KEY, rev INTEGER NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL, path TEXT NOT NULL,
    ref TEXT NOT NULL, ref_kind TEXT NOT NULL CHECK (ref_kind IN ('branch', 'tag', 'commit')), sha TEXT NOT NULL,
    description TEXT NOT NULL, allowed_tools TEXT, license TEXT,
    registered_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  // Each registered skill's regular files at its pinned commit: path in the skill, git mode, size, git blob SHA-1, and
  // the whole file.
  `CREATE TABLE prq_skill_files (
    name TEXT NOT NULL, path TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('100644', '100755')),
    size INTEGER NOT NULL, blob TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY (name, path))`,
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
  // The claims whose stall the ledger has been told of: a claim past its deadline is published once, by claimAged or by
  // settle, whichever finds it first. Rows of claims no longer held are dropped with the next mark.
  "CREATE TABLE prq_stalls (claim_id TEXT PRIMARY KEY)",
  // turn_id: the cloud turn a running job is bound to, NULL in every other state. A turn's end, and settle's restart,
  // change the job only while it is still that turn's.
  "ALTER TABLE prq_jobs ADD COLUMN turn_id TEXT",
  // What each run of a cloud job used, summed over its starts, so a restart after a reset keeps the steps that
  // finished: the starts, the model calls (steps) and their tokens, and the session's time of the run's first start.
  `CREATE TABLE prq_job_usage (
    job_id TEXT NOT NULL,
    run INTEGER NOT NULL,
    starts INTEGER NOT NULL DEFAULT 0,
    steps INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, run))`,
  // The GitHub App installation a delivery came through (NULL when it named none), and the latest one the session took
  // in with the details: the installation whose token reads the pull request.
  "ALTER TABLE prq_inbox ADD COLUMN installation_id INTEGER",
  "ALTER TABLE prq_session ADD COLUMN installation_id INTEGER",
  // Head reconciliation (docs/design.md, Intake): reconcile_at marks a same-second tie for a read of GitHub's head and
  // is NULL or head_at; push_gen counts the pushes taken in, so a read knows whether one came after it was requested;
  // reconcile_tries counts the failed reads of the mark.
  "ALTER TABLE prq_session ADD COLUMN reconcile_at INTEGER",
  "ALTER TABLE prq_session ADD COLUMN push_gen INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE prq_session ADD COLUMN reconcile_tries INTEGER NOT NULL DEFAULT 0",
  // The cloud turns' sequence: turn_seq counts the turns started (each start and restart advances it), and a running
  // job keeps the number of its turn, which the turn's workspace calls carry.
  "ALTER TABLE prq_session ADD COLUMN turn_seq INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE prq_jobs ADD COLUMN turn_seq INTEGER",
  // Context compaction (docs/design.md, Model context). The analysis notes: their text (NULL until the first compaction
  // is adopted) and the two summaries it is assembled from (the history's, and the checkpoint of a turn the cut falls
  // inside), their revision (advanced by each adopted compaction), the cut (the message and the step within it where
  // the kept part starts), the head when they were made, and the files read (a JSON array of paths).
  `CREATE TABLE prq_notes (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    text TEXT,
    history TEXT,
    turn_context TEXT,
    rev INTEGER NOT NULL DEFAULT 0,
    cut_message_id TEXT,
    cut_step INTEGER,
    target_sha TEXT,
    read_files TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER)`,
  "INSERT INTO prq_notes (id) VALUES (1)",
  // The context count: the last committed turn's last model call (input and output tokens; NULL when the provider
  // reported none), the result it ended with, and the notes revision its context was built on; and the projection's
  // last message when a compaction failed, so a turn's start does not repeat it.
  "ALTER TABLE prq_session ADD COLUMN context_tokens INTEGER",
  "ALTER TABLE prq_session ADD COLUMN context_through TEXT",
  "ALTER TABLE prq_session ADD COLUMN context_notes_rev INTEGER",
  "ALTER TABLE prq_session ADD COLUMN compaction_failed_through TEXT",
  // Whether a run was re-run after a context-length refusal: once per run.
  "ALTER TABLE prq_job_usage ADD COLUMN overflow_rerun INTEGER NOT NULL DEFAULT 0 CHECK (overflow_rerun IN (0, 1))",
  // The context count's prefix: the fingerprint of the instruction prefix the measurement was taken under (NULL before
  // one was kept, and for a refusal), and whether the measurement is a context-length refusal, which counts under any
  // prefix (docs/design.md, Model context).
  "ALTER TABLE prq_session ADD COLUMN context_fingerprint TEXT",
  "ALTER TABLE prq_session ADD COLUMN context_overflow INTEGER NOT NULL DEFAULT 0 CHECK (context_overflow IN (0, 1))",
];

export const WORKSPACE_SCHEMA: SchemaSteps = [
  // seq: the newest turn sequence a call carried; released_through: the highest sequence released. Both outlive a
  // reset, so a late call of an older or a released turn is refused by a new instance too.
  `CREATE TABLE prq_workspace (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    seq INTEGER NOT NULL DEFAULT 0,
    released_through INTEGER NOT NULL DEFAULT 0)`,
  "INSERT INTO prq_workspace (id) VALUES (1)",
  // The ready record: what the last complete prepare checked out (the remote, the commit and the base, their merge
  // base) and the token it wrote into the checkout. No row while no checkout is ready.
  `CREATE TABLE prq_ready (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    remote TEXT NOT NULL,
    sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    merge_base TEXT,
    token TEXT NOT NULL)`,
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
