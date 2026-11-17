import * as v from "valibot";

import type { CutPosition } from "./compaction.ts";

// The analysis notes (prq_notes) and the context count (prq_session), as compaction reads and writes them
// (docs/design.md, Model context).

// The notes the model reads in place of the projection before the cut; none until a compaction is adopted. rev counts
// the adopted compactions.
export type Notes =
  | { text: string; rev: number; cut: CutPosition; readFiles: string[] }
  | { text: null; rev: number; cut: null; readFiles: string[] };

type NotesRow = {
  text: string | null;
  rev: number;
  cut_message_id: string | null;
  cut_step: number | null;
  read_files: string;
};

const ReadFiles = v.array(v.string());

export function readNotes(sql: SqlStorage): Notes {
  const row = sql
    .exec<NotesRow>("SELECT text, rev, cut_message_id, cut_step, read_files FROM prq_notes WHERE id = 1")
    .one();
  const readFiles = v.parse(ReadFiles, JSON.parse(row.read_files));
  if (row.text === null || row.cut_message_id === null || row.cut_step === null) {
    return { text: null, rev: row.rev, cut: null, readFiles };
  }
  return { text: row.text, rev: row.rev, cut: { messageId: row.cut_message_id, step: row.cut_step }, readFiles };
}

// New notes, adopted only while no other compaction has been adopted since they were built from the notes at `rev`;
// an adoption also ends the failed compaction's mark. Returns the new revision, or null when not adopted.
export function adoptNotes(
  sql: SqlStorage,
  notes: { text: string; cut: CutPosition; readFiles: readonly string[]; targetSha: string | null },
  rev: number,
  now: number,
): number | null {
  const adopted = sql
    .exec<{ rev: number }>(
      `UPDATE prq_notes SET text = ?, rev = rev + 1, cut_message_id = ?, cut_step = ?, target_sha = ?, read_files = ?,
         updated_at = ?
       WHERE id = 1 AND rev = ? RETURNING rev`,
      notes.text,
      notes.cut.messageId,
      notes.cut.step,
      notes.targetSha,
      JSON.stringify(notes.readFiles),
      now,
      rev,
    )
    .toArray()[0];
  if (adopted === undefined) {
    return null;
  }
  sql.exec("UPDATE prq_session SET compaction_failed_through = NULL WHERE id = 1");
  return adopted.rev;
}

// The context count's measurement: the tokens of the last committed turn's last model call (input and output), the
// result it ended with, and the notes revision its context was built on; and the projection's end at which a
// compaction last failed.
export type ContextState = {
  tokens: number | null;
  through: string | null;
  notesRev: number | null;
  failedThrough: string | null;
};

export function readContextState(sql: SqlStorage): ContextState {
  const row = sql
    .exec<{
      context_tokens: number | null;
      context_through: string | null;
      context_notes_rev: number | null;
      compaction_failed_through: string | null;
    }>(
      `SELECT context_tokens, context_through, context_notes_rev, compaction_failed_through FROM prq_session
       WHERE id = 1`,
    )
    .one();
  return {
    tokens: row.context_tokens,
    through: row.context_through,
    notesRev: row.context_notes_rev,
    failedThrough: row.compaction_failed_through,
  };
}

// A committed turn's measurement (tokens null when the provider reported no usage, so the context is estimated).
export function recordContext(
  sql: SqlStorage,
  measure: { tokens: number | null; through: string; notesRev: number },
): void {
  sql.exec(
    "UPDATE prq_session SET context_tokens = ?, context_through = ?, context_notes_rev = ? WHERE id = 1",
    measure.tokens,
    measure.through,
    measure.notesRev,
  );
}

// A context-length refusal: the provider measured the context as over its window. It counts as the whole window, and
// it asks for a compaction even where one failed at the same projection end.
export function recordOverflow(
  sql: SqlStorage,
  measure: { tokens: number; through: string | null; notesRev: number },
): void {
  sql.exec(
    `UPDATE prq_session SET context_tokens = ?, context_through = ?, context_notes_rev = ?,
       compaction_failed_through = NULL
     WHERE id = 1`,
    measure.tokens,
    measure.through,
    measure.notesRev,
  );
}

// A compaction that failed: not tried again at a turn's start until the projection has grown past `through`.
export function markCompactionFailed(sql: SqlStorage, through: string | null): void {
  sql.exec("UPDATE prq_session SET compaction_failed_through = ? WHERE id = 1", through);
}
