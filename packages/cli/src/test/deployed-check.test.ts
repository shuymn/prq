// The deployed checks' I/O against servers on loopback (nothing reaches a network): what a run prints and saves holds no
// withheld value, each request and WebSocket has its bound and ends with the run's signal, a wait's read that ends
// after its bound does not count, E5 times each poll by its own end, E9 credits only a departure the abort made, E10
// reads workers.dev's answers, summary keeps the first new pull request it saw, the prq runs and the tools end however
// the check ends and the tools get no deployment value, and the command stops on Ctrl-C, saving what it observed.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import * as v from "valibot";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";

import type { Running } from "./cli.ts";
import {
  checkAssets,
  checkDeparture,
  checkEndpoints,
  checkLedger,
  checkLongPoll,
  type ClientBuild,
  EDGE_PACE,
  type EdgePace,
  headerRules,
  runTool,
  withPrq,
} from "./deployed-edge.ts";
import { correlation, Report } from "./deployed-report.ts";
import { checkSummary, githubHead, type Pace, readBefore, waitForEmptyPool } from "./deployed-session.ts";
import { openSocket, type Origin, send, sendQuestion } from "./origin.ts";

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(opened.splice(0).map((resource) => resource.close()));
});

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("not listening");
  }
  opened.push({
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return { url: `http://127.0.0.1:${address.port}`, server };
}

async function sockets(onConnection: (socket: WebSocket) => void): Promise<string> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  opened.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
  await once(server, "listening");
  server.on("connection", onConnection);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("not listening");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prq-deployed-test-"));
  opened.push({ close: () => rm(dir, { recursive: true, force: true }) });
  return dir;
}

const origin = (url: string): Origin => ({ url, headers: () => Promise.resolve({}) });
const never = () => {};
const json = (res: ServerResponse, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(200, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
const abortAfter = (ms: number) => AbortSignal.timeout(ms);

const SECRET = "0123456789abcdef".repeat(4);
const CLIENT_ID = "feedface.access";
const HOST = "prq.private.example";
const TEAM = "https://privateteam.cloudflareaccess.com";

describe("a run's output", () => {
  test("holds no withheld value, in its lines or its saved JSON, which goes to a new file readable by its owner", async () => {
    const lines: string[] = [];
    const report = new Report((line) => lines.push(line), {
      host: HOST,
      teamDomain: TEAM,
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      subdomain: "acct",
    });
    report.add({
      id: "E1",
      what: "navigation GET /",
      verdict: "pass",
      observed: `Location ${TEAM}/cdn-cgi/access/login/${HOST}`,
      evidence: { at: "2026-11-19T00:00:00.000Z", cfRay: "8f0a1b2c3d4e5f60-NRT", url: "https://prq.acct.workers.dev/" },
    });
    report.note(`client ${CLIENT_ID} at https://${HOST}`);
    // Part of the secret, in a note and in an observation: each string is withheld whole, and the run stays JSON.
    report.note(`a line with ${SECRET.slice(0, 10)}`);
    report.add({ id: "E6", what: "prq wait", verdict: "fail", observed: `stderr "${SECRET.slice(0, 10)}"` });
    const dir = await tempDir();
    const file = join(dir, "run.json");
    await report.save(file, { mode: "edge", argument: SECRET.slice(0, 12) });

    const saved = await readFile(file, "utf8");
    for (const written of [lines.join("\n"), saved]) {
      for (const withheld of [HOST, "privateteam", CLIENT_ID, SECRET.slice(0, 8), "acct.workers.dev"]) {
        expect(written).not.toContain(withheld);
      }
    }
    expect(lines[0]).toBe(
      "pass E1 navigation GET /: Location <team-domain>/cdn-cgi/access/login/<host> [2026-11-19T00:00:00.000Z cf-ray 8f0a1b2c3d4e5f60-NRT]",
    );
    expect(lines).toContain("  [withheld: it held part of the client secret]");
    expect(lines).toContain("FAIL E6 prq wait: [withheld: it held part of the client secret]");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(saved)).toMatchObject({
      mode: "edge",
      observations: [{ id: "E1" }, { id: "E6", observed: "[withheld: it held part of the client secret]" }],
    });
  });

  test("keeps a cf-ray only when it is a Ray ID", () => {
    const at = "2026-11-19T00:00:00.000Z";
    const ray = (value: string) =>
      correlation("/api/ledger", { at, status: 403, headers: { "cf-ray": value } })["cfRay"];
    expect(ray("8f0a1b2c3d4e5f60-NRT")).toBe("8f0a1b2c3d4e5f60-NRT");
    expect(ray("eyJhbGciOiJSUzI1NiJ9.e30.c2ln")).toBeNull();
    expect(ray("8f0a1b2c3d4e5f60-NRT; aud=0123")).toBeNull();
  });

  test("is never saved over an existing file or through a symbolic link", async () => {
    const dir = await tempDir();
    const existing = join(dir, "run.json");
    await writeFile(existing, "kept");
    const target = join(dir, "target.json");
    const link = join(dir, "link.json");
    await symlink(target, link);
    const report = new Report(never, {});
    await expect(report.save(existing, {})).rejects.toMatchObject({ code: "EEXIST" });
    await expect(report.save(link, {})).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(existing, "utf8")).toBe("kept");
    expect(await lstat(target).catch(() => null)).toBeNull();
  });
});

