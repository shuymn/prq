// The browser's door to the Worker, which the Access stand-in (access.ts) opens next to its own listener: a browser
// signed in to Access sends no service token, and Access passes its requests on with the application's token. Every
// request and WebSocket upgrade is forwarded as it came (method, path and query, headers, body), its bytes streamed both
// ways and either side's close passed on, with any Cf-Access-Jwt-Assertion the browser sent replaced by the harness's.
//
// A test can plan what happens to the next request a path matches (DoorPlan): gate it before it is forwarded, or hold
// the Worker's answer before it is passed on, each until the test releases it. It can cut the open WebSockets of a
// route (cut()), both sides at once, as a network failure would. And it can have the door serve a directory (serve())
// in place of the Worker's static assets, as an earlier deploy's would be: every path outside the Worker's routes is
// then a file of the directory, or its index.html.
//
// Each forward is bounded: from its arrival, the browser has its answer's headers or switched protocols within
// DOOR_ANSWER_MS, a gate's or a hold's wait included, else it gets 504 and the upstream request is dropped. A Worker that
// cannot be reached, or whose answer breaks off (also while held), gets the browser 502, or its connection cut once the
// answer's headers were passed on. A browser that goes away drops its upstream request or socket, also while gated or
// held, and close() ends every connection the door holds.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Agent, createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import { extname, join, resolve as resolvePath, sep } from "node:path";
import type { Duplex } from "node:stream";

import type { Latch } from "./latch.ts";
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

// The Worker's routes (packages/server/wrangler.jsonc `run_worker_first`), which serve() leaves to the Worker.
const WORKER_ROUTES = /^\/(?:api|agents|cli|webhook)(?:\/|$)/;

// The media types of the files a build of the web UI emits.
const MEDIA_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain",
};

// What happens to the next request a plan matches: gate holds it before it is forwarded, opening arrived when it
// reaches the door, and forwards it once release opens; hold forwards it, opens answered once the Worker's answer
// (its headers) arrived, and passes that answer on once release opens. A gate applies to an upgrade too.
type DoorPlan = { kind: "gate"; arrived: Latch; release: Latch } | { kind: "hold"; answered: Latch; release: Latch };

// A forwarded request as the door saw it: the browser's path (with its query) and conditional header, the Worker's
// status (null until it answered, or when it never did), and whether the browser went away before its answer came.
type DoorEntry = { path: string; ifNoneMatch: string | null; status: number | null; cancelled: boolean };

export type Door = {
  url: string;
  log: DoorEntry[];
  // The next request whose path (with its query) matches takes the plan, once; plans are tried in the order given.
  plan(match: (path: string) => boolean, plan: DoorPlan): void;
  // Ends every open WebSocket whose path (with its query) matches, the browser's side and the Worker's; how many.
  cut(match: (path: string) => boolean): number;
  // Serves this directory in place of the Worker's static assets, until called with null.
  serve(dir: string | null): void;
  // Drops the plans no request took and stops serving a directory.
  clear(): void;
  close(): Promise<void>;
};

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

