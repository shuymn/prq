// The browser's door against stand-ins for the Worker on loopback: what it forwards, and how each forward ends.

import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { text } from "node:stream/consumers";

import { afterEach, describe, expect, test } from "vitest";

import { type Door, startDoor } from "./door.ts";
import { latch } from "./latch.ts";

const TOKEN = "the-harness-token";
const ANSWER_MS = 400;

type Upstream = {
  url: string;
  // Every connection the stand-in accepted, and whether the door has closed it (its end reached the stand-in; an
  // upgraded socket stays half-open on this side until the stand-in ends it).
  connections: { closed: boolean }[];
  close(): Promise<void>;
};

const started: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((resource) => resource.close()));
});

async function upstream(
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
  onUpgrade?: (req: IncomingMessage, socket: Duplex) => void,
): Promise<Upstream> {
  const server: Server = createServer(onRequest);
  const connections: { closed: boolean }[] = [];
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    const entry = { closed: false };
    connections.push(entry);
    sockets.add(socket);
    socket.once("end", () => {
      entry.closed = true;
    });
    socket.once("close", () => {
      entry.closed = true;
      sockets.delete(socket);
    });
  });
  if (onUpgrade !== undefined) {
    server.on("upgrade", onUpgrade);
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("not listening");
  }
  const stand = {
    url: `http://127.0.0.1:${address.port}`,
    connections,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
  started.push(stand);
  return stand;
}

async function door(target: string): Promise<Door> {
  const opened = await startDoor({ url: () => target, token: () => Promise.resolve(TOKEN) }, { answerMs: ANSWER_MS });
  started.push(opened);
  return opened;
}

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function send(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: options.method ?? "GET", headers: options.headers, signal: options.signal },
      (res) => {
        text(res).then((body) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }), reject);
      },
    );
    req.once("error", reject);
    req.end(options.body);
  });
}

// An upgrade request through the door: the answer's status, and the socket once switched.
function upgrade(url: string): Promise<{ status: number; socket: Duplex | null; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      },
    });
    req.once("upgrade", (res, socket) => resolve({ status: res.statusCode ?? 0, socket, body: "" }));
    req.once("response", (res) => {
      text(res).then((body) => resolve({ status: res.statusCode ?? 0, socket: null, body }), reject);
    });
    req.once("error", reject);
    req.end();
  });
}

// The socket of an upgrade that switched protocols.
function switched(result: { socket: Duplex | null }): Duplex {
  if (result.socket === null) {
    throw new Error("the upgrade did not switch protocols");
  }
  return result.socket;
}

// Switches protocols as a WebSocket server does, then echoes every byte back.
function echoUpgrade(_req: IncomingMessage, socket: Duplex): void {
  socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  socket.pipe(socket);
}

describe("an HTTP request through the door", () => {
  test("is forwarded as it came, with the harness's token in place of the browser's", async () => {
    let seen: { method: string; url: string; headers: IncomingMessage["headers"]; body: string } | undefined;
    const worker = await upstream((req, res) => {
      void text(req).then((body) => {
        seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
        res.writeHead(304, { ETag: '"abc"', "Cache-Control": "no-cache" }).end();
      });
    });
    const front = await door(worker.url);
    const answer = await send(`${front.url}/pr/a/b/1?x=1`, {
      method: "POST",
      headers: {
        "If-None-Match": '"abc"',
        "Sec-Fetch-Mode": "navigate",
        "Cf-Access-Jwt-Assertion": "a-forged-token",
        "Content-Type": "text/plain",
      },
      body: "the body",
    });
    expect(answer).toMatchObject({ status: 304, headers: { etag: '"abc"', "cache-control": "no-cache" }, body: "" });
    expect(seen).toMatchObject({
      method: "POST",
      url: "/pr/a/b/1?x=1",
      body: "the body",
      headers: {
        "if-none-match": '"abc"',
        "sec-fetch-mode": "navigate",
        "cf-access-jwt-assertion": TOKEN,
        "content-type": "text/plain",
      },
    });
  });

  test("gets 502 when the Worker cannot be reached", async () => {
    const worker = await upstream(() => {});
    const target = worker.url;
    await worker.close();
    const front = await door(target);
    expect((await send(`${front.url}/`)).status).toBe(502);
  });

  test("gets 504 when the Worker has not answered by the bound, and the upstream request is dropped", async () => {
    const worker = await upstream(() => {});
    const front = await door(worker.url);
    const from = performance.now();
    const answer = await send(`${front.url}/`);
    expect(answer.status).toBe(504);
    expect(performance.now() - from).toBeGreaterThanOrEqual(ANSWER_MS - 1);
    await expect.poll(() => worker.connections.every((connection) => connection.closed)).toBe(true);
  });

  test("is answered when the Worker answers just inside the bound", async () => {
    const worker = await upstream((_req, res) => {
      setTimeout(() => res.end("late but in time"), ANSWER_MS - 100);
    });
    const front = await door(worker.url);
    expect(await send(`${front.url}/`)).toMatchObject({ status: 200, body: "late but in time" });
  });

  test("is dropped upstream when the browser goes away", async () => {
    const asked = latch();
    const worker = await upstream(() => asked.open());
    const front = await door(worker.url);
    const abort = new AbortController();
    const sent = send(`${front.url}/`, { signal: abort.signal });
    await asked.promise;
    abort.abort();
    await expect(sent).rejects.toThrow("aborted");
    await expect.poll(() => worker.connections.every((connection) => connection.closed)).toBe(true);
  });
});