describe("what a run says of an upstream answer", () => {
  test("comes from the fields the check names: a JWT or an AUD in a header or an ID reaches no line and no saved run", async () => {
    const aud = "a1b2".repeat(16);
    const jwt = [{ alg: "RS256" }, { aud: [aud] }, { s: 1 }]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .join(".");
    const { url } = await serve((req, res) => {
      if (req.url?.startsWith("/api/ledger") === true) {
        json(res, { rows: [], nextCursor: null }, { "Cache-Control": `private, aud=${aud}, ${jwt}` });
      } else if (req.url?.startsWith("/api/agents") === true) {
        // An agent ID is its owner's choice: one holding the AUD.
        json(res, { rows: [{ agentId: aud, lastSeenAt: null, waiting: true, holdsJob: false }], nextCursor: null });
      } else if (req.url === "/other") {
        // A media type of no vocabulary, well formed, its subtype the AUD.
        res.writeHead(200, { "Content-Type": `application/${aud}` }).end();
      } else {
        res
          .writeHead(500, { "Content-Type": `text/html; aud=${aud}; token=${jwt}`, "Cf-Ray": jwt })
          .end(`<p>${jwt}</p>`);
      }
    });
    const lines: string[] = [];
    const report = new Report((line) => lines.push(line), {});
    const signal = new AbortController().signal;
    await checkEndpoints(
      [
        { what: "the production URL", url: `${url}/` },
        { what: "the preview URL", url: `${url}/other` },
      ],
      report,
      signal,
    );
    await checkLedger(origin(url), report, signal);
    await waitForEmptyPool({ origin: origin(url), report, signal, pace: PACE });
    const file = join(await tempDir(), "run.json");
    await report.save(file, { mode: "edge" });
    const saved = await readFile(file, "utf8");
    for (const written of [lines.join("\n"), saved]) {
      expect(written).not.toContain(aud);
      expect(written).not.toContain(jwt.split(".")[1]);
    }
    expect(lines).toEqual([
      expect.stringContaining("HTTP 500, text/html, "),
      expect.stringContaining("HTTP 200, another content-type"),
      expect.stringContaining("HTTP 200, a ledger page, a cache-control other than no-store"),
      "  waiting for an empty pool; present: an agent (the web UI names it) (last contact none, waiting, holding no job)",
      expect.stringContaining("still present after 0 s: an agent (the web UI names it) (last contact none"),
    ]);
  });
});

describe("a request's bound and the run's signal", () => {
  test("end an HTTP request the server never answers", async () => {
    const { url } = await serve(never);
    const from = performance.now();
    await expect(send(origin(url), "/", { timeoutMs: 300 })).rejects.toMatchObject({
      name: "TimeoutError",
      message: "no answer within 300 ms",
    });
    await expect(send(origin(url), "/", { signal: abortAfter(100) })).rejects.toMatchObject({ name: "TimeoutError" });
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("stopped by a signal")), 100);
    await expect(send(origin(url), "/", { signal: stop.signal })).rejects.toThrow("stopped by a signal");
    expect(performance.now() - from).toBeLessThan(5_000);
  });

  test("end a WebSocket handshake the server never answers, as no HTTP answer or with the signal's reason", async () => {
    const { url } = await serve(never);
    expect(await openSocket(origin(url), "/agents/hub/hub", { timeoutMs: 300 })).toMatchObject({
      kind: "failed",
      reason: "no answer within 300 ms",
    });
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("stopped by a signal")), 100);
    await expect(openSocket(origin(url), "/agents/hub/hub", { signal: stop.signal })).rejects.toThrow(
      "stopped by a signal",
    );
  });

  test("end a refused handshake whose answer never ends, keeping what came", async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(403, { "Content-Type": "text/html" });
      const timer = setInterval(() => res.write("x"), 25);
      res.once("close", () => clearInterval(timer));
    });
    const from = performance.now();
    const handshake = await openSocket(origin(url), "/agents/hub/hub", { timeoutMs: 300 });
    expect(handshake).toMatchObject({ kind: "refused", status: 403, body: expect.stringMatching(/^x+$/) });
    expect(performance.now() - from).toBeLessThan(2_000);
  });

  test("read a refused handshake by its HTTP answer, and an opened socket's frames within a bound or the signal", async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(302, { Location: `${TEAM}/cdn-cgi/access/login/x` }).end("redirecting");
    });
    expect(await openSocket(origin(url), "/agents/hub/hub")).toMatchObject({
      kind: "refused",
      status: 302,
      headers: { location: `${TEAM}/cdn-cgi/access/login/x` },
      body: "redirecting",
    });

    const hub = await sockets((socket) => socket.send(JSON.stringify({ type: "prq:version", version: "v0.1.0" })));
    const handshake = await openSocket(origin(hub), "/agents/hub/hub");
    if (handshake.kind !== "opened") {
      throw new Error(`not opened: ${handshake.kind}`);
    }
    expect(await handshake.socket.next("prq:version", { timeoutMs: 1_000 })).toEqual({
      type: "prq:version",
      version: "v0.1.0",
    });
    await expect(handshake.socket.next("cf_agent_state", { timeoutMs: 200 })).rejects.toThrow(
      "no cf_agent_state frame within 200 ms",
    );
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("stopped by a signal")), 100);
    await expect(handshake.socket.next("cf_agent_state", { signal: stop.signal })).rejects.toThrow(
      "stopped by a signal",
    );
    await handshake.socket.close();
    await expect(handshake.socket.next("cf_agent_state", { timeoutMs: 1_000 })).rejects.toThrow(
      "closed before a cf_agent_state frame",
    );
  });

  test("bound a session's handshake and its use together", async () => {
    // The switch comes after 600 ms and no acknowledgement after it: an 800 ms bound ends the question 200 ms later.
    const { url, server } = await serve(never);
    const session = new WebSocketServer({ noServer: true });
    opened.push({ close: () => new Promise((resolve) => session.close(() => resolve())) });
    server.on("upgrade", (req, socket, head) => {
      setTimeout(() => session.handleUpgrade(req, socket, head, () => {}), 600);
    });
    const from = performance.now();
    await expect(
      sendQuestion(origin(url), { owner: "a", repo: "b", number: 1 }, { id: "q-1", text: "Why?" }, { timeoutMs: 800 }),
    ).rejects.toThrow(/^no cf_agent_use_chat_response frame within \d+ ms$/);
    expect(performance.now() - from).toBeLessThan(1_150);
  });
});

