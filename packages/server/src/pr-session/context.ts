import type { ContextResponse } from "@prq/protocol";

// The conversation as /cli/context pages it (docs/design.md, Owner and jobs).

// The most the messages of one context page take, as UTF-8 JSON. A page crosses a Durable Object RPC call, whose limit
// is 32 MiB of V8-serialized data. V8 keeps a string that has any character beyond Latin-1 at two bytes per code unit,
// so a page serializes to at most about twice its UTF-8 JSON size; 8 MiB leaves that factor, the rest of the response
// and the serialization's own overhead well inside the limit, and keeps a page a moderate read for the session and
// the agent (a 35 MB conversation is five pages).
export const CONTEXT_PAGE_BYTES = 8 * 1024 * 1024;

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

// What a page takes of a message from offset on: all of it when it fits in `left` bytes, else null, or, for a message
// that does not fit in a page of its own (`alone`), the longest part that fits, never splitting a surrogate pair and
// at least one code unit long. A message read from an offset past its start, or cut short, carries its part.
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
  let end = text.length;
  for (;;) {
    const units = end - offset;
    end = offset + Math.max(1, Math.floor((units * left) / size) - 1);
    if (end > offset + 1 && isHighSurrogate(text.charCodeAt(end - 1))) {
      end -= 1;
    }
    const cut = piece(end);
    size = jsonBytes(cut);
    if (size <= left || end === offset + 1) {
      return cut;
    }
  }
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}
