import type { JobTarget, JobView, Owner, PrDetails } from "@prq/protocol";

// A session's jobs and the rows that go with them. Every transition is one SQL statement guarded by the state it
// expects (and the claim), so no state is read in one step and changed in another (docs/design.md, Owner and jobs). The
// same statement advances the job's revision (rev), which a retry is bound to. All of it is synchronous: a caller that
// writes several rows does so in one storage transaction.

export type JobState = "pending" | "claimed" | "finalizing" | "running" | "done" | "failed" | "superseded";

export type JobRow = {
  seq: number;
  job_id: string;
  kind: JobTarget["kind"];
  target: string;
  state: JobState;
  agent_id: string | null;
  claim_id: string | null;
  claimed_at: number | null;
  workspace_sha: string | null;
  done_claim_id: string | null;
  result_message_id: string | null;
  failure: string | null;
  created_at: number;
  updated_at: number;
  rev: number;
  run: number;
};

export function jobTarget(row: JobRow): JobTarget {
  return row.kind === "answer" ? { kind: "answer", messageId: row.target } : { kind: "analysis", headSha: row.target };
}

// The ID of the message a job's result is stored as.
export function resultMessageId(row: JobRow): string {
  return `${row.kind}-${row.job_id}`;
}

export function readOwner(sql: SqlStorage): Owner | null {
  return sql.exec<{ owner: Owner | null }>("SELECT owner FROM prq_session WHERE id = 1").one().owner;
}

// Sets the owner unless one is set; the first decision wins. Returns whether this call set it.
export function decideOwner(sql: SqlStorage, owner: Owner): boolean {
  return (
    sql.exec("UPDATE prq_session SET owner = ? WHERE id = 1 AND owner IS NULL RETURNING owner", owner).toArray()
      .length === 1
  );
}

type DetailsRow = {
  head_sha: string | null;
  base_sha: string | null;
  full_name: string | null;
  title: string | null;
  pr_state: PrDetails["state"] | null;
  url: string | null;
};

// The pull request's details, once a webhook has given them.
export function readDetails(sql: SqlStorage): PrDetails | null {
  const row = sql
    .exec<DetailsRow>("SELECT head_sha, base_sha, full_name, title, pr_state, url FROM prq_session WHERE id = 1")
    .one();
  const { head_sha: headSha, base_sha: baseSha, full_name: fullName, title, pr_state: state, url } = row;
  if (headSha === null || baseSha === null || fullName === null || title === null || state === null || url === null) {
    return null;
  }
  return { fullName, title, state, url, headSha, baseSha };
}

// Stores a webhook's details. A push moves the head; any other webhook sets it only when no head is known yet.
export function writeDetails(sql: SqlStorage, details: PrDetails, push: boolean): void {
  const head = push ? "?" : "coalesce(head_sha, ?)";
  sql.exec(
    `UPDATE prq_session SET head_sha = ${head}, base_sha = ?, full_name = ?, title = ?, pr_state = ?, url = ? WHERE id = 1`,
    details.headSha,
    details.baseSha,
    details.fullName,
    details.title,
    details.state,
    details.url,
  );
}

export function jobById(sql: SqlStorage, jobId: string): JobRow | undefined {
  return sql.exec<JobRow>("SELECT * FROM prq_jobs WHERE job_id = ?", jobId).toArray()[0];
}

export function allJobs(sql: SqlStorage): JobRow[] {
  return sql.exec<JobRow>("SELECT * FROM prq_jobs ORDER BY seq").toArray();
}

// Intake rows: the write that stores questions writes their rows first, so a stored question has its job or its row.
export function addIntake(sql: SqlStorage, questionIds: readonly string[]): void {
  for (const id of questionIds) {
    sql.exec("INSERT INTO prq_intake (question_id) VALUES (?) ON CONFLICT (question_id) DO NOTHING", id);
  }
}

// The questions with an intake row, in the order they were written.
export function intakeIds(sql: SqlStorage): string[] {
  return sql
    .exec<{ question_id: string }>("SELECT question_id FROM prq_intake ORDER BY seq")
    .toArray()
    .map((row) => row.question_id);
}