const PACE: Pace = { pollMs: 20, poolMs: 150, poolReportMs: 1_000, newRowMs: 2_000, jobMs: 1_000 };

// A read that ignores its signal and settles after 200 ms.
const late = () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));

describe("a wait's read", () => {
  test("that ends after the wait's bound does not count: the pool is not credited empty", async () => {
    const { url } = await serve((_req, res) => {
      setTimeout(() => json(res, { rows: [], nextCursor: null }), 400);
    });
    const report = new Report(never, {});
    const context = { origin: origin(url), report, signal: new AbortController().signal, pace: PACE };
    expect(await waitForEmptyPool(context)).toBe(false);
    expect(report.observations).toMatchObject([{ id: "S0", verdict: "fail", observed: "no agent list within 0 s" }]);
  });

  test("that settles after the wait's bound without being ended by it does not count either", async () => {
    expect(await readBefore(performance.now() + 50, new AbortController().signal, late)).toBeNull();
    expect(await readBefore(performance.now() + 1_000, new AbortController().signal, late)).toBe("late");
  });

  test("ends with the run's signal", async () => {
    const { url } = await serve((_req, res) => {
      setTimeout(() => json(res, { rows: [], nextCursor: null }), 300);
    });
    const report = new Report(never, {});
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 25);
    const context = { origin: origin(url), report, signal: stop.signal, pace: { ...PACE, poolMs: 10_000 } };
    await expect(waitForEmptyPool(context)).rejects.toMatchObject({ name: "AbortError" });
    expect(report.observations).toEqual([]);
  });
});

function ledgerRow(number: number, owner: "local" | "cloud" | null) {
  return {
    pr: { owner: "acme", repo: "widgets", number },
    details: null,
    owner,
    latestEvent: null,
    problem: null,
    jobs: { waiting: 0, running: 0, failed: 0 },
    claims: [],
  };
}

describe("summary", () => {
  // The ledger's reads after the first, newest first as the Hub orders it. #5 is the first new pull request: its owner
  // turns out local, while #6's is the cloud agent.
  test.for([
    [
      "two come in one read",
      [
        [ledgerRow(6, null), ledgerRow(5, null)],
        [ledgerRow(6, "cloud"), ledgerRow(5, "local")],
      ],
    ],
    ["a later read lists them otherwise", [[ledgerRow(5, null)], [ledgerRow(5, "local"), ledgerRow(6, "cloud")]]],
  ] as const)("takes the first new pull request and keeps it while its owner is decided: %s", async ([, later]) => {
    let reads = 0;
    const { url } = await serve((req, res) => {
      if (req.url?.startsWith("/api/agents") === true) {
        json(res, { rows: [], nextCursor: null });
        return;
      }
      reads += 1;
      json(res, { rows: reads === 1 ? [] : (later[Math.min(reads - 2, later.length - 1)] ?? []), nextCursor: null });
    });
    const report = new Report(never, {});
    await checkSummary(
      { origin: origin(url), report, signal: new AbortController().signal, pace: PACE },
      { repo: "acme/widgets", headOf: () => Promise.reject(new Error("no head to read")) },
    );
    expect(report.observations).toMatchObject([
      { id: "S0", verdict: "pass" },
      { id: "S2", what: "the owner of acme/widgets#5", verdict: "fail" },
    ]);
  });

  test("reads GitHub's head again before its verdict, and passes no analysis of a head GitHub has left", async () => {
    // GitHub's head moves once the check has read it.
    const report = await summaryOf(sessionAt(HEAD_A), [HEAD_A]);
    expect(report.notes).toContain(`GitHub's head moved to ${HEAD_B}; deciding by its analysis`);
    expect(report.observations.at(-1)).toMatchObject({
      id: "S2",
      what: "the analysis of acme/widgets#5",
      verdict: "fail",
      observed: `no analysis of ${HEAD_B} ended within 1 s`,
    });
  });

  test("keeps reading GitHub's head while the session names another", async () => {
    // The session is at B, its analysis done; GitHub answers A twice before B.
    const report = await summaryOf(sessionAt(HEAD_B), [HEAD_A, HEAD_A]);
    expect(report.observations.at(-1)).toMatchObject({
      id: "S2",
      what: "the analysis of acme/widgets#5",
      verdict: "pass",
      observed: expect.stringContaining(`done at ${HEAD_B}`),
    });
  });
});

