// A stand-in for Cloudflare Access in front of the Worker, which the CLI under test talks to (PRQ_URL). As Access
// does for a service token, it checks CF-Access-Client-Id and CF-Access-Client-Secret, removes them and forwards the
// request with a signed Cf-Access-Jwt-Assertion; a bad token gets 403 with an HTML body and no Prq-Version. It is also
// the tests' wait point and fault injector: per route, the next requests can be answered here, held, cut off or
// rewritten (Plan), and every request is logged. Next to it, the browser's door (door.ts) forwards a browser's requests
// and WebSockets with the application's token, as Access does for the host signed in.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";

import { type Door, type DoorEntry, type DoorPlan, startDoor } from "./door.ts";
import type { Latch } from "./latch.ts";
import type { Worker } from "./worker.ts";

// What the stand-in does with one request to a route.
type Plan =
  // Answer with this status and an error body, with Prq-Version as the Worker sends it, without forwarding.
  | { kind: "reply"; status: 500 | 503 }
  // Forward; once the Worker answered, resolve answered, then write the answer when release opens.
  | { kind: "hold"; answered: Latch; release: Latch }
  // Forward; once the Worker answered, cut the connection without answering.
  | { kind: "drop" }
  // Forward; once the Worker answered, discard its answer and answer 503 instead.
  | { kind: "lose" }
  // Answer 503 at once, as a route that stopped waiting does, and forward the request only when release opens: a call
  // that lands after its route answered. answered opens once the Worker answered it.
  | { kind: "defer"; release: Latch; answered: Latch }
  // Forward, and answer the Worker's status and headers with this body.
  | { kind: "body"; body: string };

// How the stand-in treats the service token: forward (as Access does for a good one), refuse with 403 or a redirect
// to a login page (what Access may answer for a bad one), or forward with an expired token (the Worker's 401).
export type Mode = "forward" | "forbid" | "redirect" | "expired";

// A request as the stand-in saw it: when it arrived (performance.now()), its route and agent ID, whether it carried the
// service token, the status answered (null while pending or when cut off before the Worker answered), and whether its
// connection is still open (a request in flight).
type LogEntry = {
  at: number;
  route: string;
  agentId: string | null;
  serviceToken: boolean;
  status: number | null;
  open: boolean;
};

export type Access = {
  url: string;
  // The browser's door to the Worker (door.ts), the requests it forwarded, its plans and the directory it serves.
  door: string;
  doorLog(): DoorEntry[];
  doorPlan(match: (path: string) => boolean, plan: DoorPlan): void;
  doorServe(dir: string | null): void;
  clientId: string;
  clientSecret: string;
  mode: Mode;
  // When set, every Prq-Version the stand-in sends carries this instead of the Worker's version.
  serverVersion: string | null;
  // The next requests to the route take these plans, one each.
  plan(route: string, ...plans: Plan[]): void;
  // Every request to the route takes this plan until clear().
  always(route: string, plan: Plan): void;
  log: LogEntry[];
  // Drops the plans, the log and the settings, before each test.
  clear(): void;
  close(): Promise<void>;
};