export function removeIntake(sql: SqlStorage, questionIds: readonly string[]): void {
  for (const id of questionIds) {
    sql.exec("DELETE FROM prq_intake WHERE question_id = ?", id);
  }
}

// A pending job for the target, unless it has one: one job per target.
function createJob(sql: SqlStorage, kind: JobRow["kind"], target: string, now: number): JobRow | undefined {
  return sql
    .exec<JobRow>(
      `INSERT INTO prq_jobs (job_id, kind, target, state, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT (kind, target) DO NOTHING RETURNING *`,
      crypto.randomUUID(),
      kind,
      target,
      now,
      now,
    )
    .toArray()[0];
}

// A pending answer job per question that has none, in the given order.
export function createAnswerJobs(sql: SqlStorage, questionIds: readonly string[], now: number): JobRow[] {
  return questionIds.flatMap((id) => createJob(sql, "answer", id, now) ?? []);
}

// The analysis of a pushed head: created when the head has no job, revived when its job was superseded, otherwise
// left as it is (a known head gets no second job). Every other head's pending analysis is superseded first, so at most
// one analysis waits: the current head's. Returns the folded jobs and the job made pending, if any.
export function ingestHeadJobs(
  sql: SqlStorage,
  headSha: string,
  now: number,
): { folded: JobRow[]; created: JobRow | undefined; revived: JobRow | undefined } {
  const folded = sql
    .exec<JobRow>(
      `UPDATE prq_jobs SET rev = rev + 1, state = 'superseded', updated_at = ?
       WHERE kind = 'analysis' AND state = 'pending' AND target != ? RETURNING *`,
      now,
      headSha,
    )
    .toArray()
    .toSorted((a, b) => a.seq - b.seq);
  const created = createJob(sql, "analysis", headSha, now);
  // A revival starts a new run: whatever the job was folded from, no answer produced before it is accepted.
  const revived = sql
    .exec<JobRow>(
      `UPDATE prq_jobs SET rev = rev + 1, run = run + 1, state = 'pending', updated_at = ?
       WHERE kind = 'analysis' AND target = ? AND state = 'superseded' RETURNING *`,
      now,
      headSha,
    )
    .toArray()[0];
  return { folded, created, revived };
}

// The next job, one rule for both owners: the oldest pending answer, then the pending analysis.
const NEXT_PENDING = `SELECT job_id FROM prq_jobs WHERE state = 'pending'
  ORDER BY CASE kind WHEN 'answer' THEN 0 ELSE 1 END, seq LIMIT 1`;

// The commit a claimed job is worked at: an analysis's head; for an answer, the head of the latest completed analysis,
// else the current head (NULL before any push).
const WORKSPACE_SHA = `CASE kind WHEN 'analysis' THEN target ELSE coalesce((
  SELECT done.target FROM prq_jobs AS done WHERE done.kind = 'analysis' AND done.state = 'done'
  ORDER BY done.updated_at DESC, done.seq DESC LIMIT 1), (SELECT head_sha FROM prq_session WHERE id = 1)) END`;

// A claim is one attempt of the Hub's, numbered from its counter. A session takes a claim only from an attempt newer
// than every attempt the agent has claimed under there (prq_claim_attempts), so a claim that lands late (its caller
// stopped waiting for it) changes nothing once a newer attempt of the agent has claimed, whatever happened to that
// job since. Bound to the agent ID, then the attempt.
const NEWER_ATTEMPT_CLAIMED = "EXISTS (SELECT 1 FROM prq_claim_attempts WHERE agent_id = ? AND attempt >= ?)";

// Records that the agent's attempt claimed a job here; written in the claim's transaction.
export function recordAttempt(sql: SqlStorage, agentId: string, attempt: number): void {
  sql.exec(
    `INSERT INTO prq_claim_attempts (agent_id, attempt) VALUES (?, ?)
     ON CONFLICT (agent_id) DO UPDATE SET attempt = max(attempt, excluded.attempt)`,
    agentId,
    attempt,
  );
}