describe("a WebSocket upgrade through the door", () => {
  test("carries bytes both ways, and either side's close ends the other", async () => {
    let upstreamSocket: Duplex | undefined;
    const worker = await upstream(
      () => {},
      (req, socket) => {
        expect(req.headers["cf-access-jwt-assertion"]).toBe(TOKEN);
        upstreamSocket = socket;
        echoUpgrade(req, socket);
      },
    );
    const front = await door(worker.url);

    const first = await upgrade(`${front.url}/agents/hub/hub`);
    expect(first.status).toBe(101);
    const browser = switched(first);
    const bytes = randomBytes(64 * 1024);
    const received: Buffer[] = [];
    browser.on("data", (chunk: Buffer) => received.push(chunk));
    browser.write(bytes);
    await expect.poll(() => Buffer.concat(received).length).toBe(bytes.length);
    expect(Buffer.concat(received).equals(bytes)).toBe(true);
    // The browser closes: the Worker's side closes.
    browser.destroy();
    await expect.poll(() => worker.connections.every((connection) => connection.closed)).toBe(true);

    // The Worker closes: the browser's side closes.
    const second = await upgrade(`${front.url}/agents/hub/hub`);
    const closed = once(switched(second), "close");
    upstreamSocket?.destroy();
    await closed;

    // The Worker's connection is reset, an error rather than an end: the browser's side closes too.
    const third = await upgrade(`${front.url}/agents/hub/hub`);
    const reset = once(switched(third), "close");
    if (!(upstreamSocket instanceof Socket)) {
      throw new Error("the stand-in's upgrade has no TCP socket");
    }
    upstreamSocket.resetAndDestroy();
    await reset;
  });

  test.each([
    ["a fixed length", 'Content-Length: 24\r\n\r\n{"error":"unauthorized"}'],
    ["chunks", 'Transfer-Encoding: chunked\r\n\r\n18\r\n{"error":"unauthorized"}\r\n0\r\n\r\n'],
  ])("refused by the Worker with %s, passes the refusal on and ends", async (_framing, rest) => {
    const worker = await upstream(
      () => {},
      (_req, socket) => {
        socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n${rest}`);
      },
    );
    const front = await door(worker.url);
    expect(await upgrade(`${front.url}/agents/hub/hub`)).toMatchObject({
      status: 401,
      socket: null,
      body: '{"error":"unauthorized"}',
    });
  });

  test("not answered by the bound, gets 504 and the upstream socket is dropped", async () => {
    const worker = await upstream(
      () => {},
      () => {},
    );
    const front = await door(worker.url);
    const from = performance.now();
    expect((await upgrade(`${front.url}/agents/hub/hub`)).status).toBe(504);
    expect(performance.now() - from).toBeGreaterThanOrEqual(ANSWER_MS - 1);
    await expect.poll(() => worker.connections.every((connection) => connection.closed)).toBe(true);
  });

  test("gets 502 when the Worker cannot be reached", async () => {
    const worker = await upstream(() => {});
    const target = worker.url;
    await worker.close();
    const front = await door(target);
    expect((await upgrade(`${front.url}/agents/hub/hub`)).status).toBe(502);
  });
});

test("closing the door ends the connections it holds", async () => {
  const worker = await upstream(() => {}, echoUpgrade);
  const front = await startDoor({ url: () => worker.url, token: () => Promise.resolve(TOKEN) });
  const opened = await upgrade(`${front.url}/agents/hub/hub`);
  const closed = once(switched(opened), "close");
  await front.close();
  await closed;
  await expect.poll(() => worker.connections.every((connection) => connection.closed)).toBe(true);
});