export async function startAccess(worker: Worker): Promise<Access> {
  const clientId = `${randomBytes(8).toString("hex")}.access`;
  const clientSecret = randomBytes(32).toString("hex");
  const queued = new Map<string, Plan[]>();
  const persistent = new Map<string, Plan>();
  let door: Door | undefined;

  const access: Access = {
    url: "",
    door: "",
    doorLog: () => door?.log ?? [],
    doorPlan(match, plan) {
      required(door).plan(match, plan);
    },
    doorServe(dir) {
      required(door).serve(dir);
    },
    clientId,
    clientSecret,
    mode: "forward",
    serverVersion: null,
    plan(route, ...plans) {
      queued.set(route, [...(queued.get(route) ?? []), ...plans]);
    },
    always(route, plan) {
      persistent.set(route, plan);
    },
    log: [],
    clear() {
      door?.log.splice(0);
      door?.clear();
      queued.clear();
      persistent.clear();
      access.log.length = 0;
      access.mode = "forward";
      access.serverVersion = null;
    },
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await Promise.all([door?.close(), closed]);
    },
  };

  function nextPlan(route: string): Plan | undefined {
    const plans = queued.get(route);
    return plans !== undefined && plans.length > 0 ? plans.shift() : persistent.get(route);
  }

  // The Prq-Version an answer carries: the Worker's, or the rewritten one.
  function version(value: string | null): string | null {
    return value === null ? null : (access.serverVersion ?? value);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = performance.now();
    const route = new URL(req.url ?? "/", "http://stand-in").pathname;
    const body = await text(req);
    const entry: LogEntry = {
      at,
      route,
      agentId: agentIdOf(body),
      serviceToken: false,
      status: null,
      open: !res.closed,
    };
    access.log.push(entry);
    res.on("close", () => {
      entry.open = false;
    });
    const answer = (status: number, headers: Record<string, string>, payload: string) => {
      entry.status = status;
      if (!res.destroyed) {
        res.writeHead(status, headers).end(payload);
      }
    };
    entry.serviceToken =
      req.headers["cf-access-client-id"] === clientId && req.headers["cf-access-client-secret"] === clientSecret;
    if (!entry.serviceToken || access.mode === "forbid") {
      answer(403, { "Content-Type": "text/html" }, "<html><body>Forbidden</body></html>");
      return;
    }
    if (access.mode === "redirect") {
      answer(302, { Location: "https://team.prq.example/cdn-cgi/access/login" }, "");
      return;
    }
    const plan = nextPlan(route);
    if (plan?.kind === "reply" || plan?.kind === "defer") {
      const status = plan.kind === "reply" ? plan.status : 503;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const sent = version(worker.version);
      if (sent !== null) {
        headers["Prq-Version"] = sent;
      }
      answer(status, headers, JSON.stringify({ error: status === 503 ? "unavailable" : "internal" }));
      if (plan.kind === "defer") {
        void forwardLate(route, body, plan.release, plan.answered);
      }
      return;
    }

    // Forward. The upstream request ends when the client goes away.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) {
        abort.abort();
      }
    });
    let upstream: Response;
    let payload: string;
    try {
      upstream = await fetch(new URL(route, worker.url()), {
        method: req.method ?? "POST",
        headers: {
          "Content-Type": req.headers["content-type"] ?? "application/json",
          "Cf-Access-Jwt-Assertion": await worker.token({ expired: access.mode === "expired" }),
        },
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }),
        redirect: "manual",
        signal: abort.signal,
      });
      payload = await upstream.text();
    } catch {
      res.destroy();
      return;
    }
    if (plan?.kind === "hold") {
      plan.answered.open();
      await plan.release.promise;
    }
    if (plan?.kind === "drop") {
      entry.status = upstream.status;
      res.destroy();
      return;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of upstream.headers) {
      if (!["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"].includes(name)) {
        headers[name] = value;
      }
    }
    const sent = version(upstream.headers.get("Prq-Version"));
    if (sent !== null) {
      headers["prq-version"] = sent;
    }
    if (plan?.kind === "lose") {
      answer(
        503,
        { "Content-Type": "application/json", "Prq-Version": sent ?? worker.version },
        '{"error":"unavailable"}',
      );
      return;
    }
    answer(upstream.status, headers, plan?.kind === "body" ? plan.body : payload);
  }

  // A request forwarded once release opens, its client already answered.
  async function forwardLate(route: string, body: string, release: Latch, answered: Latch): Promise<void> {
    await release.promise;
    try {
      const upstream = await fetch(new URL(route, worker.url()), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": await worker.token() },
        body,
        redirect: "manual",
      });
      await upstream.text();
    } catch {
      // A failure to forward shows in what the test then finds in the Worker.
    } finally {
      answered.open();
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the stand-in is not listening on a port");
  }
  access.url = `http://127.0.0.1:${address.port}`;
  try {
    door = await startDoor(worker);
  } catch (error) {
    server.close();
    throw error;
  }
  access.door = door.url;
  return access;
}

function required(door: Door | undefined): Door {
  if (door === undefined) {
    throw new Error("the door is not open");
  }
  return door;
}

function agentIdOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const id = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "agentId") : undefined;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}