// The agent's own claimed job, under a new claim (a resume is a claim: the time and the workspace are set again).
export function resumeClaim(
  sql: SqlStorage,
  agentId: string,
  claimId: string,
  attempt: number,
  now: number,
): JobRow | undefined {
  return sql
    .exec<JobRow>(
      `UPDATE prq_jobs SET rev = rev + 1, claim_id = ?, claimed_at = ?, updated_at = ?,
         workspace_sha = ${WORKSPACE_SHA}
       WHERE state = 'claimed' AND job_id = (
         SELECT job_id FROM prq_jobs WHERE state = 'claimed' AND agent_id = ? ORDER BY seq LIMIT 1)
         AND NOT ${NEWER_ATTEMPT_CLAIMED}
       RETURNING *`,
      claimId,
      now,
      now,
      agentId,
      agentId,
      attempt,
    )
    .toArray()[0];
}

// The next pending job, claimed by the agent. Selection and update are one statement.
export function freshClaim(
  sql: SqlStorage,
  agentId: string,
  claimId: string,
  attempt: number,
  now: number,
): JobRow | undefined {
  return sql
    .exec<JobRow>(
      `UPDATE prq_jobs SET rev = rev + 1, state = 'claimed', agent_id = ?, claim_id = ?, claimed_at = ?, updated_at = ?,
         workspace_sha = ${WORKSPACE_SHA}
       WHERE state = 'pending' AND job_id = (${NEXT_PENDING}) AND NOT ${NEWER_ATTEMPT_CLAIMED}
       RETURNING *`,
      agentId,
      claimId,
      now,
      now,
      agentId,
      attempt,
    )
    .toArray()[0];
}

// What the Hub needs from a session: whether the agent has its own claimed job here, whether a pending job is waiting,
// and whether any job is still open (pending, claimed or being finalized).
export type Peek = { resume: boolean; fresh: boolean; open: boolean };

export function peekJobs(sql: SqlStorage, agentId: string): Peek {
  const open = sql
    .exec<{ state: JobState; agent_id: string | null }>(
      "SELECT state, agent_id FROM prq_jobs WHERE state IN ('pending', 'claimed', 'finalizing')",
    )
    .toArray();
  return {
    resume: open.some((row) => row.state === "claimed" && row.agent_id === agentId),
    fresh: open.some((row) => row.state === "pending"),
    open: open.length > 0,
  };
}

// claimed → finalizing: the point at which a submit wins. Only the job's current claim, by the agent that holds it, with
// an answer produced under the job's current run (no retry since).
export function reserve(
  sql: SqlStorage,
  jobId: string,
  claimId: string,
  agentId: string,
  run: number,
  now: number,
): JobRow | undefined {
  return sql
    .exec<JobRow>(
      `UPDATE prq_jobs SET rev = rev + 1, state = 'finalizing', updated_at = ?
       WHERE job_id = ? AND state = 'claimed' AND claim_id = ? AND agent_id = ? AND run = ? RETURNING *`,
      now,
      jobId,
      claimId,
      agentId,
      run,
    )
    .toArray()[0];
}

// finalizing → done, once the result message exists, or back to claimed (same claim) when it does not.
export function endFinalizing(sql: SqlStorage, row: JobRow, stored: boolean, now: number): JobRow | undefined {
  const done = `UPDATE prq_jobs SET rev = rev + 1, state = 'done', done_claim_id = claim_id, result_message_id = ?,
    updated_at = ? WHERE job_id = ? AND state = 'finalizing' AND claim_id = ? RETURNING *`;
  const claimed = `UPDATE prq_jobs SET rev = rev + 1, state = 'claimed', updated_at = ?
    WHERE job_id = ? AND state = 'finalizing' AND claim_id = ? RETURNING *`;
  return (
    stored
      ? sql.exec<JobRow>(done, resultMessageId(row), now, row.job_id, row.claim_id)
      : sql.exec<JobRow>(claimed, now, row.job_id, row.claim_id)
  ).toArray()[0];
}