const HEAD_A = "a".repeat(40);
const HEAD_B = "c".repeat(40);

// A session of acme/widgets#5 at the head, its analysis of that head done, and its stored result.
// A job ID as the Worker makes it.
const JOB = "10000000-0000-4000-8000-000000000001";

function sessionAt(head: string) {
  const state = {
    pr: { owner: "acme", repo: "widgets", number: 5 },
    details: {
      fullName: "acme/widgets",
      title: "t",
      state: "open",
      url: "https://github.com/acme/widgets/pull/5",
      headSha: head,
      baseSha: "b".repeat(40),
    },
    owner: "cloud",
    jobs: [
      {
        jobId: JOB,
        target: { kind: "analysis", headSha: head },
        state: "done",
        agentId: null,
        since: null,
        stalled: false,
        failure: null,
        resultMessageId: `analysis-${JOB}`,
        createdAt: 0,
        updatedAt: 0,
        rev: 1,
        run: 1,
      },
    ],
  };
  const message = {
    id: `analysis-${JOB}`,
    role: "assistant",
    parts: [{ type: "text", text: "The summary." }],
    metadata: { kind: "analysis", jobId: JOB, headSha: head, by: { kind: "cloud", model: "m" } },
  };
  return { state, message };
}

// summary against a Hub where acme/widgets#5 comes cloud-owned with the session given, GitHub answering the heads in
// turn and then B.
async function summaryOf(session: ReturnType<typeof sessionAt>, heads: string[]): Promise<Report> {
  let reads = 0;
  const { url, server } = await serve((req, res) => {
    if (req.url?.startsWith("/api/agents") === true) {
      json(res, { rows: [], nextCursor: null });
    } else if (req.url?.startsWith("/api/ledger") === true) {
      reads += 1;
      json(res, { rows: reads === 1 ? [] : [ledgerRow(5, "cloud")], nextCursor: null });
    } else {
      json(res, [session.message]);
    }
  });
  // The session's WebSocket, on the same origin: its state as each new connection receives it.
  const sessions = new WebSocketServer({ server });
  opened.push({ close: () => new Promise((resolve) => sessions.close(() => resolve())) });
  sessions.on("connection", (socket) => socket.send(JSON.stringify({ type: "cf_agent_state", state: session.state })));
  const report = new Report(never, {});
  await checkSummary(
    { origin: origin(url), report, signal: new AbortController().signal, pace: PACE },
    { repo: "acme/widgets", headOf: () => Promise.resolve(heads.shift() ?? HEAD_B) },
  );
  return report;
}

// A pace for loopback polls: a 600 ms deadline, with the margins scaled to it.
const POLLS: EdgePace = {
  ...EDGE_PACE,
  waitMs: 600,
  nearBeforeMs: 200,
  nearAfterMs: 400,
  watchMs: 50,
  shownMs: 1_000,
  departureMs: 300,
  beforeDeadlineMs: 100,
  cliWaitSeconds: 1,
};

const PollBody = v.pipe(v.string(), v.parseJson(), v.object({ agentId: v.string() }));

const timedOut = (res: ServerResponse) => json(res, { status: "timeout" }, { "Prq-Version": "v0.1.0" });

