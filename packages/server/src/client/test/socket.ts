// A WebSocket the test drives, for PartySocket to connect with: each connection waits until the test opens it, then
// receives the frames the test sends and records what the page sends; the test can drop it as a network failure
// would. PartySocket's own timers (its connect timeout, its reconnect delay) decide when it connects again.

import * as v from "valibot";

export class TestSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  readonly url: string;
  // What the page sent, parsed.
  readonly sent: Record<string, unknown>[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }

  send(data: string): void {
    if (this.readyState !== this.OPEN) {
      throw new DOMException("not open", "InvalidStateError");
    }
    this.sent.push(v.parse(v.record(v.string(), v.unknown()), JSON.parse(data)));
  }

  // PartySocket closes a connection it gives up on and reports the close itself.
  close(): void {
    this.readyState = this.CLOSED;
  }

  open(): void {
    this.readyState = this.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  drop(): void {
    this.readyState = this.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code: 1006, wasClean: false }));
  }
}

export function controlledSockets() {
  const sockets: TestSocket[] = [];
  const waiters: (() => void)[] = [];
  class Socket extends TestSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
      for (const wake of waiters.splice(0)) {
        wake();
      }
    }
  }
  return {
    WebSocket: Socket,
    sockets,
    // The n-th connection (from 0), once the page has made it.
    async socket(index: number): Promise<TestSocket> {
      while (sockets[index] === undefined) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      return sockets[index];
    },
    // Every frame of this type the page sent, over all its connections.
    sent(type: string): Record<string, unknown>[] {
      return sockets.flatMap((socket) => socket.sent.filter((frame) => frame["type"] === type));
    },
  };
}
