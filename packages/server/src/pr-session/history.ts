import { MessageType } from "@cloudflare/ai-chat/types";
import type { WSMessage } from "agents";
import type { UIMessage } from "ai";
import * as v from "valibot";

// The stored conversation is append-only: whatever a client sends, a stored message keeps its content and place and
// none is removed (docs/design.md, Intake).

// Client frames that write history other than through a chat request. clear empties it and tool-result and
// tool-approval update stored messages, all around persistMessages; messages passes the client's list to
// persistMessages, which keeps only new IDs, but a prq client adds questions through chat requests only. prq has no
// client-side tools.
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
  const type = frameType(parseJson(message));
  return typeof type === "string" && REFUSED_FRAMES.has(type) ? type : null;
}

const ChatRequest = v.looseObject({
  type: v.literal(MessageType.CF_AGENT_USE_CHAT_REQUEST),
  init: v.looseObject({ body: v.string() }),
});

// The messages of a chat request, each in the current UIMessage form (the SDK would also convert older forms).
const ChatRequestBody = v.looseObject({
  messages: v.array(
    v.looseObject({ id: v.pipe(v.string(), v.nonEmpty()), role: v.string(), parts: v.array(v.unknown()) }),
  ),
});

// A client's chat request with the messages a client may not add taken out: a client adds questions (role user) only,
// so another message passes only when its ID is stored, as an echo of the history the client loaded. Returns the frame
// to hand on and how many messages were taken out, or, for a chat request not in that shape, that it is refused whole
// (with its ID, when it has one, to answer); any other frame passes unchanged.
export function questionsOnly(
  message: WSMessage,
  isStored: (id: string) => boolean,
): { message: WSMessage; removed: number } | { refusedId: string | null } {
  const parsed = typeof message === "string" ? parseJson(message) : undefined;
  if (frameType(parsed) !== MessageType.CF_AGENT_USE_CHAT_REQUEST) {
    return { message, removed: 0 };
  }
  const frame = v.safeParse(ChatRequest, parsed);
  const body = frame.success ? v.safeParse(ChatRequestBody, parseJson(frame.output.init.body)) : undefined;
  if (!frame.success || body?.success !== true) {
    const id: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "id") : undefined;
    return { refusedId: typeof id === "string" ? id : null };
  }
  const messages = body.output.messages.filter((item) => item.role === "user" || isStored(item.id));
  const removed = body.output.messages.length - messages.length;
  if (removed === 0) {
    return { message, removed };
  }
  const init = { ...frame.output.init, body: JSON.stringify({ ...body.output, messages }) };
  return { message: JSON.stringify({ ...frame.output, init }), removed };
}

export const CHAT_REQUEST_REFUSED = "Chat request refused: every message must be a UIMessage with an ID and parts.";

// The answer to a refused chat request. The SDK client ends a request on a response for its ID that is done and marked
// as an error, failing it with the body as the message; without one, its send would wait until the socket closes.
export function refusedChatResponse(id: string): string {
  return JSON.stringify({
    type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
    id,
    body: CHAT_REQUEST_REFUSED,
    done: true,
    error: true,
  });
}

// Whether an outgoing message is a chat list (cf_agent_chat_messages).
export function isChatList(message: string | ArrayBuffer | ArrayBufferView): boolean {
  return (
    typeof message === "string" &&
    message.includes(MessageType.CF_AGENT_CHAT_MESSAGES) &&
    frameType(parseJson(message)) === MessageType.CF_AGENT_CHAT_MESSAGES
  );
}

function frameType(frame: unknown): unknown {
  return typeof frame === "object" && frame !== null ? Reflect.get(frame, "type") : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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