describe("the long polls", () => {
  test("E5 times each poll from its start to its own end", async () => {
    let polls = 0;
    const { url } = await serve((_req, res) => {
      polls += 1;
      // The first poll ends at the deadline, the second at once: only the first is near it.
      setTimeout(() => timedOut(res), polls === 1 ? 600 : 50);
    });
    const cli: Running = {
      exited: Promise.resolve({ code: 2, signal: null, stdout: '{"status":"timeout","next":"wait"}\n', stderr: "" }),
      kill: () => cli.exited,
    };
    const observations = await checkLongPoll(
      { pace: POLLS, version: "v0.1.0", prq: () => cli },
      origin(url),
      new AbortController().signal,
    );
    expect(observations.map((entry) => entry.verdict)).toEqual(["pass", "fail", "pass"]);
    expect(observations[1]?.observed).toMatch(/ended after 0\.\d s, not near 0\.6 s/);
  });

  test.for([
    ["ended", (res: ServerResponse) => res.writeHead(503).end(), "HTTP 503"],
    ["sent its status line and part of its body", (res: ServerResponse) => res.writeHead(503).write("par"), "HTTP 503"],
    // Bytes on the connection that the client has not parsed into a status yet.
    [
      "sent its status line with its headers unfinished",
      (res: ServerResponse) => res.socket?.write("HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n"),
      "its first bytes",
    ],
    [
      "sent an informational 103 and no more",
      (res: ServerResponse) => res.writeEarlyHints({ link: "</assets/app.js>; rel=preload" }),
      "HTTP 103",
    ],
  ] as const)(
    "E9 credits no departure to a cut poll whose answer %s before the check saw it waiting",
    async ([, answer, begun]) => {
      // The cut poll answers on its own after 150 ms; the agent list is a snapshot taken when it is asked for and
      // sent 250 ms later, so it shows the cut poll waiting after its answer began.
      const url = await departureHub(250, {
        cut: (res, end) =>
          setTimeout(() => {
            end();
            answer(res);
          }, 150),
        keep: (res, end) =>
          setTimeout(() => {
            end();
            timedOut(res);
          }, 600),
      });
      const [, cut] = await checkDeparture(origin(url), POLLS, new AbortController().signal);
      expect(cut).toMatchObject({
        verdict: "fail",
        observed: `an answer (${begun}) had begun before the abort: no departure to observe`,
      });
    },
  );

  test("E9 credits no departure when the poll left to its deadline did not pass", async () => {
    // The kept poll is answered ready at once; the cut one is held until the check leaves it.
    const url = await departureHub(0, {
      cut: () => undefined,
      keep: (res, end) => {
        end();
        json(res, { status: "ready" });
      },
    });
    const [keep, cut] = await checkDeparture(
      origin(url),
      { ...POLLS, waitMs: 2_000, departureMs: 1_000 },
      new AbortController().signal,
    );
    expect(keep).toMatchObject({ verdict: "unexercised" });
    expect(cut).toMatchObject({
      verdict: "unexercised",
      observed: expect.stringContaining("not credited: the poll left to its deadline did not pass"),
    });
  });
});

// A Hub for E9's pair: each poll held until its scene answers it (end stops listing it waiting), and an agent list that
// is a snapshot taken when it is asked for, sent lag ms later.
async function departureHub(
  lag: number,
  scene: Record<"cut" | "keep", (res: ServerResponse, end: () => void) => void>,
): Promise<string> {
  const pending = new Set<string>();
  const { url } = await serve((req, res) => {
    if (req.url?.startsWith("/api/agents") === true) {
      const rows = [...pending].map((agentId) => ({ agentId, lastSeenAt: 1, waiting: true, holdsJob: false }));
      setTimeout(() => json(res, { rows, nextCursor: null }), lag);
      return;
    }
    void text(req).then((body) => {
      const { agentId } = v.parse(PollBody, body);
      pending.add(agentId);
      const end = () => void pending.delete(agentId);
      res.once("close", end);
      scene[agentId.startsWith("edge-cut-") ? "cut" : "keep"](res, end);
    });
  });
  return url;
}

