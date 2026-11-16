// A client for the Agents routes as a browser uses them: WebSocket frames of the AIChatAgent protocol and the
// get-messages endpoint, through the Worker entry with a valid Access token.

import type { UIMessage } from "ai";
import { env, exports } from "cloudflare:workers";

import { accessToken, request, runKey, serveKeys } from "./access.ts";

const WAIT_MS = 2000;

type Frame = Record<string, unknown>;

// A token for the configured team, with its key set served (the fetch spy stays until the test restores mocks).
export async function hostToken(): Promise<string> {
  const key = await runKey();
  serveKeys(env.ACCESS_TEAM_DOMAIN, key);
  return accessToken(key);
}

export function question(id: string, text = `question ${id}`): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

export function answer(id: string, text = `answer ${id}`): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

export class AgentSocket {
  readonly frames: Frame[] = [];
  readonly #socket: WebSocket;
  readonly #listeners = new Set<() => void>();
  #closeCode: number | null = null;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.accept();
    socket.addEventListener("close", (event) => {
      this.#closeCode = event.code;
      for (const listener of this.#listeners) {
        listener();
      }
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        this.frames.push(JSON.parse(event.data));
        for (const listener of this.#listeners) {
          listener();
        }
      }
    });
  }

  send(frame: Frame): void {
    this.#socket.send(JSON.stringify(frame));
  }

  // The first frame from `from` on that matches, waiting at most WAIT_MS for it.
  next(matches: (frame: Frame) => boolean, from = 0): Promise<Frame> {
    return this.#until(() => this.frames.slice(from).find(matches), "matching frame");
  }

  // The code the server closed the socket with, waiting at most WAIT_MS for it.
  closed(): Promise<number> {
    return this.#until(() => this.#closeCode ?? undefined, "close");
  }

  async #until<T>(found: () => T | undefined, what: string): Promise<T> {
    const now = found();
    if (now !== undefined) {
      return now;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let listener: (() => void) | null = null;
    try {
      return await new Promise<T>((resolve, reject) => {
        listener = () => {
          const value = found();
          if (value !== undefined) {
            resolve(value);
          }
        };
        this.#listeners.add(listener);
        timer = setTimeout(() => reject(new Error(`no ${what} within ${WAIT_MS} ms`)), WAIT_MS);
      });
    } finally {
      if (listener !== null) {
        this.#listeners.delete(listener);
      }
      clearTimeout(timer);
    }
  }

  // The chat lists the server sent (cf_agent_chat_messages) from frame `from` on, oldest first.
  chatLists(from = 0): UIMessage[][] {
    return this.frames.slice(from).filter(isChatList).map(messagesOf);
  }

  // Waits for a chat list that holds message `id`, and returns the number of frames received by then.
  async received(id: string): Promise<number> {
    await this.next((frame) => isChatList(frame) && messagesOf(frame).some((message) => message.id === id));
    return this.frames.length;
  }

  // Sends a chat request and waits for its last response frame (the SDK answers every request with one).
  async chat(messages: UIMessage[], trigger: "submit-message" | "regenerate-message" = "submit-message") {
    const id = crypto.randomUUID();
    const from = this.frames.length;
    this.send({
      type: "cf_agent_use_chat_request",
      id,
      init: { method: "POST", body: JSON.stringify({ messages, trigger }) },
    });
    await this.next(
      (frame) => frame["type"] === "cf_agent_use_chat_response" && frame["id"] === id && frame["done"] === true,
      from,
    );
  }

  close(): void {
    this.#socket.close();
  }
}

function isChatList(frame: Frame): boolean {
  return frame["type"] === "cf_agent_chat_messages";
}

function messagesOf(frame: Frame): UIMessage[] {
  const messages = frame["messages"];
  return Array.isArray(messages) ? messages : [];
}

// Opens a WebSocket to /agents/<binding>/<name> through the Worker.
export async function connect(path: string, token: string, headers: Record<string, string> = {}): Promise<AgentSocket> {
  const res = await exports.default.fetch(request(path, token, { headers: { Upgrade: "websocket", ...headers } }));
  if (res.status !== 101 || res.webSocket === null) {
    throw new Error(`${path} answered ${res.status}, not a WebSocket`);
  }
  return new AgentSocket(res.webSocket);
}

// The stored history as the UI loads it.
export async function storedMessages(path: string, token: string): Promise<UIMessage[]> {
  const res = await exports.default.fetch(request(`${path}/get-messages`, token));
  if (res.status !== 200) {
    throw new Error(`get-messages answered ${res.status}`);
  }
  return res.json();
}
