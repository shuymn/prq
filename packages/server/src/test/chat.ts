// A WebSocket client for the Agents routes as a browser uses them, through the Worker entry with a valid Access token.

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

  close(): void {
    this.#socket.close();
  }
}

// Opens a WebSocket to /agents/<binding>/<name> through the Worker.
export async function connect(path: string, token: string, headers: Record<string, string> = {}): Promise<AgentSocket> {
  const res = await exports.default.fetch(request(path, token, { headers: { Upgrade: "websocket", ...headers } }));
  if (res.status !== 101 || res.webSocket === null) {
    throw new Error(`${path} answered ${res.status}, not a WebSocket`);
  }
  return new AgentSocket(res.webSocket);
}