describe("E7 on a site's answers", () => {
  const shell = Buffer.from("<!doctype html><title>prq</title>");
  const asset = { path: "/assets/app.js", bytes: Buffer.from("export {};\n") };
  const build: ClientBuild = {
    shell,
    assets: [asset],
    rootFiles: [],
    rules: headerRules("/*\n  X-Content-Type-Options: nosniff\n/\n  Cache-Control: no-cache\n"),
  };
  // The build's site, with the /index.html redirect and the answer to a missing asset given.
  const site = (index: string, missing: (res: ServerResponse) => void, indexStatus = 307) =>
    serve((req, res) => {
      const path = req.url ?? "/";
      const headers = { "X-Content-Type-Options": "nosniff" };
      if (path === "/index.html") {
        res.writeHead(indexStatus, { ...headers, Location: index }).end();
      } else if (path === asset.path) {
        res.writeHead(200, { ...headers, "Content-Type": "text/javascript" }).end(asset.bytes);
      } else if (path.startsWith("/assets/")) {
        missing(res);
      } else if (req.headers["if-none-match"] === '"shell"') {
        res.writeHead(304).end();
      } else {
        res
          .writeHead(200, {
            ...headers,
            "Content-Type": "text/html",
            ETag: '"shell"',
            ...(path === "/" ? { "Cache-Control": "no-cache" } : {}),
          })
          .end(shell);
      }
    });
  const shellAnswer = (res: ServerResponse) =>
    res.writeHead(200, { "X-Content-Type-Options": "nosniff", "Content-Type": "text/html" }).end(shell);
  const verdicts = async (url: string) => {
    const report = new Report(never, {});
    await checkAssets(origin(url), build, report, new AbortController().signal);
    return Object.fromEntries(report.observations.map((entry) => [entry.what, [entry.verdict, entry.observed]]));
  };

  test("passes a site that answers as its build", async () => {
    const { url } = await site("/", shellAnswer);
    expect(Object.values(await verdicts(url)).map(([verdict]) => verdict)).toEqual(Array(6).fill("pass"));
  });

  test("fails a redirect of /index.html off the origin", async () => {
    const { url } = await site("https://different.example/", shellAnswer);
    expect((await verdicts(url))["navigation GET /index.html"]).toEqual([
      "fail",
      "expected a redirect to this origin's /: HTTP 307, Location elsewhere (withheld)",
    ]);
  });

  test("fails a 304 for /index.html, though it names the origin's /", async () => {
    const { url } = await site("/", shellAnswer, 304);
    expect((await verdicts(url))["navigation GET /index.html"]).toEqual([
      "fail",
      "expected a redirect to this origin's /: HTTP 304, Location /",
    ]);
  });

  test("fails an error page for a missing asset, though it comes as HTML with the shell's headers", async () => {
    const { url } = await site("/", (res) =>
      res
        .writeHead(503, {
          "X-Content-Type-Options": "nosniff",
          "Content-Type": "text/html",
          "Cache-Control": "no-cache",
        })
        .end("<!doctype html><title>unavailable</title>"),
    );
    expect((await verdicts(url))["GET /assets/prq-missing-<random>.js"]).toEqual([
      "fail",
      `HTTP 503; 41 bytes, not the build's ${shell.length}`,
    ]);
  });
});

describe("E10 on workers.dev's answers", () => {
  test.for([
    [
      "Cloudflare's page for an address with nothing behind it",
      404,
      { "Content-Type": "text/html" },
      "<html>There is nothing here yet</html>",
      "pass",
    ],
    ["the bootstrap Worker", 404, { "x-prq-bootstrap": "1" }, "", "fail"],
    ["prq's shell", 200, { "Content-Type": "text/html" }, "<html><head><title>prq</title></head></html>", "fail"],
    ["the Worker's error JSON", 401, { "Content-Type": "application/json" }, '{"error":"unauthorized"}', "fail"],
    ["the Worker's version", 404, { "Prq-Version": "v0.1.0" }, "", "fail"],
    ["a redirect elsewhere", 302, { Location: "/live" }, "", "unexercised"],
    ["an error page", 500, { "Content-Type": "text/html" }, "<html>error</html>", "unexercised"],
  ] as const)("%s: %s", async ([, status, headers, body, verdict]) => {
    const { url } = await serve((_req, res) => res.writeHead(status, headers).end(body));
    const report = new Report(never, {});
    await checkEndpoints([{ what: "the production URL", url: `${url}/` }], report, new AbortController().signal);
    expect(report.observations).toMatchObject([{ id: "E10", verdict }]);
  });

  test("an address that gives no HTTP answer: unexercised", async () => {
    const { url } = await serve(never);
    await opened.splice(0)[0]?.close();
    const report = new Report(never, {});
    await checkEndpoints([{ what: "the production URL", url: `${url}/` }], report, new AbortController().signal);
    expect(report.observations).toMatchObject([
      { id: "E10", verdict: "unexercised", observed: expect.stringContaining("the dashboard's settings decide") },
    ]);
  });
});

// A Worker that never answers: a prq wait there runs until its own bound, far longer than these tests.
async function config() {
  const { url } = await serve(never);
  return { url, clientId: CLIENT_ID, clientSecret: SECRET };
}

describe("prq runs for the edge check", () => {
  test("are killed when the run's signal ends the check, and their HOME removed", async () => {
    const stop = new AbortController();
    let home = "";
    const exit = await withPrq(await config(), stop.signal, async (prq, made) => {
      home = made;
      const run = prq(["wait", "--timeout", "60"], { PRQ_AGENT_ID: "edge-cli" });
      setTimeout(() => stop.abort(), 200);
      return run.exited;
    });
    expect(exit.signal).toBe("SIGKILL");
    expect(await lstat(home).catch(() => null)).toBeNull();
  });

  test("are killed and their HOME removed when the check fails while they run", async () => {
    let home = "";
    let running: Promise<{ signal: NodeJS.Signals | null }> | undefined;
    await expect(
      withPrq(await config(), new AbortController().signal, async (prq, made) => {
        home = made;
        running = prq(["wait", "--timeout", "60"], {}).exited;
        throw new Error("the check failed");
      }),
    ).rejects.toThrow("the check failed");
    expect((await running)?.signal).toBe("SIGKILL");
    expect(await lstat(home).catch(() => null)).toBeNull();
  });

  test("are killed once their --timeout and the grace have passed", async () => {
    const from = performance.now();
    const exit = await withPrq(
      await config(),
      new AbortController().signal,
      (prq) => prq(["wait", "--timeout", "1"], {}).exited,
      200,
    );
    expect(exit.signal).toBe("SIGKILL");
    expect(performance.now() - from).toBeLessThan(10_000);
  });

  test("do not start once the run's signal has ended the check", async () => {
    const stop = new AbortController();
    let home = "";
    await expect(
      withPrq(await config(), stop.signal, (prq, made) => {
        home = made;
        stop.abort(new Error("stopped by a signal"));
        prq(["wait", "--timeout", "60"], {});
        return Promise.resolve();
      }),
    ).rejects.toThrow("stopped by a signal");
    expect(await lstat(home).catch(() => null)).toBeNull();
  });
});

