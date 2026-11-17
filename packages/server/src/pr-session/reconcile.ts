import type { Delivery, Head } from "./jobs.ts";

// Head reconciliation's rows (docs/design.md, Intake). Invariant: in GitHub's order (whole seconds, and within one
// second the `before` links), the head is never older than a push taken in, and an answer from GitHub's API becomes the
// head only when it is at least as new as every push taken in. Whole seconds and `before` cannot order a same-second
// tie, so a tie marks the session (reconcile_at) for one read of GitHub's head; the mark is NULL or head_at. Every
// function here is synchronous: the caller runs it in the transaction of the step it belongs to.

// How many failed reads one mark gets before it is cleared.
export const MAX_RECONCILE_TRIES = 5;

export type ReconcileState = {
  // The mark: the tied second, NULL when no read is wanted.
  mark: number | null;
  pushGen: number;
  installationId: number | null;
};

export function readReconcile(sql: SqlStorage): ReconcileState {
  const row = sql
    .exec<{ reconcile_at: number | null; push_gen: number; installation_id: number | null }>(
      "SELECT reconcile_at, push_gen, installation_id FROM prq_session WHERE id = 1",
    )
    .one();
  return { mark: row.reconcile_at, pushGen: row.push_gen, installationId: row.installation_id };
}

// A push taken in, in its transaction, after moveHead (before: the head as it was; moved: whether moveHead applied
// it). Every push advances push_gen. A later second than the head's (or the first push) clears the mark: it is newer
// than every state of the tied second. The same second, kept out or moving the head to another head through
// `before`, is a tie and marks that second. A push of the current head, or of an older second, leaves the mark.
export function notePush(sql: SqlStorage, delivery: Delivery, before: Head, moved: boolean): void {
  const { at } = delivery;
  const later = before.headAt === null || at > before.headAt;
  const tie = at === before.headAt && !(moved && delivery.details.headSha === before.headSha);
  if (later || tie) {
    sql.exec(
      "UPDATE prq_session SET push_gen = push_gen + 1, reconcile_at = ?, reconcile_tries = 0 WHERE id = 1",
      later ? null : at,
    );
  } else {
    sql.exec("UPDATE prq_session SET push_gen = push_gen + 1 WHERE id = 1");
  }
}

// Whether an answer of head_at's second shows a head that a push of that second already taken in left: the head is
// the `before` of a processed push of that second, and the second's links do not lead back to it (no return). Such an
// answer predates that push: a replica lagging within the second.
function leftInSecond(sql: SqlStorage, second: number, headSha: string): boolean {
  const links = sql
    .exec<{ before_sha: string; head_sha: string }>(
      `SELECT before_sha, head_sha FROM prq_inbox
       WHERE processed = 1 AND push = 1 AND at = ? AND before_sha IS NOT NULL`,
      second,
    )
    .toArray();
  if (!links.some((link) => link.before_sha === headSha)) {
    return false;
  }
  const seen = new Set<string>();
  const next = [headSha];
  for (let sha = next.pop(); sha !== undefined; sha = next.pop()) {
    for (const link of links) {
      if (link.before_sha === sha) {
        if (link.head_sha === headSha) {
          return false;
        }
        if (!seen.has(link.head_sha)) {
          seen.add(link.head_sha);
          next.push(link.head_sha);
        }
      }
    }
  }
  return true;
}

// An answer that is older than the head: its time is before head_at, or it is head_at's second and shows a head a
// push of that second taken in had left.
export function isLagging(sql: SqlStorage, head: Head, answer: { headSha: string; updatedAt: number }): boolean {
  if (head.headAt === null) {
    return false;
  }
  return (
    answer.updatedAt < head.headAt ||
    (answer.updatedAt === head.headAt && leftInSecond(sql, head.headAt, answer.headSha))
  );
}

// GitHub's answer becomes the head: the newest state taken in, dated by its own time, so later pushes are ordered
// against it. The mark is cleared.
export function adoptAnswer(sql: SqlStorage, answer: { headSha: string; updatedAt: number }): void {
  sql.exec(
    "UPDATE prq_session SET head_sha = ?, head_at = ?, reconcile_at = NULL, reconcile_tries = 0 WHERE id = 1",
    answer.headSha,
    answer.updatedAt,
  );
}

// A failed read of the mark (a lagging answer, or GitHub unavailable): counted, and the mark cleared at the last try.
// Returns the tries so far and whether the mark was cleared.
export function failTry(sql: SqlStorage): { tries: number; cleared: boolean } {
  const { tries } = sql
    .exec<{ tries: number }>(
      "UPDATE prq_session SET reconcile_tries = reconcile_tries + 1 WHERE id = 1 RETURNING reconcile_tries AS tries",
    )
    .one();
  if (tries < MAX_RECONCILE_TRIES) {
    return { tries, cleared: false };
  }
  clearMark(sql);
  return { tries, cleared: true };
}

export function clearMark(sql: SqlStorage): void {
  sql.exec("UPDATE prq_session SET reconcile_at = NULL, reconcile_tries = 0 WHERE id = 1");
}
