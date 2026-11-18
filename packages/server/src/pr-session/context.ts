import {
  type ContextResponse,
  MAX_FULL_NAME_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
  type PrDetails,
} from "@prq/protocol";

// The conversation as /cli/context pages it (docs/design.md, Owner and jobs).

// The most a context response takes, as UTF-8 JSON: its messages and everything around them (the pull request, its
// details, the job and the cursor; a part's place is counted with its message). A response crosses a Durable Object RPC
// call, whose limit is 32 MiB of V8-serialized data. V8 keeps a string that has any character beyond Latin-1 at two
// bytes per code unit, so a response serializes to at most about twice its UTF-8 JSON size; 8 MiB leaves that factor
// and the serialization's own overhead well inside the limit, and keeps a page a moderate read for the session and the
// agent (a 35 MB conversation is five pages).
export const CONTEXT_PAGE_BYTES = 8 * 1024 * 1024;

// The details at their largest: each field at its length cap, each code unit at the most JSON spends on one (a
// six-byte `\u00XX` escape). A page keeps room for them, since a webhook taken in while the page is read can change
// the details the response carries.
const LARGEST_DETAILS: PrDetails = {
  fullName: "\u0001".repeat(MAX_FULL_NAME_CHARS),
  title: "\u0001".repeat(MAX_TITLE_CHARS),
  state: "merged",
  url: "\u0001".repeat(MAX_URL_CHARS),
  headSha: "0".repeat(40),
  baseSha: "0".repeat(40),
};

export type ContextMessage = ContextResponse["messages"][number];

// Where a page starts: a message, by ID, and an offset in its text. The conversation is append-only, so a message's
// place and text never change and the cursor stays valid while messages are added.
export type Cursor = { id: string; offset: number };

// A cursor as the agent holds it: `<offset>:<message ID>`. Opaque to the agent.
export function cursorText({ id, offset }: Cursor): string {
  return `${offset}:${id}`;
}

export function parseCursor(text: string): Cursor | null {
  const match = /^(0|[1-9][0-9]{0,14}):(.+)$/s.exec(text);
  return match === null ? null : { id: match[2] ?? "", offset: Number(match[1]) };
}

const encoder = new TextEncoder();

export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

// What a page leaves for its messages: the budget less the rest of the response, with the details at their largest and
// a cursor naming the conversation's longest message ID at the largest offset. The pull request, the job and the first
// page's instructions are the response's own: while the claim holds, the job does not change, and the instructions are
// read once, before the page.
export function messageRoom(
  around: Pick<ContextResponse, "pr" | "job" | "instructions">,
  ids: readonly string[],
): number {
  let longest = { id: "", bytes: 0 };
  for (const id of ids) {
    const bytes = jsonBytes(id);
    if (bytes > longest.bytes) {
      longest = { id, bytes };
    }
  }
  const nextCursor = cursorText({ id: longest.id, offset: Number.MAX_SAFE_INTEGER });
  return CONTEXT_PAGE_BYTES - jsonBytes({ ...around, details: LARGEST_DETAILS, messages: [], nextCursor });
}

// What a page takes of a message from offset on: all of it when it fits in `left` bytes, else null, or, for a message
// that does not fit in a page of its own (`alone`), the longest part that fits, never splitting a surrogate pair; null
// when not even its first character fits. A message read from an offset past its start, or cut short, carries its
// part.
export function take(message: ContextMessage, offset: number, left: number, alone: boolean): ContextMessage | null {
  const { text } = message;
  const piece = (end: number): ContextMessage =>
    offset === 0 && end === text.length
      ? message
      : { ...message, text: text.slice(offset, end), part: { offset, length: text.length } };
  const rest = piece(text.length);
  let size = jsonBytes(rest);
  if (size <= left) {
    return rest;
  }
  if (!alone) {
    return null;
  }
  // The shortest part: one character, both halves of a surrogate pair.
  const least = offset + (isHighSurrogate(text.charCodeAt(offset)) && offset + 1 < text.length ? 2 : 1);
  let end = text.length;
  for (;;) {
    const units = end - offset;
    end = Math.max(least, offset + Math.floor((units * left) / size) - 1);
    if (end > least && isHighSurrogate(text.charCodeAt(end - 1))) {
      end -= 1;
    }
    const cut = piece(end);
    size = jsonBytes(cut);
    if (size <= left) {
      return cut;
    }
    if (end === least) {
      return null;
    }
  }
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}
