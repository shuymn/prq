import type { Prompt, PromptKind, Prompts } from "@prq/protocol";

// The host's prompts as the Hub stores them (prq_prompts): one row per kind once saved.

type PromptRow = { kind: PromptKind; text: string; saved_at: number };

const NEVER_SAVED: Prompt = { text: "", savedAt: null };

export function readPrompts(sql: SqlStorage): Prompts {
  const prompts: Prompts = { analysis: NEVER_SAVED, answer: NEVER_SAVED };
  for (const row of sql.exec<PromptRow>("SELECT kind, text, saved_at FROM prq_prompts")) {
    prompts[row.kind] = { text: row.text, savedAt: row.saved_at };
  }
  return prompts;
}

// Replaces a kind's prompt; the last save wins (there is one host).
export function writePrompt(sql: SqlStorage, kind: PromptKind, text: string, now: number): Prompt {
  sql.exec(
    `INSERT INTO prq_prompts (kind, text, saved_at) VALUES (?, ?, ?)
     ON CONFLICT (kind) DO UPDATE SET text = excluded.text, saved_at = excluded.saved_at`,
    kind,
    text,
    now,
  );
  return { text, savedAt: now };
}
