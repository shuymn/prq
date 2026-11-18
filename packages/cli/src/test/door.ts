// The browser's door to the Worker, which the Access stand-in (access.ts) opens next to its own listener: a browser
// signed in to Access sends no service token, and Access passes its requests on with the application's token. Every
// request and WebSocket upgrade is forwarded as it came (method, path and query, headers, body), its bytes streamed both
// ways and either side's close passed on, with any Cf-Access-Jwt-Assertion the browser sent replaced by the harness's.
//
// Each forward is bounded: the Worker has DOOR_ANSWER_MS to answer a request's headers or an upgrade, else the browser
// gets 504 and the upstream request is dropped. A Worker that cannot be reached gets the browser 502. A browser that
// goes away drops its upstream request or socket, and close() ends every connection the door holds.

import { Agent, createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { Worker } from "./worker.ts";

const DOOR_ANSWER_MS = 30_000;

// Headers that belong to one connection, not to the request or answer it carries.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);
const ASSERTION = "cf-access-jwt-assertion";

// A forwarded request as the door saw it: the browser's path and conditional header, and the Worker's status (null
// until it answered, or when it never did).
export type DoorEntry = { path: string; ifNoneMatch: string | null; status: number | null };

export type Door = { url: string; log: DoorEntry[]; close(): Promise<void> };

type Upstream = Pick<Worker, "url" | "token">;

// Raw headers (Node's rawHeaders) as [name, value] pairs.
function pairsOf(raw: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    pairs.push([raw[i] ?? "", raw[i + 1] ?? ""]);
  }
  return pairs;
}

// The headers passed on: all but the hop-by-hop ones (kept for an upgrade, which needs them) and the assertion.
function forwardable(raw: readonly string[], upgrade: boolean): [string, string][] {
  return pairsOf(raw).filter(([name]) => {
    const lower = name.toLowerCase();
    return lower !== ASSERTION && (upgrade || !HOP_BY_HOP.has(lower));
  });
}

// An HTTP/1.1 head written to a raw socket: the status line and the headers.
function head(status: number, message: string, headers: readonly [string, string][]): string {
  return `HTTP/1.1 ${status} ${message}\r\n${headers.map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`;
}

export async function startDoor(worker: Upstream, { answerMs = DOOR_ANSWER_MS } = {}): Promise<Door> {
  // Its own agent, without keep-alive, so that no idle upstream connection outlives a forward or the door.
  const agent = new Agent({ keepAlive: false });
  // Every connection the door holds, the browser's and the Worker's, for close().
  const connections = new Set<Duplex>();
  const hold = (socket: Duplex) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  };

  async function upstreamOptions(req: IncomingMessage, isUpgrade: boolean) {
    const target = new URL(worker.url());
    const headers = forwardable(req.rawHeaders, isUpgrade);
    headers.push(["Cf-Access-Jwt-Assertion", await worker.token()]);
    return {
      agent,
      host: target.hostname,
      port: target.port,
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: headers.flat(),
    };
  }

  const log: DoorEntry[] = [];

  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const entry: DoorEntry = {
      path: req.url ?? "/",
      ifNoneMatch: req.headers["if-none-match"] ?? null,
      status: null,
    };
    log.push(entry);
    const options = await upstreamOptions(req, false);
    // The browser went away while the token was signed.
    if (res.destroyed) {
      return;
    }
    const fail = (status: 502 | 504) => {
      clearTimeout(timer);
      upstream.destroy();
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "text/plain", Connection: "close" }).end(`door: ${status}\n`);
      } else {
        res.destroy();
      }
    };
    const timer = setTimeout(() => fail(504), answerMs);
    const upstream = request(options, (answer) => {
      clearTimeout(timer);
      if (res.destroyed) {
        answer.destroy();
        return;
      }
      entry.status = answer.statusCode ?? null;
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, forwardable(answer.rawHeaders, false).flat());
      answer.pipe(res);
      answer.once("error", () => res.destroy());
      answer.once("aborted", () => res.destroy());
    });
    upstream.once("error", () => fail(502));
    // The browser went away: so does the request it made.
    res.once("close", () => {
      clearTimeout(timer);
      if (!res.writableFinished) {
        upstream.destroy();
      }
    });
    req.pipe(upstream);
  }

  async function forwardUpgrade(req: IncomingMessage, socket: Duplex, first: Buffer): Promise<void> {
    socket.on("error", () => socket.destroy());
    const options = await upstreamOptions(req, true);
    if (socket.destroyed) {
      return;
    }
    const fail = (status: 502 | 504) => {
      clearTimeout(timer);
      upstream.destroy();
      if (socket.writable) {
        socket.end(
          head(status, "Door", [
            ["Connection", "close"],
            ["Content-Length", "0"],
          ]),
        );
      }
      socket.destroy();
    };
    const timer = setTimeout(() => fail(504), answerMs);
    const upstream = request(options);
    upstream.once("error", () => fail(502));
    socket.once("close", () => {
      clearTimeout(timer);
      upstream.destroy();
    });
    // The Worker refused the upgrade: its answer goes to the browser, and the connection ends with it. Node has decoded
    // the body, so it goes without its framing headers, delimited by the close.
    upstream.once("response", (answer) => {
      clearTimeout(timer);
      const headers = forwardable(answer.rawHeaders, false);
      headers.push(["Connection", "close"]);
      socket.write(head(answer.statusCode ?? 502, answer.statusMessage ?? "", headers));
      answer.pipe(socket);
      answer.once("error", () => socket.destroy());
    });
    upstream.once("upgrade", (answer, upstreamSocket, upstreamFirst) => {
      clearTimeout(timer);
      // Adopted only while the browser's socket is still open.
      if (socket.destroyed) {
        upstreamSocket.destroy();
        return;
      }
      hold(upstreamSocket);
      socket.write(head(101, answer.statusMessage ?? "Switching Protocols", pairsOf(answer.rawHeaders)));
      if (upstreamFirst.length > 0) {
        socket.write(upstreamFirst);
      }
      if (first.length > 0) {
        upstreamSocket.write(first);
      }
      // Each side's end ends the other's writing; a close or an error on either side ends both.
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      const end = () => {
        socket.destroy();
        upstreamSocket.destroy();
      };
      upstreamSocket.once("close", end);
      upstreamSocket.on("error", end);
      socket.once("close", end);
    });
    upstream.end();
  }

  const server = createServer((req, res) => {
    forward(req, res).catch(() => res.destroy());
  });
  server.on("connection", hold);
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, first: Buffer) => {
    forwardUpgrade(req, socket, first).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the door is not listening on a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    log,
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const connection of connections) {
        connection.destroy();
      }
      agent.destroy();
      await closed;
    },
  };
}
