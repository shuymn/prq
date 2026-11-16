import type { JobTarget, JobView, Owner } from "@prq/protocol";

// A session's jobs and the rows that go with them. Every transition is one SQL statement guarded by the state it
// expects (and the claim), so no state is read in one step and changed in another (docs/design.md, Owner and jobs).
// All of it is synchronous: a caller that writes several rows does so in one storage transaction.

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

export function jobById(sql: SqlStorage, jobId: string): JobRow | undefined {
  return sql.exec<JobRow>("SELECT * FROM prq_jobs WHERE job_id = ?", jobId).toArray()[0];
}

export function allJobs(sql: SqlStorage): JobRow[] {
  return sql.exec<JobRow>("SELECT * FROM prq_jobs ORDER BY seq").toArray();
}

export function hasAnswerJob(sql: SqlStorage, questionId: string): boolean {
  return (
    sql.exec("SELECT 1 FROM prq_jobs WHERE kind = 'answer' AND target = ? LIMIT 1", questionId).toArray().length > 0
  );
}

// A pending answer job per question that has none, in the given order.
export function createAnswerJobs(sql: SqlStorage, questionIds: readonly string[], now: number): JobRow[] {
  return questionIds.flatMap((id) =>
    sql
      .exec<JobRow>(
        `INSERT INTO prq_jobs (job_id, kind, target, state, created_at, updated_at)
         VALUES (?, 'answer', ?, 'pending', ?, ?) ON CONFLICT (kind, target) DO NOTHING RETURNING *`,
        crypto.randomUUID(),
        id,
        now,
        now,
      )
      .toArray(),
  );
}

// The next job, one rule for both owners: the oldest pending answer, then the pending analysis.
const NEXT_PENDING = `SELECT job_id FROM prq_jobs WHERE state = 'pending'
  ORDER BY CASE kind WHEN 'answer' THEN 0 ELSE 1 END, seq LIMIT 1`;

// The commit a claimed job is worked at: an analysis's head; for an answer, the head of the latest completed analysis.
const WORKSPACE_SHA = `CASE kind WHEN 'analysis' THEN target ELSE (
  SELECT done.target FROM prq_jobs AS done WHERE done.kind = 'analysis' AND done.state = 'done'
  ORDER BY done.updated_at DESC, done.seq DESC LIMIT 1) END`;

// The agent's own claimed job, under a new claim (a resume is a claim: the time and the workspace are set again).
export function resumeClaim(sql: SqlStorage, agentId: string, claimId: string, now: number): JobRow | undefined {
  return sql
    .exec<JobRow>(
      `UPDATE prq_jobs SET claim_id = ?, claimed_at = ?, updated_at = ?, workspace_sha = ${WORKSPACE_SHA}
       WHERE state = 'claimed' AND job_id = (
         SELECT job_id FROM prq_jobs WHERE state = 'claimed' AND agent_id = ? ORDER BY seq LIMIT 1)
       RETURNING *`,
      claimId,
      now,
      now,
      agentId,
    )
    .toArray()[0];
}

// The next pending job, claimed by the agent. Selection and update are one statement.
export function freshClaim(sql: SqlStorage, agentId: string, claimId: string, now: number): JobRow | undefined {
  return sql
    .exec<JobRow>(
      `UPDATE prq_jobs SET state = 'claimed', agent_id = ?, claim_id = ?, claimed_at = ?, updated_at = ?,
         workspace_sha = ${WORKSPACE_SHA}
       WHERE state = 'pending' AND job_id = (${NEXT_PENDING})
       RETURNING *`,
      agentId,
      claimId,
      now,
      now,
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

// claimed → finalizing: the point at which a submit wins. Only the job's current claim, by the agent that holds it.
export function reserve(
  sql: SqlStorage,
  jobId: string,
  claimId: string,
  agentId: string,
  now: number,
): JobRow | undefined {
  return sql
    .exec<JobRow>(
      `UPDATE prq_jobs SET state = 'finalizing', updated_at = ?
       WHERE job_id = ? AND state = 'claimed' AND claim_id = ? AND agent_id = ? RETURNING *`,
      now,
      jobId,
      claimId,
      agentId,
    )
    .toArray()[0];
}

// finalizing → done, once the result message exists, or back to claimed (same claim) when it does not.
export function endFinalizing(sql: SqlStorage, row: JobRow, stored: boolean, now: number): JobRow | undefined {
  const done = `UPDATE prq_jobs SET state = 'done', done_claim_id = claim_id, result_message_id = ?, updated_at = ?
    WHERE job_id = ? AND state = 'finalizing' AND claim_id = ? RETURNING *`;
  const claimed = `UPDATE prq_jobs SET state = 'claimed', updated_at = ?
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

// claimed or failed → pending, with the claim cleared, so the earlier claimId no longer matches.
export function retry(sql: SqlStorage, jobId: string, now: number): JobRow | undefined {
  return sql
    .exec<JobRow>(
      `UPDATE prq_jobs SET state = 'pending', agent_id = NULL, claim_id = NULL, claimed_at = NULL,
         workspace_sha = NULL, failure = NULL, updated_at = ?
       WHERE job_id = ? AND state IN ('claimed', 'failed') RETURNING *`,
      now,
      jobId,
    )
    .toArray()[0];
}

// Every pending job → failed, with the reason.
export function failPending(sql: SqlStorage, failure: string, now: number): JobRow[] {
  return sql
    .exec<JobRow>(
      "UPDATE prq_jobs SET state = 'failed', failure = ?, updated_at = ? WHERE state = 'pending' RETURNING *",
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
      `UPDATE prq_jobs SET state = 'running', updated_at = ?
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
  };
}
