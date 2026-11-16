import { MessageType } from "@cloudflare/ai-chat/types";
import type { WSMessage } from "agents";
import type { UIMessage } from "ai";

// The stored conversation is append-only: whatever a client sends, a stored message keeps its content and place and
// none is removed (docs/design.md, Intake).

// Client frames that write history outside persistMessages: clear empties it, messages upserts the client's versions
// of known messages, tool-result and tool-approval update stored messages. prq has no client-side tools.
const REFUSED_FRAMES = new Set<string>([
  MessageType.CF_AGENT_CHAT_CLEAR,
  MessageType.CF_AGENT_CHAT_MESSAGES,
  MessageType.CF_AGENT_TOOL_RESULT,
  MessageType.CF_AGENT_TOOL_APPROVAL,
]);

// The frame's type when the SDK would act on it as one of REFUSED_FRAMES, parsed as the SDK parses it.
export function refusedFrame(message: WSMessage): string | null {
  if (typeof message !== "string") {
    return null;
  }
  let frame: unknown;
  try {
    frame = JSON.parse(message);
  } catch {
    return null;
  }
  const type: unknown = typeof frame === "object" && frame !== null ? Reflect.get(frame, "type") : undefined;
  return typeof type === "string" && REFUSED_FRAMES.has(type) ? type : null;
}

// The messages a write may add: those whose ID is not stored, each ID once, in the order given.
export async function addedMessages(
  messages: readonly UIMessage[],
  isStored: (id: string) => Promise<boolean>,
): Promise<UIMessage[]> {
  const seen = new Set<string>();
  const added: UIMessage[] = [];
  for (const message of messages) {
    if (!seen.has(message.id) && !(await isStored(message.id))) {
      added.push(message);
    }
    seen.add(message.id);
  }
  return added;
}

// How long a history write waits for the writes queued before it.
const WRITE_WAIT_MS = 30_000;

export class WriteWaitTimeout extends Error {
  override readonly name = "WriteWaitTimeout";
}

// One history write at a time, each starting from the history the previous one left. A write that waits longer than
// waitMs for the earlier ones fails without writing; later writes still wait for the earlier ones, so two writes never
// run together.
export class WriteQueue {
  readonly #waitMs: number;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(waitMs = WRITE_WAIT_MS) {
    this.#waitMs = waitMs;
  }

  run<T>(write: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    const result = waitFor(previous, this.#waitMs).then(write);
    this.#tail = Promise.allSettled([previous, result]);
    return result;
  }
}

async function waitFor(previous: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WriteWaitTimeout(`a history write waited over ${ms} ms`)), ms);
  });
  try {
    await Promise.race([previous, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