export function finalizingJobs(sql: SqlStorage): JobRow[] {
  return sql.exec<JobRow>("SELECT * FROM prq_jobs WHERE state = 'finalizing' ORDER BY seq").toArray();
}

// Whether a job is the analysis of a head that is not the current one, read in the statement that uses it.
const OLD_HEAD = "kind = 'analysis' AND target IS NOT (SELECT head_sha FROM prq_session WHERE id = 1)";

// claimed or failed → pending, with the claim cleared, so the earlier claimId no longer matches, and the next run, so no
// answer produced before the retry is accepted. The analysis of a head that is no longer current is superseded instead,
// its claim cleared the same way: only the current head's analysis waits, and a revival starts the next run. Only
// while the job is still at expectedRev, the revision the retry was made from.
export function retry(sql: SqlStorage, jobId: string, expectedRev: number, now: number): JobRow | undefined {
  return sql
    .exec<JobRow>(
      `UPDATE prq_jobs SET rev = rev + 1,
         state = CASE WHEN ${OLD_HEAD} THEN 'superseded' ELSE 'pending' END,
         run = CASE WHEN ${OLD_HEAD} THEN run ELSE run + 1 END,
         agent_id = NULL, claim_id = NULL, claimed_at = NULL, workspace_sha = NULL, failure = NULL, updated_at = ?
       WHERE job_id = ? AND rev = ? AND state IN ('claimed', 'failed') RETURNING *`,
      now,
      jobId,
      expectedRev,
    )
    .toArray()[0];
}

// Every pending job → failed, with the reason.
export function failPending(sql: SqlStorage, failure: string, now: number): JobRow[] {
  return sql
    .exec<JobRow>(
      "UPDATE prq_jobs SET rev = rev + 1, state = 'failed', failure = ?, updated_at = ? WHERE state = 'pending' RETURNING *",
      failure,
      now,
    )
    .toArray()
    .toSorted((a, b) => a.seq - b.seq);
}

// The next pending job → running, unless a job is running.
export function startNext(sql: SqlStorage, now: number): JobRow | undefined {
  return sql
    .exec<JobRow>(
      `UPDATE prq_jobs SET rev = rev + 1, state = 'running', updated_at = ?
       WHERE state = 'pending' AND job_id = (${NEXT_PENDING})
         AND NOT EXISTS (SELECT 1 FROM prq_jobs WHERE state = 'running')
       RETURNING *`,
      now,
    )
    .toArray()[0];
}

// The outbox row for a notify, written with the next value of the session's counter: a row deleted and written again
// always has a larger generation than any delivery of the old one read.
export function writeNotify(sql: SqlStorage): void {
  const { gen } = sql.exec<{ gen: number }>("UPDATE prq_session SET gen = gen + 1 WHERE id = 1 RETURNING gen").one();
  sql.exec(
    "INSERT INTO prq_outbox (kind, gen) VALUES ('notify', ?) ON CONFLICT (kind) DO UPDATE SET gen = excluded.gen",
    gen,
  );
}

export type OutboxRow = { kind: "notify"; gen: number };

export function outboxRow(sql: SqlStorage): OutboxRow | undefined {
  return sql.exec<OutboxRow>("SELECT kind, gen FROM prq_outbox WHERE kind = 'notify'").toArray()[0];
}

// Deletes the row a delivery read, unless it was written again since. Returns whether it deleted it.
export function deleteOutbox(sql: SqlStorage, row: OutboxRow): boolean {
  return (
    sql.exec("DELETE FROM prq_outbox WHERE kind = ? AND gen = ? RETURNING kind", row.kind, row.gen).toArray().length ===
    1
  );
}

export function jobView(row: JobRow): JobView {
  const held = row.state === "claimed" || row.state === "finalizing";
  return {
    jobId: row.job_id,
    target: jobTarget(row),
    state: row.state === "finalizing" ? "running" : row.state,
    agentId: row.agent_id,
    since: held ? row.claimed_at : null,
    failure: row.failure,
    resultMessageId: row.result_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rev: row.rev,
  };
}