describe("a tool the check runs", () => {
  test("gets only the caller's variables it uses, none of the deployment's", async () => {
    const source = {
      PATH: process.env["PATH"] ?? "",
      HOME: "/home/owner",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TERM: "xterm-256color",
      XDG_CONFIG_HOME: "/home/owner/.config",
      GH_TOKEN: "gh-own-login",
      GH_HOST: "github.com",
      MISE_DATA_DIR: "/home/owner/.mise",
    };
    const printed = await runTool(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      keepStdout: true,
      withheld: [HOST, new URL(TEAM).hostname],
      env: {
        ...source,
        // A bypass list naming the deployment and the team among others; one naming only them.
        NO_PROXY: `localhost, ${HOST.toUpperCase()}:443,.privateteam.cloudflareaccess.com,127.0.0.1`,
        no_proxy: `${HOST},privateteam.cloudflareaccess.com`,
        PRQ_URL: `https://${HOST}`,
        PRQ_ACCESS_CLIENT_ID: CLIENT_ID,
        PRQ_ACCESS_CLIENT_SECRET: SECRET,
        ACCESS_AUD: "a1b2".repeat(16),
        ACCESS_TEAM_DOMAIN: TEAM,
        CLOUDFLARE_API_TOKEN: "cf-token",
        npm_config_user_agent: "pnpm",
      },
    });
    const received = v.parse(Env, printed);
    // Every variable the child has, and each value: the source's, and on macOS the text encoding it gives every process.
    expect(Object.keys(received).toSorted()).toEqual([...Object.keys(source), "NO_PROXY", ...OWN_VARIABLES].toSorted());
    expect(received).toMatchObject({ ...source, NO_PROXY: "localhost,127.0.0.1" });
  });

  test("gh, given only the deployment's host, gets no bypass entry naming it or an Access team", async () => {
    const dir = await tempDir();
    const record = join(dir, "no-proxy");
    // A gh on PATH that records the bypass list it got and answers a head.
    await writeFile(
      join(dir, "gh"),
      `#!/bin/sh\nprintf '%s' "\${NO_PROXY-unset}" > '${record}'\nprintf '%s\\n' ${"a".repeat(40)}\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);
    vi.stubEnv("NO_PROXY", `localhost,${HOST},.privateteam.cloudflareaccess.com:443,*.cloudflareaccess.com,127.0.0.1`);
    const pr = { owner: "acme", repo: "widgets", number: 7 };
    expect(await githubHead(pr, new AbortController().signal, [HOST])).toBe("a".repeat(40));
    expect(await readFile(record, "utf8")).toBe("localhost,*.cloudflareaccess.com,127.0.0.1");
  });

  test("ends with the run's signal, its whole process group with it", async () => {
    const dir = await tempDir();
    const marker = join(dir, "marker");
    const pids = join(dir, "pids");
    // A launcher that starts a child, which writes the marker 400 ms later, as pnpm starts the build's script.
    const launcher = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late'), 400)", process.argv[1]], { stdio: "ignore" });
      require("node:fs").writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);`;
    const stop = new AbortController();
    const running = runTool(process.execPath, ["-e", launcher, marker, pids], {
      timeoutMs: 60_000,
      signal: stop.signal,
    });
    await until(() => readFile(pids, "utf8"));
    stop.abort(new Error("stopped by a signal"));
    await expect(running).rejects.toThrow("stopped by a signal");
    await sleep(600);
    expect(await lstat(marker).catch(() => null)).toBeNull();
    for (const pid of v.parse(Pids, await readFile(pids, "utf8"))) {
      expect(() => process.kill(pid, 0)).toThrow("ESRCH");
    }
  });

  test("past its bound is stopped, after the grace by SIGKILL, and fails though it then exits 0", async () => {
    const dir = await tempDir();
    const pids = join(dir, "pids");
    // A launcher that takes SIGTERM as a request to exit 0 in 700 ms.
    const launcher = `
      process.on("SIGTERM", () => setTimeout(() => process.exit(0), 700));
      require("node:fs").writeFileSync(process.argv[1], JSON.stringify([process.pid]));
      setInterval(() => {}, 1000);`;
    const from = performance.now();
    await expect(
      runTool(process.execPath, ["-e", launcher, pids], {
        timeoutMs: 300,
        graceMs: 200,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(performance.now() - from).toBeLessThan(700);
    for (const pid of v.parse(Pids, await readFile(pids, "utf8"))) {
      expect(() => process.kill(pid, 0)).toThrow("ESRCH");
    }
  });

  test("keeps no more than its bound of output, and none of a tool whose output is not its result", async () => {
    const signal = new AbortController().signal;
    const flood = "process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000)";
    await expect(
      runTool(process.execPath, ["-e", flood], { timeoutMs: 10_000, signal, keepStdout: true }),
    ).rejects.toThrow(`${process.execPath} wrote more than 65536 bytes`);
    expect(
      await runTool(process.execPath, ["-e", "process.stdout.write('built')"], { timeoutMs: 10_000, signal }),
    ).toBe("");
  });

  test("returns its output though a process outside its group still holds the pipe", async () => {
    const dir = await tempDir();
    const pids = join(dir, "pids");
    // A tool that writes, starts a holder of its stdout in a group of the holder's own, and exits; the holder ends
    // itself after 10 s and is killed below.
    const tool = `
      const { spawn } = require("node:child_process");
      process.stdout.write("head");
      const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
      require("node:fs").writeFileSync(process.argv[1], JSON.stringify([holder.pid]));
      holder.unref();`;
    const from = performance.now();
    try {
      expect(
        await runTool(process.execPath, ["-e", tool, pids], {
          timeoutMs: 10_000,
          signal: new AbortController().signal,
          keepStdout: true,
        }),
      ).toBe("head");
      expect(performance.now() - from).toBeLessThan(5_000);
    } finally {
      for (const pid of v.parse(Pids, await readFile(pids, "utf8"))) {
        process.kill(pid, "SIGKILL");
      }
    }
  });
});

const Pids = v.pipe(v.string(), v.parseJson(), v.array(v.number()));
const Env = v.pipe(v.string(), v.parseJson(), v.record(v.string(), v.string()));
// What a process gets from the system itself, not from its parent.
const OWN_VARIABLES = process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [];

// The value read once it can be read, within 5 s.
async function until<T>(read: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (performance.now() > deadline) {
        throw error;
      }
      await sleep(20);
    }
  }
}

describe("the command", () => {
  const ENTRY = fileURLToPath(new URL("./deployed-check.ts", import.meta.url));

  function command(args: string[], env: Record<string, string>) {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
      child.on("close", (code) => resolve({ code, stdout, stderr })),
    );
    opened.push({ close: async () => void child.kill("SIGKILL") });
    return { child, exited, stdout: () => stdout };
  }

  test("refuses a usage error and a missing configuration without naming a value", async () => {
    const usage = await command(["summary", SECRET], {}).exited;
    expect(usage).toMatchObject({ code: 1, stderr: expect.stringContaining("the repository is not") });
    expect(usage.stderr).not.toContain(SECRET.slice(0, 8));
    const missing = await command(["pool"], { PRQ_URL: `https://${HOST}`, PRQ_ACCESS_CLIENT_ID: CLIENT_ID }).exited;
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no service token");
    expect(missing.stderr).not.toContain(HOST);
    expect(missing.stderr).not.toContain(CLIENT_ID);
  });

  test("names only why a run was not saved, not where", async () => {
    const { url } = await serve((_req, res) => json(res, { rows: [], nextCursor: null }));
    const dir = await tempDir();
    const file = join(dir, "absent", `${SECRET}.json`);
    const exit = await command(["pool", "--json", file], {
      PRQ_URL: url,
      PRQ_ACCESS_CLIENT_ID: CLIENT_ID,
      PRQ_ACCESS_CLIENT_SECRET: SECRET,
    }).exited;
    expect(exit.code).toBe(1);
    expect(exit.stderr).toBe("check:deployed: the run was not saved to the --json file (ENOENT)\n");
  });

  test("stops on Ctrl-C, saving what it observed", { timeout: 20_000 }, async () => {
    const { url } = await serve((_req, res) => {
      json(res, { rows: [{ agentId: "laptop", lastSeenAt: 1, waiting: false, holdsJob: false }], nextCursor: null });
    });
    const dir = await tempDir();
    const file = join(dir, "run.json");
    const run = command(["pool", "--json", file], {
      PRQ_URL: url,
      PRQ_ACCESS_CLIENT_ID: CLIENT_ID,
      PRQ_ACCESS_CLIENT_SECRET: SECRET,
    });
    await expect.poll(() => run.stdout(), { timeout: 10_000 }).toContain("waiting for an empty pool");
    run.child.kill("SIGINT");
    const exit = await run.exited;
    expect(exit.code).toBe(130);
    expect(exit.stdout).toContain("FAIL pool the run: stopped by a signal");
    const saved = await readFile(file, "utf8");
    expect(JSON.parse(saved)).toMatchObject({ mode: "pool", observations: [{ verdict: "fail" }] });
    for (const written of [exit.stdout, saved]) {
      expect(written).not.toContain(SECRET.slice(0, 8));
      expect(written).not.toContain(CLIENT_ID);
      expect(written).not.toContain(new URL(url).host);
    }
  });
});