// A file of the served directory, or its index.html for any other path; false when the directory has neither.
async function serveStatic(dir: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://door").pathname);
  const root = resolvePath(dir);
  const candidate = resolvePath(join(root, pathname));
  const inside = candidate.startsWith(`${root}${sep}`);
  const file = inside && (await stat(candidate).catch(() => null))?.isFile() ? candidate : join(root, "index.html");
  if (!(await stat(file).catch(() => null))?.isFile()) {
    return false;
  }
  res.writeHead(200, {
    "Content-Type": MEDIA_TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  createReadStream(file)
    .once("error", () => res.destroy())
    .pipe(res);
  return true;
}

// Opens the stage's latch, then waits for release, or until the signal aborts: false then.
function released(stage: Latch, release: Latch, signal: AbortSignal): Promise<boolean> {
  stage.open();
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const abort = () => resolve(false);
    signal.addEventListener("abort", abort, { once: true });
    void release.promise.then(() => {
      signal.removeEventListener("abort", abort);
      resolve(!signal.aborted);
    });
  });
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
  const plans: { match: (path: string) => boolean; plan: DoorPlan }[] = [];
  // The WebSockets open through the door, by the browser's path, each with what ends both its sides.
  const open = new Set<{ path: string; end: () => void }>();
  let staticDir: string | null = null;

  function planFor(path: string, upgrade: boolean): DoorPlan | undefined {
    const index = plans.findIndex(({ match, plan }) => (!upgrade || plan.kind === "gate") && match(path));
    return index < 0 ? undefined : plans.splice(index, 1)[0]?.plan;
  }

  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? "/";
    const dir = staticDir;
    if (dir !== null && !WORKER_ROUTES.test(path) && (await serveStatic(dir, req, res))) {
      return;
    }
    const entry: DoorEntry = {
      path,
      ifNoneMatch: req.headers["if-none-match"] ?? null,
      status: null,
      cancelled: false,
    };
    log.push(entry);
    const plan = planFor(path, false);
    // The browser goes away: whatever the forward is waiting on ends.
    const gone = new AbortController();
    let upstream: ReturnType<typeof request> | undefined;
    // The forward's first failure ends it; a later one (the answer's own end, say) changes nothing.
    let failed = false;
    const fail = (status: 502 | 504) => {
      if (failed) {
        return;
      }
      failed = true;
      clearTimeout(timer);
      gone.abort();
      upstream?.destroy();
      if (res.headersSent || res.destroyed) {
        res.destroy();
      } else {
        res.writeHead(status, { "Content-Type": "text/plain", Connection: "close" }).end(`door: ${status}\n`);
      }
    };
    const timer = setTimeout(() => fail(504), answerMs);
    res.once("close", () => {
      clearTimeout(timer);
      if (!res.writableFinished) {
        entry.cancelled = !res.headersSent;
        gone.abort();
        upstream?.destroy();
      }
    });
    if (plan?.kind === "gate" && !(await released(plan.arrived, plan.release, gone.signal))) {
      return;
    }
    const options = await upstreamOptions(req, false);
    // The browser went away, or the bound passed, while the token was signed.
    if (gone.signal.aborted || res.destroyed) {
      return;
    }
    upstream = request(options, (answer) => {
      // The answer breaking off fails the forward from the start, so that a hold's wait ends with it.
      answer.once("error", () => fail(502));
      answer.once("close", () => {
        if (!answer.complete) {
          fail(502);
        }
      });
      void (async () => {
        if (plan?.kind === "hold" && !(await released(plan.answered, plan.release, gone.signal))) {
          answer.destroy();
          return;
        }
        clearTimeout(timer);
        if (res.destroyed) {
          answer.destroy();
          return;
        }
        entry.status = answer.statusCode ?? null;
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, forwardable(answer.rawHeaders, false).flat());
        answer.pipe(res);
      })();
    });
    upstream.once("error", () => fail(502));
    req.pipe(upstream);
  }

  async function forwardUpgrade(req: IncomingMessage, socket: Duplex, first: Buffer): Promise<void> {
    socket.on("error", () => socket.destroy());
    const plan = planFor(req.url ?? "/", true);
    const gone = new AbortController();
    let upstream: ReturnType<typeof request> | undefined;
    const fail = (status: 502 | 504) => {
      clearTimeout(timer);
      gone.abort();
      upstream?.destroy();
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
    socket.once("close", () => {
      clearTimeout(timer);
      gone.abort();
      upstream?.destroy();
    });
    if (plan?.kind === "gate" && !(await released(plan.arrived, plan.release, gone.signal))) {
      return;
    }
    const options = await upstreamOptions(req, true);
    if (gone.signal.aborted || socket.destroyed) {
      return;
    }
    upstream = request(options);
    upstream.once("error", () => fail(502));
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
      const entry = { path: req.url ?? "/", end: () => {} };
      const end = () => {
        open.delete(entry);
        socket.destroy();
        upstreamSocket.destroy();
      };
      entry.end = end;
      open.add(entry);
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
    plan(match, plan) {
      plans.push({ match, plan });
    },
    cut(match) {
      const cut = [...open].filter((entry) => match(entry.path));
      for (const entry of cut) {
        entry.end();
      }
      return cut.length;
    },
    serve(dir) {
      staticDir = dir;
    },
    clear() {
      plans.length = 0;
      staticDir = null;
    },
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
