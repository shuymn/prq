// The browser's door against stand-ins for the Worker on loopback: what it forwards, and how each forward ends.

import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("cut() ends the open sockets of the paths it names, both sides, and leaves the others carrying bytes", async () => {
    const worker = await upstream(() => {}, echoUpgrade);
    const front = await door(worker.url);
    const session = switched(await upgrade(`${front.url}/agents/pr-session/a~b~1`));
    const hub = switched(await upgrade(`${front.url}/agents/hub/hub`));
    const closed = once(session, "close");
    expect(front.cut((path) => path.startsWith("/agents/pr-session/"))).toBe(1);
    await closed;
    await expect.poll(() => worker.connections.filter((connection) => connection.closed)).toHaveLength(1);
    const echoed = once(hub, "data");
    hub.write("still open");
    expect(String((await echoed)[0])).toBe("still open");
    expect(front.cut((path) => path.startsWith("/agents/pr-session/"))).toBe(0);
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

// A stand-in Worker that answers every request at once with its path, and the paths it was asked for.
async function echoPaths(): Promise<Upstream & { asked: string[] }> {
  const asked: string[] = [];
  const worker = await upstream(
    (req, res) => {
      asked.push(req.url ?? "");
      res.end(`worker: ${req.url}`);
    },
    (req, socket) => {
      asked.push(req.url ?? "");
      echoUpgrade(req, socket);
    },
  );
  return Object.assign(worker, { asked });
}

const anyPath = () => true;

describe("a gated request", () => {
  test("reaches the Worker only once released, an upgrade too", async () => {
    const worker = await echoPaths();
    const front = await door(worker.url);
    const gate = { kind: "gate", arrived: latch(), release: latch() } as const;
    front.plan((path) => path === "/x", gate);
    const sent = send(`${front.url}/x`);
    await gate.arrived.promise;
    expect(worker.asked).toEqual([]);
    gate.release.open();
    expect(await sent).toMatchObject({ status: 200, body: "worker: /x" });

    const upgradeGate = { kind: "gate", arrived: latch(), release: latch() } as const;
    front.plan(anyPath, upgradeGate);
    const opened = upgrade(`${front.url}/agents/hub/hub`);
    await upgradeGate.arrived.promise;
    expect(worker.asked).toEqual(["/x"]);
    upgradeGate.release.open();
    switched(await opened).destroy();
    expect(worker.asked).toEqual(["/x", "/agents/hub/hub"]);
  });

  test("not released by the bound, gets 504 and never reaches the Worker", async () => {
    const worker = await echoPaths();
    const front = await door(worker.url);
    const gate = { kind: "gate", arrived: latch(), release: latch() } as const;
    front.plan(anyPath, gate);
    const from = performance.now();
    expect((await send(`${front.url}/x`)).status).toBe(504);
    expect(performance.now() - from).toBeGreaterThanOrEqual(ANSWER_MS - 1);
    gate.release.open();
    expect((await send(`${front.url}/y`)).body).toBe("worker: /y");
    expect(worker.asked).toEqual(["/y"]);
  });

  test("released just inside the bound, is answered", async () => {
    const worker = await echoPaths();
    const front = await door(worker.url);
    const gate = { kind: "gate", arrived: latch(), release: latch() } as const;
    front.plan(anyPath, gate);
    setTimeout(() => gate.release.open(), ANSWER_MS - 100);
    expect(await send(`${front.url}/x`)).toMatchObject({ status: 200, body: "worker: /x" });
  });

  test("never reaches the Worker when the browser went away", async () => {
    const worker = await echoPaths();
    const front = await door(worker.url);
    const gate = { kind: "gate", arrived: latch(), release: latch() } as const;
    front.plan(anyPath, gate);
    const abort = new AbortController();
    const sent = send(`${front.url}/x`, { signal: abort.signal });
    await gate.arrived.promise;
    abort.abort();
    await expect(sent).rejects.toThrow("aborted");
    await expect.poll(() => front.log[0]?.cancelled).toBe(true);
    gate.release.open();
    expect((await send(`${front.url}/y`)).body).toBe("worker: /y");
    expect(worker.asked).toEqual(["/y"]);
  });
});

describe("a held answer", () => {
  test("reaches the browser only once released", async () => {
    const worker = await echoPaths();
    const front = await door(worker.url);
    const hold = { kind: "hold", answered: latch(), release: latch() } as const;
    front.plan((path) => path.startsWith("/page?"), hold);
    let arrived = false;
    const sent = send(`${front.url}/page?cursor=2`).then((answer) => {
      arrived = true;
      return answer;
    });
    await hold.answered.promise;
    expect(worker.asked).toEqual(["/page?cursor=2"]);
    // A request the plan does not match passes meanwhile.
    expect((await send(`${front.url}/page`)).body).toBe("worker: /page");
    expect(arrived).toBe(false);
    hold.release.open();
    expect(await sent).toMatchObject({ status: 200, body: "worker: /page?cursor=2" });
  });

  test("not released by the bound, gets 504 and the Worker's answer is dropped", async () => {
    const worker = await echoPaths();
    const front = await door(worker.url);
    const hold = { kind: "hold", answered: latch(), release: latch() } as const;
    front.plan(anyPath, hold);
    const from = performance.now();
    expect((await send(`${front.url}/x`)).status).toBe(504);
    expect(performance.now() - from).toBeGreaterThanOrEqual(ANSWER_MS - 1);
    await expect.poll(() => worker.connections.every((connection) => connection.closed)).toBe(true);
  });

  test("whose answer breaks off while held, gets 502 then, and the hold ends", async () => {
    let answering: ServerResponse | undefined;
    const worker = await upstream((_req, res) => {
      res.writeHead(200, { "Content-Length": "10" });
      res.write("x");
      answering = res;
    });
    const front = await door(worker.url);
    const hold = { kind: "hold", answered: latch(), release: latch() } as const;
    front.plan(anyPath, hold);
    const from = performance.now();
    const sent = send(`${front.url}/x`);
    await hold.answered.promise;
    answering?.destroy();
    expect((await sent).status).toBe(502);
    expect(performance.now() - from).toBeLessThan(ANSWER_MS);
    hold.release.open();
    expect(front.log).toMatchObject([{ path: "/x", status: null, cancelled: false }]);
    await expect.poll(() => worker.connections.every((connection) => connection.closed)).toBe(true);
  });

  test("is dropped when the browser went away", async () => {
    const worker = await echoPaths();
    const front = await door(worker.url);
    const hold = { kind: "hold", answered: latch(), release: latch() } as const;
    front.plan(anyPath, hold);
    const abort = new AbortController();
    const sent = send(`${front.url}/x`, { signal: abort.signal });
    await hold.answered.promise;
    abort.abort();
    await expect(sent).rejects.toThrow("aborted");
    await expect.poll(() => front.log[0]?.cancelled).toBe(true);
    await expect.poll(() => worker.connections.every((connection) => connection.closed)).toBe(true);
  });
});

describe("a served directory", () => {
  test("stands in for the static assets, leaves the Worker's routes to it, and stops when switched off", async () => {
    // The served directory, and a file next to it that no path reaches.
    const base = await mkdtemp(join(tmpdir(), "prq-door-"));
    started.push({ close: () => rm(base, { recursive: true, force: true }) });
    const dir = join(base, "served");
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "index.html"), "<p>old shell</p>");
    await writeFile(join(dir, "assets", "old-index.js"), "export {};");
    await writeFile(join(base, "outside.txt"), "outside");
    const worker = await echoPaths();
    const front = await door(worker.url);
    front.serve(dir);

    expect(await send(`${front.url}/assets/old-index.js`)).toMatchObject({
      status: 200,
      headers: { "content-type": "text/javascript" },
      body: "export {};",
    });
    for (const path of ["/", "/pr/a/b/1", "/%2e%2e/outside.txt"]) {
      expect({ path, answer: await send(`${front.url}${path}`) }).toMatchObject({
        path,
        answer: { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "<p>old shell</p>" },
      });
    }
    for (const path of ["/api/ledger", "/agents/hub/hub", "/cli/wait", "/webhook"]) {
      expect((await send(`${front.url}${path}`)).body).toBe(`worker: ${path}`);
    }
    expect(worker.asked).toEqual(["/api/ledger", "/agents/hub/hub", "/cli/wait", "/webhook"]);

    front.serve(null);
    expect((await send(`${front.url}/`)).body).toBe("worker: /");
  });

  test("clear() stops serving it and drops the plans no request took", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prq-door-"));
    started.push({ close: () => rm(dir, { recursive: true, force: true }) });
    await writeFile(join(dir, "index.html"), "<p>old shell</p>");
    const worker = await echoPaths();
    const front = await door(worker.url);
    front.serve(dir);
    front.plan(anyPath, { kind: "gate", arrived: latch(), release: latch() });
    front.clear();
    expect((await send(`${front.url}/x`)).body).toBe("worker: /x");
  });
});

test("closing the door ends the connections it holds", async () => {
  const worker = await upstream(() => {}, echoUpgrade);
  const front = await startDoor({ url: () => worker.url, token: () => Promise.resolve(TOKEN) });
  const opened = await upgrade(`${front.url}/agents/hub/hub`);
  const closed = once(switched(opened), "close");
  const gate = { kind: "gate", arrived: latch(), release: latch() } as const;
  front.plan(anyPath, gate);
  const gated = send(`${front.url}/x`).then(
    () => "answered",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  await gate.arrived.promise;
  await front.close();
  await closed;
  expect(await gated).toBe("socket hang up");
  await expect.poll(() => worker.connections.every((connection) => connection.closed)).toBe(true);
});
