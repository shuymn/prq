// The deployed checks of ingress and the edge (deployed-check.ts; docs/operations.md, The deployed checks): endpoints
// (E10), what workers.dev serves of the Worker `prq`; and edge (E1-E9), what the hostname serves through Access with no
// credentials, a wrong token, the webhook bypass and the service token: the API, the CLI's long poll, the static
// assets byte for byte with the headers the tag's build generated, the Hub's WebSocket, and a client's departure from
// a poll reaching the Hub.
//
// Each request keeps its time, path and cf-ray for the owner to find in Access's logs. A denial is credited to Access
// only by a 302 to the team's sign-in for this host; another denial is recorded as it came, unattributed, and fails
// only when it shows the Worker handled the request (its Prq-Version, its error JSON, the shell, a 2xx, or a switched
// WebSocket). A Location is recorded only as the sign-in or the origin's root; any other is withheld. What a line says
// of an answer comes from deployed-report.ts's helpers: no header value, body or child output is copied.

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { ErrorResponse, LedgerPage, type PrRef, WaitResponse } from "@prq/protocol";
import * as v from "valibot";

import { type Running, startCli, stderrLines } from "./cli.ts";
import { correlation, mediaType, type Observation, type Report, type Verdict, versionOf } from "./deployed-report.ts";
import {
  agentRows,
  type Answer,
  CheckError,
  errorKind,
  type Handshake,
  jsonOf,
  openSocket,
  type Origin,
  send,
  serviceOrigin,
  sessionPath,
} from "./origin.ts";

// The shell's title, which no other page of the hostname carries.
const SHELL_MARK = "<title>prq</title>";

// A navigation as a browser makes it, and a subresource request by what it loads.
const NAVIGATION = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", Accept: "text/html" };

function subresource(path: string): Record<string, string> {
  const extension = path.split(".").at(-1) ?? "";
  const dest =
    { js: "script", css: "style", woff2: "font", woff: "font", svg: "image", png: "image" }[extension] ?? "empty";
  return { "Sec-Fetch-Mode": dest === "script" ? "cors" : "no-cors", "Sec-Fetch-Dest": dest, Accept: "*/*" };
}

const ErrorJson = v.pipe(v.string(), v.parseJson(), ErrorResponse);

// --- What a response shows ---

// An answer as the denial checks read it: an HTTP answer, or a handshake's outcome.
type Outcome = {
  at: string;
  // null when no HTTP answer came (a network error, or a socket that failed without one).
  status: number | null;
  headers: Record<string, string>;
  body: string;
  // A WebSocket that switched protocols.
  switched: boolean;
  reason: string | null;
};

// Where a check reads answers from: the deployment's origin, and the Access team its sign-in belongs to.
export type Site = { origin: string; teamDomain?: string };

function fromAnswer(answer: Answer): Outcome {
  return {
    at: answer.at,
    status: answer.status,
    headers: answer.headers,
    body: answer.body.toString("utf8"),
    switched: false,
    reason: null,
  };
}

function fromHandshake(handshake: Handshake): Outcome {
  if (handshake.kind === "opened") {
    return { at: handshake.at, status: 101, headers: handshake.headers, body: "", switched: true, reason: null };
  }
  if (handshake.kind === "refused") {
    const { at, status, headers, body } = handshake;
    return { at, status, headers, body, switched: false, reason: null };
  }
  const reason = handshake.cause === undefined ? handshake.reason : errorKind(handshake.cause);
  return { at: handshake.at, status: null, headers: {}, body: "", switched: false, reason };
}

// What shows the Worker handled the request.
function workerSigns(outcome: Pick<Outcome, "status" | "headers" | "body" | "switched">): string[] {
  const signs: string[] = [];
  if (outcome.switched) {
    signs.push("the WebSocket switched protocols");
  }
  if (outcome.status !== null && outcome.status >= 200 && outcome.status < 300) {
    signs.push(`HTTP ${outcome.status}`);
  }
  if (outcome.headers["prq-version"] !== undefined) {
    signs.push("a Prq-Version header");
  }
  const error = v.safeParse(ErrorJson, outcome.body);
  if (error.success) {
    signs.push(`the Worker's error JSON (${error.output.error})`);
  }
  if (outcome.body.includes(SHELL_MARK)) {
    signs.push("the web UI's shell");
  }
  return signs;
}

// The failure for a denied request that reached the Worker, or null when nothing shows it did.
function handledByWorker(outcome: Outcome, site: Site): { verdict: Verdict; observed: string } | null {
  const signs = workerSigns(outcome);
  return signs.length === 0
    ? null
    : { verdict: "fail", observed: `reached the Worker (${signs.join("; ")}): ${describe(outcome, site)}` };
}

// Whether a Location leads to the team's Access sign-in for this host: the team's origin, /cdn-cgi/access/login/<host>.
export function teamSignIn(location: string | undefined, site: Site): boolean {
  const target = location === undefined ? null : URL.parse(location);
  const team = site.teamDomain === undefined ? null : URL.parse(site.teamDomain);
  return (
    target !== null &&
    team !== null &&
    target.origin === team.origin &&
    target.pathname === `/cdn-cgi/access/login/${new URL(site.origin).host}`
  );
}

// A Location as a run records it: the sign-in or the origin's root by their paths, any other withheld. The sign-in's
// query holds the application's AUD (kid) and an opaque value (meta), and another Location may hold anything.
function recordedLocation(location: string | undefined, site: Site): string | undefined {
  if (location === undefined) {
    return undefined;
  }
  if (teamSignIn(location, site)) {
    const team = new URL(site.teamDomain ?? "");
    return `${team.origin}/cdn-cgi/access/login/${new URL(site.origin).host}`;
  }
  return URL.parse(location, site.origin)?.href === new URL("/", site.origin).href ? "/" : "elsewhere (withheld)";
}

function describe(outcome: Outcome, site: Site): string {
  if (outcome.status === null) {
    return `no HTTP answer (${outcome.reason ?? "unknown"})`;
  }
  const location = recordedLocation(outcome.headers["location"], site);
  const type = outcome.headers["content-type"];
  return [
    `HTTP ${outcome.status}`,
    ...(location === undefined ? [] : [`Location ${location}`]),
    ...(type === undefined ? [] : [mediaType(type)]),
    ...(outcome.body === "" ? [] : [`${Buffer.byteLength(outcome.body)} bytes`]),
  ].join(", ");
}

// --- E1, E2: the denials ---

type Sample = { what: string; path: string } & (
  | { kind: "http"; method: "GET" | "POST"; headers: Record<string, string>; body?: string }
  | { kind: "ws" }
);

function samples(assetPath: string, pr: PrRef | undefined): Sample[] {
  return [
    { kind: "http", what: "navigation GET /", path: "/", method: "GET", headers: NAVIGATION },
    { kind: "http", what: "navigation GET /pr/a/b/1", path: "/pr/a/b/1", method: "GET", headers: NAVIGATION },
    { kind: "http", what: `GET ${assetPath}`, path: assetPath, method: "GET", headers: subresource(assetPath) },
    { kind: "http", what: "GET /api/ledger", path: "/api/ledger", method: "GET", headers: {} },
    {
      kind: "http",
      what: "POST /cli/wait",
      path: "/cli/wait",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "edge-denied", timeoutMs: 0 }),
    },
    { kind: "ws", what: "WebSocket /agents/hub/hub", path: "/agents/hub/hub" },
    ...(pr === undefined ? [] : [{ kind: "ws", what: `WebSocket ${sessionPath(pr)}`, path: sessionPath(pr) } as const]),
  ];
}

async function sample(origin: Origin, entry: Sample, signal: AbortSignal): Promise<Outcome> {
  try {
    if (entry.kind === "ws") {
      const handshake = await openSocket(origin, entry.path, { signal });
      if (handshake.kind === "opened") {
        await handshake.socket.close();
      }
      return fromHandshake(handshake);
    }
    return fromAnswer(
      await send(origin, entry.path, {
        method: entry.method,
        headers: entry.headers,
        ...(entry.body === undefined ? {} : { body: entry.body }),
        signal,
      }),
    );
  } catch (error) {
    signal.throwIfAborted();
    return {
      at: new Date().toISOString(),
      status: null,
      headers: {},
      body: "",
      switched: false,
      reason: errorKind(error),
    };
  }
}

// E1's verdict on one sample: Access's 302 to the sign-in, another answer, or the Worker's handling.
export function noCredentialsVerdict(outcome: Outcome, site: Site): { verdict: Verdict; observed: string } {
  const handled = handledByWorker(outcome, site);
  if (handled !== null) {
    return handled;
  }
  if (outcome.status === null) {
    return { verdict: "unexercised", observed: describe(outcome, site) };
  }
  if (outcome.status === 302 && teamSignIn(outcome.headers["location"], site)) {
    return { verdict: "pass", observed: `Access's sign-in redirect: ${describe(outcome, site)}` };
  }
  return {
    verdict: "unattributed",
    observed:
      outcome.status === 401 || outcome.status === 403
        ? `denied, not by the Worker; Access's logs attribute it: ${describe(outcome, site)}`
        : `neither the team's sign-in nor the Worker; Access's logs attribute it: ${describe(outcome, site)}`,
  };
}

// E2's verdict for the known Client ID with a wrong secret: strict mode's 401 or 403, which only Access's logs
// attribute; a redirect to the sign-in says the presented token was taken for none (strict mode off).
export function wrongSecretVerdict(outcome: Outcome, site: Site): { verdict: Verdict; observed: string } {
  const handled = handledByWorker(outcome, site);
  if (handled !== null) {
    return handled;
  }
  if (outcome.status === null) {
    return { verdict: "unexercised", observed: describe(outcome, site) };
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return {
      verdict: "unattributed",
      observed: `strict mode's denial; find this request in Access's logs: ${describe(outcome, site)}`,
    };
  }
  if (teamSignIn(outcome.headers["location"], site)) {
    return {
      verdict: "fail",
      observed: `redirected to the sign-in, not refused (strict mode off?): ${describe(outcome, site)}`,
    };
  }
  return { verdict: "fail", observed: `expected 401 or 403: ${describe(outcome, site)}` };
}

// E2's verdict for a random Client ID: the answer as it came, failing only when the Worker handled the request.
function randomIdVerdict(outcome: Outcome, site: Site): { verdict: Verdict; observed: string } {
  const handled = handledByWorker(outcome, site);
  if (handled !== null) {
    return handled;
  }
  return outcome.status === null
    ? { verdict: "unexercised", observed: describe(outcome, site) }
    : { verdict: "unattributed", observed: `not by the Worker: ${describe(outcome, site)}` };
}

function observe(
  report: Report,
  site: Site,
  entry: { id: string; what: string; path: string },
  outcome: Outcome,
  { verdict, observed }: { verdict: Verdict; observed: string },
): void {
  const location = recordedLocation(outcome.headers["location"], site);
  report.add({
    id: entry.id,
    what: entry.what,
    verdict,
    observed,
    evidence: {
      ...correlation(entry.path, { at: outcome.at, status: outcome.status ?? 0, headers: outcome.headers }),
      ...(location === undefined ? {} : { location }),
    },
  });
}

// --- E7: the static assets ---

type HeaderRule = { path: string; set: [string, string][]; detach: string[] };

// The rules of a `_headers` file: each path line with its header lines (`Name: value`, or `! Name` to drop a header an
// earlier rule set). Only exact paths and `/*` are read: the build generates nothing else, and a check that matched
// another pattern its own way could pass what the platform applies differently.
export function headerRules(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    if (!/^\s/.test(line)) {
      const path = line.trim();
      if (path !== "/*" && /[*:]/.test(path)) {
        throw new CheckError(`_headers has a rule this check does not read: ${path}`);
      }
      rules.push({ path, set: [], detach: [] });
      continue;
    }
    const rule = rules.at(-1);
    if (rule === undefined) {
      throw new CheckError("_headers has a header line before any path");
    }
    const header = line.trim();
    if (header.startsWith("!")) {
      rule.detach.push(header.slice(1).trim().toLowerCase());
      continue;
    }
    const colon = header.indexOf(":");
    if (colon <= 0) {
      throw new CheckError(`_headers has a line this check does not read: ${header}`);
    }
    rule.set.push([header.slice(0, colon).trim().toLowerCase(), header.slice(colon + 1).trim()]);
  }
  return rules;
}

// The headers the rules give a path, applied in order.
export function expectedHeaders(rules: readonly HeaderRule[], path: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rule of rules) {
    if (rule.path !== "/*" && rule.path !== path) {
      continue;
    }
    for (const name of rule.detach) {
      delete headers[name];
    }
    for (const [name, value] of rule.set) {
      headers[name] = value;
    }
  }
  return headers;
}

// The expected headers the answer lacks or holds otherwise, by name and the build's value; the answer's own value is
// not quoted.
export function headerMismatches(expected: Record<string, string>, actual: Record<string, string>): string[] {
  return Object.entries(expected)
    .filter(([name, value]) => actual[name] !== value)
    .map(([name, value]) =>
      actual[name] === undefined ? `no ${name} (expected ${value})` : `another ${name} (expected ${value})`,
    );
}

// The tag's build: its shell, the files it emitted under assets/, the root files besides the shell and the rules.
export type ClientBuild = {
  shell: Buffer;
  assets: { path: string; bytes: Buffer }[];
  rootFiles: { path: string; bytes: Buffer }[];
  rules: HeaderRule[];
};

export async function readClientBuild(dir: string): Promise<ClientBuild> {
  const assets = await Promise.all(
    (await readdir(join(dir, "assets"), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map(async (entry) => ({
        path: `/assets/${entry.name}`,
        bytes: await readFile(join(dir, "assets", entry.name)),
      })),
  );
  const rootFiles = await Promise.all(
    (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name !== "index.html" && entry.name !== "_headers")
      .map(async (entry) => ({ path: `/${entry.name}`, bytes: await readFile(join(dir, entry.name)) })),
  );
  if (assets.length === 0) {
    throw new CheckError("the web UI's build emitted no assets");
  }
  return {
    shell: await readFile(join(dir, "index.html")),
    assets: assets.toSorted((a, b) => a.path.localeCompare(b.path)),
    rootFiles: rootFiles.toSorted((a, b) => a.path.localeCompare(b.path)),
    rules: headerRules(await readFile(join(dir, "_headers"), "utf8")),
  };
}

// A static answer against what the build says it is: its status, bytes and headers.
function staticVerdict(
  answer: Answer,
  bytes: Buffer,
  expected: Record<string, string>,
  extra: string[] = [],
): { verdict: Verdict; observed: string } {
  const problems = [
    ...(answer.status === 200 ? [] : [`HTTP ${answer.status}`]),
    ...(answer.body.equals(bytes) ? [] : [`${answer.body.length} bytes, not the build's ${bytes.length}`]),
    ...headerMismatches(expected, answer.headers),
    ...extra,
  ];
  return problems.length === 0
    ? { verdict: "pass", observed: `200, the build's ${bytes.length} bytes and headers` }
    : { verdict: "fail", observed: problems.join("; ") };
}

function html(answer: Answer): string[] {
  return answer.headers["content-type"]?.startsWith("text/html") === true ? [] : ["not text/html"];
}

// --- E5, E9: the long poll ---

// How long the edge check's polls wait and what it allows around their deadline. The deployment's are the Hub's own
// (WAIT_MAX_MS, 25 s); the check's tests run shorter polls against the local Worker.
export type EdgePace = {
  // A poll's deadline, asked for as the wait's timeoutMs.
  waitMs: number;
  // How far from the deadline an ending counts as near it: the edge's latency before, the request's round trip after.
  nearBeforeMs: number;
  nearAfterMs: number;
  // How often /api/agents is read while a poll's waiting is watched, and how long it may take to show.
  watchMs: number;
  shownMs: number;
  // E9: the departure reaches the Hub within this of the abort, and this long before the poll's deadline.
  departureMs: number;
  beforeDeadlineMs: number;
  // E5's prq wait --timeout, in seconds (above one poll, so that it polls twice).
  cliWaitSeconds: number;
};

export const EDGE_PACE: EdgePace = {
  waitMs: 25_000,
  nearBeforeMs: 2_000,
  nearAfterMs: 4_000,
  watchMs: 250,
  shownMs: 10_000,
  departureMs: 5_000,
  beforeDeadlineMs: 10_000,
  cliWaitSeconds: 40,
};

// A raw poll: when it started, whether it has ended, and when; whether an answer had begun (any byte of it came) by the
// time the check aborted it, with the last status line parsed by then.
type Poll = {
  started: number;
  at: string;
  ended: Promise<{ answer: Answer | Error; endedAt: number }>;
  begun: boolean;
  status: number | null;
  abortedAt: number | null;
  begunBeforeAbort: { status: number | null } | null;
  abort(): void;
};

function startPoll(origin: Origin, agentId: string, pace: EdgePace, signal: AbortSignal): Poll {
  const own = new AbortController();
  const poll: Poll = {
    started: performance.now(),
    at: new Date().toISOString(),
    ended: Promise.resolve({ answer: new Error("not started"), endedAt: 0 }),
    begun: false,
    status: null,
    abortedAt: null,
    begunBeforeAbort: null,
    abort() {
      if (poll.abortedAt === null) {
        poll.abortedAt = performance.now();
        poll.begunBeforeAbort = poll.begun ? { status: poll.status } : null;
      }
      own.abort(new DOMException("the check left the poll", "AbortError"));
    },
  };
  poll.ended = send(origin, "/cli/wait", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, timeoutMs: pace.waitMs }),
    timeoutMs: pace.waitMs + 15_000,
    signal: AbortSignal.any([own.signal, signal]),
    onBytes: () => {
      poll.begun = true;
    },
    onStatus: (status) => {
      poll.status = status;
    },
  })
    .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
    .then((answer) => ({ answer, endedAt: performance.now() }));
  return poll;
}

// E5's verdict on one raw poll: 200 timeout near the deadline, with the tag as Prq-Version.
export function pollVerdict(
  answer: Answer | Error,
  elapsedMs: number,
  version: string,
  pace: EdgePace,
): { verdict: Verdict; observed: string } {
  if (answer instanceof Error) {
    return { verdict: "fail", observed: `no answer (${errorKind(answer)})` };
  }
  const result = v.safeParse(WaitResponse, jsonOf(answer));
  const seconds = inSeconds(elapsedMs);
  if (answer.status === 200 && result.success && result.output.status === "ready") {
    return {
      verdict: "unexercised",
      observed: `answered ready after ${seconds}: a job waits for a local agent, so the poll was not held`,
    };
  }
  const problems = [
    ...(answer.status === 200 ? [] : [`HTTP ${answer.status}`]),
    ...(result.success && result.output.status === "timeout" ? [] : ["not a timeout answer"]),
    ...(near(elapsedMs, pace) ? [] : [`ended after ${seconds}, not near ${inSeconds(pace.waitMs)}`]),
    ...(answer.headers["prq-version"] === version ? [] : [`Prq-Version ${versionOf(answer.headers["prq-version"])}`]),
  ];
  return problems.length === 0
    ? { verdict: "pass", observed: `200 timeout after ${seconds}, Prq-Version ${version}` }
    : { verdict: "fail", observed: problems.join("; ") };
}

function near(elapsedMs: number, pace: EdgePace): boolean {
  return elapsedMs >= pace.waitMs - pace.nearBeforeMs && elapsedMs <= pace.waitMs + pace.nearAfterMs;
}

// When each watched agent was seen waiting, then seen no longer waiting (ms on performance.now()).
type Watched = Map<string, { waitingAt: number | null; stoppedAt: number | null }>;

// Reads /api/agents until every agent has been seen waiting and then not, until one has not shown within shownMs, or
// until untilMs; calls onWaiting once per agent at the read that first shows it waiting. A read that ends after the
// watch's end does not count.
async function watchAgents(
  origin: Origin,
  agentIds: readonly string[],
  { untilMs, pace }: { untilMs: number; pace: EdgePace },
  onWaiting: (agentId: string) => void,
  signal: AbortSignal,
): Promise<Watched> {
  const watched: Watched = new Map(agentIds.map((id) => [id, { waitingAt: null, stoppedAt: null }]));
  const started = performance.now();
  const end = AbortSignal.any([signal, AbortSignal.timeout(untilMs)]);
  while (!end.aborted) {
    const rows = await agentRows(origin, end).catch(() => null);
    signal.throwIfAborted();
    const now = performance.now();
    if (rows !== null && now - started <= untilMs) {
      for (const [agentId, seen] of watched) {
        const waiting = rows.find((row) => row.agentId === agentId)?.waiting === true;
        if (waiting && seen.waitingAt === null) {
          seen.waitingAt = now;
          onWaiting(agentId);
        } else if (!waiting && seen.waitingAt !== null && seen.stoppedAt === null) {
          seen.stoppedAt = now;
        }
      }
    }
    const shownLate = [...watched.values()].some((seen) => seen.waitingAt === null && now - started > pace.shownMs);
    if (shownLate || [...watched.values()].every((seen) => seen.stoppedAt !== null)) {
      return watched;
    }
    await sleep(pace.watchMs, undefined, { signal: end }).catch(() => undefined);
  }
  signal.throwIfAborted();
  return watched;
}

function inSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

// How a raw poll ended: a timeout answer, a ready one, or anything else (described).
function pollEnding(answer: Answer | Error): string {
  if (answer instanceof Error) {
    return `no answer (${errorKind(answer)})`;
  }
  const result = v.safeParse(WaitResponse, jsonOf(answer));
  return answer.status === 200 && result.success ? result.output.status : `HTTP ${answer.status}`;
}

export type KeptPoll = { started: number; waitingAt: number | null; stoppedAt: number | null; ending: string };
// begunBeforeAbort: an answer had begun to come (any byte of it) when the check aborted the poll, with the last status
// line parsed by then; null when none had.
export type CutPoll = KeptPoll & {
  abortedAt: number | null;
  begunBeforeAbort: { status: number | null } | null;
  endedByAbort: boolean;
};

// E9's verdicts: the kept poll left to its deadline (the control), the cut one aborted once waiting. The departure is
// credited only when no answer had begun before the abort, the abort ended the poll, and the control passed.
export function departureVerdicts(
  keep: KeptPoll,
  cut: CutPoll,
  pace: EdgePace,
): { keep: { verdict: Verdict; observed: string }; cut: { verdict: Verdict; observed: string } } {
  const keepVerdict = ((): { verdict: Verdict; observed: string } => {
    if (keep.ending === "ready") {
      return { verdict: "unexercised", observed: "answered ready: a job waits for a local agent" };
    }
    if (keep.waitingAt === null) {
      return { verdict: "fail", observed: `never listed waiting in /api/agents within ${inSeconds(pace.shownMs)}` };
    }
    if (keep.stoppedAt === null) {
      return { verdict: "fail", observed: "still listed waiting when the watch ended" };
    }
    const after = keep.stoppedAt - keep.started;
    const problems = [
      ...(keep.ending === "timeout" ? [] : [`it ended with ${keep.ending}, not a timeout answer`]),
      ...(near(after, pace) ? [] : [`not near its ${inSeconds(pace.waitMs)} deadline`]),
    ];
    return {
      verdict: problems.length === 0 ? "pass" : "fail",
      observed: `waiting from ${inSeconds(keep.waitingAt - keep.started)}, stopped at ${inSeconds(after)} after its start${problems.length === 0 ? ", answered timeout" : `: ${problems.join("; ")}`}`,
    };
  })();
  const cutVerdict = ((): { verdict: Verdict; observed: string } => {
    if (cut.ending === "ready") {
      return { verdict: "unexercised", observed: "answered ready: a job waits for a local agent" };
    }
    if (cut.waitingAt === null || cut.abortedAt === null) {
      return { verdict: "fail", observed: `never listed waiting in /api/agents within ${inSeconds(pace.shownMs)}` };
    }
    if (cut.begunBeforeAbort !== null) {
      const { status } = cut.begunBeforeAbort;
      return {
        verdict: "fail",
        observed: `an answer (${status === null ? "its first bytes" : `HTTP ${status}`}) had begun before the abort: no departure to observe`,
      };
    }
    if (!cut.endedByAbort) {
      return { verdict: "fail", observed: `it ended with ${cut.ending}, not by the abort` };
    }
    if (cut.stoppedAt === null) {
      return { verdict: "fail", observed: "still listed waiting when the watch ended" };
    }
    const afterAbort = cut.stoppedAt - cut.abortedAt;
    const beforeDeadline = cut.started + pace.waitMs - cut.stoppedAt;
    const ok = afterAbort <= pace.departureMs && beforeDeadline >= pace.beforeDeadlineMs;
    return {
      verdict: ok ? "pass" : "fail",
      observed: `aborted at ${inSeconds(cut.abortedAt - cut.started)}, stopped waiting ${inSeconds(afterAbort)} later, ${inSeconds(beforeDeadline)} before its deadline${ok ? "" : ` (expected within ${inSeconds(pace.departureMs)} of the abort and at least ${inSeconds(pace.beforeDeadlineMs)} before the deadline)`}`,
    };
  })();
  if (cutVerdict.verdict === "pass" && keepVerdict.verdict !== "pass") {
    return {
      keep: keepVerdict,
      cut: {
        verdict: "unexercised",
        observed: `${cutVerdict.observed}, not credited: the poll left to its deadline did not pass`,
      },
    };
  }
  return { keep: keepVerdict, cut: cutVerdict };
}

// --- The edge check ---

// The deployment's URL and service token (the CLI's configuration).
export type PrqConfig = { url: string; clientId: string; clientSecret: string };

export type EdgeOptions = {
  config: PrqConfig;
  // The Access team domain the sign-in redirect must lead to (https://<team>.cloudflareaccess.com).
  teamDomain: string;
  // The tag the deployment and this checkout are at: v + the CLI's version.
  version: string;
  // The tag's web UI build (packages/server/dist/client).
  clientDir: string;
  // Runs the prq binary built from this checkout with the deployment's configuration, these overrides and args.
  prq: (args: readonly string[], env: Readonly<Record<string, string>>) => Running;
  // A session to add to E1 and E2's WebSocket samples.
  pr?: PrRef;
  pace: EdgePace;
  signal: AbortSignal;
};

export async function checkEdge(options: EdgeOptions, report: Report): Promise<void> {
  const { config, version, signal } = options;
  const origin = serviceOrigin(config.url, config);
  const site: Site = { origin: config.url, teamDomain: options.teamDomain };
  const build = await readClientBuild(options.clientDir);
  const assetPath = build.assets.find((asset) => asset.path.endsWith(".js"))?.path ?? build.assets[0]?.path ?? "/";
  const wrongSecret = randomBytes(32).toString("hex");

  await checkDenials(options, site, assetPath, wrongSecret, report);
  await checkWebhook(serviceOrigin(config.url, null), site, report, signal);
  await checkLedger(origin, report, signal);
  await checkAssets(origin, build, report, signal);
  await checkHubSocket(origin, version, report, signal);
  await checkWrongSecretCli(options, wrongSecret, report);
  report.note(`E5 and E9: long polls through the edge (about ${inSeconds(options.pace.cliWaitSeconds * 1000)})`);
  // The two run together; either one's failure ends the other's polls and prq run.
  const stage = new AbortController();
  const stageSignal = AbortSignal.any([signal, stage.signal]);
  const failing = (error: unknown) => {
    stage.abort(error);
    throw error;
  };
  const [poll, departure] = await Promise.allSettled([
    checkLongPoll(options, origin, stageSignal).catch(failing),
    checkDeparture(origin, options.pace, stageSignal).catch(failing),
  ]);
  for (const result of [poll, departure]) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
  for (const observation of [
    ...(poll.status === "fulfilled" ? poll.value : []),
    ...(departure.status === "fulfilled" ? departure.value : []),
  ]) {
    report.add(observation);
  }
}

// E1 and E2: each sample with no credentials, then with the known Client ID and a wrong secret; one with a random ID.
async function checkDenials(
  { config, pr, signal }: Pick<EdgeOptions, "config" | "pr" | "signal">,
  site: Site,
  assetPath: string,
  wrongSecret: string,
  report: Report,
): Promise<void> {
  report.note("E1: no credentials");
  const anonymous = serviceOrigin(config.url, null);
  for (const entry of samples(assetPath, pr)) {
    const outcome = await sample(anonymous, entry, signal);
    observe(report, site, { id: "E1", ...entry }, outcome, noCredentialsVerdict(outcome, site));
  }
  report.note("E2: the known Client ID with a wrong secret, then a random Client ID");
  const known = serviceOrigin(config.url, { clientId: config.clientId, clientSecret: wrongSecret });
  for (const entry of samples(assetPath, pr)) {
    const outcome = await sample(known, entry, signal);
    observe(
      report,
      site,
      { id: "E2", what: `${entry.what} (known ID)`, path: entry.path },
      outcome,
      wrongSecretVerdict(outcome, site),
    );
  }
  const randomId = serviceOrigin(config.url, {
    clientId: `${randomBytes(16).toString("hex")}.access`,
    clientSecret: wrongSecret,
  });
  const ledger = samples(assetPath, pr).find((entry) => entry.path === "/api/ledger");
  if (ledger !== undefined) {
    const outcome = await sample(randomId, ledger, signal);
    observe(
      report,
      site,
      { id: "E2", what: `${ledger.what} (random ID)`, path: ledger.path },
      outcome,
      randomIdVerdict(outcome, site),
    );
  }
}

// E3: the webhook bypass reaches the Worker's signature check, and a path under it the Worker's JWT check.
async function checkWebhook(anonymous: Origin, site: Site, report: Report, signal: AbortSignal): Promise<void> {
  const post = await send(anonymous, "/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": randomUUID(),
    },
    body: JSON.stringify({ zen: "prq edge check: no signature" }),
    signal,
  });
  const postError = v.safeParse(ErrorResponse, jsonOf(post));
  const signature = post.status === 401 && postError.success && postError.output.detail === "invalid signature";
  report.add({
    id: "E3",
    what: "POST /webhook without a signature",
    verdict: signature ? "pass" : "fail",
    observed: signature
      ? "the Worker's signature refusal: 401 unauthorized, invalid signature"
      : `expected the Worker's 401 invalid signature: ${describe(fromAnswer(post), site)}`,
    evidence: correlation("/webhook", post),
  });
  const under = await send(anonymous, "/webhook/x", { signal });
  const underError = v.safeParse(ErrorResponse, jsonOf(under));
  const jwt = under.status === 401 && underError.success && underError.output.detail === "missing Access token";
  report.add({
    id: "E3",
    what: "GET /webhook/x",
    verdict: jwt ? "pass" : "fail",
    observed: jwt
      ? "the Worker's own 401: missing Access token"
      : `expected the Worker's 401 missing Access token: ${describe(fromAnswer(under), site)}`,
    evidence: correlation("/webhook/x", under),
  });
}

// E4: the service token passes Access, and Access's token passes the Worker's check.
export async function checkLedger(origin: Origin, report: Report, signal: AbortSignal): Promise<void> {
  const path = "/api/ledger?state=open";
  const answer = await send(origin, path, { signal });
  const page = v.safeParse(LedgerPage, jsonOf(answer));
  const noStore = answer.headers["cache-control"] === "no-store";
  const ok = answer.status === 200 && page.success && noStore;
  report.add({
    id: "E4",
    what: `GET ${path} with the service token`,
    verdict: ok ? "pass" : "fail",
    observed: ok
      ? `200, a ledger page of ${page.output.rows.length} rows, cache-control no-store`
      : [
          `HTTP ${answer.status}`,
          page.success ? "a ledger page" : "not a ledger page",
          answer.headers["cache-control"] === undefined ? "no cache-control" : "a cache-control other than no-store",
        ].join(", "),
    evidence: correlation(path, answer),
  });
}

// The statuses that redirect a navigation.
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// E7: the static assets with the service token.
export async function checkAssets(
  origin: Origin,
  build: ClientBuild,
  report: Report,
  signal: AbortSignal,
): Promise<void> {
  const site: Site = { origin: origin.url };
  let etag: string | undefined;
  for (const path of ["/", "/pr/a/b/1"]) {
    const answer = await send(origin, path, { headers: NAVIGATION, signal });
    etag ??= answer.headers["etag"];
    report.add({
      id: "E7",
      what: `navigation GET ${path}`,
      ...staticVerdict(answer, build.shell, expectedHeaders(build.rules, path), html(answer)),
      evidence: correlation(path, answer),
    });
  }
  for (const file of [...build.assets, ...build.rootFiles]) {
    const answer = await send(origin, file.path, { headers: subresource(file.path), signal });
    report.add({
      id: "E7",
      what: `GET ${file.path}`,
      ...staticVerdict(answer, file.bytes, expectedHeaders(build.rules, file.path)),
      evidence: correlation(file.path, answer),
    });
  }
  if (etag === undefined) {
    report.add({
      id: "E7",
      what: "conditional reload of /",
      verdict: "fail",
      observed: "the shell came without an ETag",
    });
  } else {
    const answer = await send(origin, "/", {
      headers: { ...NAVIGATION, "If-None-Match": etag, "Cache-Control": "max-age=0" },
      signal,
    });
    report.add({
      id: "E7",
      what: "conditional reload of /",
      verdict: answer.status === 304 ? "pass" : "fail",
      observed: answer.status === 304 ? "304 Not Modified" : `HTTP ${answer.status}, expected 304`,
      evidence: correlation("/", answer),
    });
  }
  // A redirect to the origin's own root; one elsewhere would take the browser off the hostname.
  const index = await send(origin, "/index.html", { headers: NAVIGATION, signal });
  const toRoot = REDIRECTS.has(index.status) && recordedLocation(index.headers["location"], site) === "/";
  report.add({
    id: "E7",
    what: "navigation GET /index.html",
    verdict: toRoot ? "pass" : "fail",
    observed: toRoot
      ? `HTTP ${index.status} to /`
      : `expected a redirect to this origin's /: ${describe(fromAnswer(index), site)}`,
    evidence: correlation("/index.html", index),
  });
  // A missing asset gets the shell as the single-page fallback, revalidated like the shell, never an error page.
  const missing = `/assets/prq-missing-${randomBytes(6).toString("hex")}.js`;
  const fallback = await send(origin, missing, { headers: subresource(missing), signal });
  report.add({
    id: "E7",
    what: "GET /assets/prq-missing-<random>.js",
    ...staticVerdict(fallback, build.shell, expectedHeaders(build.rules, missing), html(fallback)),
    evidence: correlation("/assets/prq-missing-<random>.js", fallback),
  });
}

// E8: the Hub's WebSocket with the service token, and its version frame.
async function checkHubSocket(origin: Origin, version: string, report: Report, signal: AbortSignal): Promise<void> {
  const path = "/agents/hub/hub";
  const handshake = await openSocket(origin, path, { signal });
  if (handshake.kind !== "opened") {
    const outcome = fromHandshake(handshake);
    report.add({
      id: "E8",
      what: `WebSocket ${path} with the service token`,
      verdict: "fail",
      observed: `did not open: ${describe(outcome, { origin: origin.url })}`,
      evidence: correlation(path, { at: outcome.at, status: outcome.status ?? 0, headers: outcome.headers }),
    });
    return;
  }
  try {
    const frame = await handshake.socket.next("prq:version", { timeoutMs: 15_000, signal }).catch(() => {
      signal.throwIfAborted();
      return null;
    });
    const sent = frame?.["version"];
    report.add({
      id: "E8",
      what: `WebSocket ${path} with the service token`,
      verdict: sent === version ? "pass" : "fail",
      observed:
        frame === null
          ? "opened, but no prq:version frame came within 15 s"
          : `opened; prq:version ${versionOf(sent)}${sent === version ? "" : `, expected ${version}`}`,
      evidence: correlation(path, { at: handshake.at, status: 101, headers: handshake.headers }),
    });
  } finally {
    await handshake.socket.close();
  }
}

// E6: prq wait with the known Client ID and a wrong secret ends at once, exit 3, with the authentication diagnostic.
async function checkWrongSecretCli(options: EdgeOptions, wrongSecret: string, report: Report): Promise<void> {
  const exit = await options.prq(["wait", "--timeout", "5"], {
    PRQ_ACCESS_CLIENT_SECRET: wrongSecret,
    PRQ_AGENT_ID: "edge-cli",
  }).exited;
  const lines = stderrLines(exit);
  const status = lines
    .map((line) => /authentication failed \(HTTP (\d{3}) from \/cli\/wait\)/.exec(line)?.[1])
    .find((found) => found !== undefined);
  const retried = lines.some((line) => line.includes("retrying"));
  const ok = exit.code === 3 && status !== undefined && !retried && exit.stdout === "";
  report.add({
    id: "E6",
    what: "prq wait --timeout 5 with a wrong secret",
    verdict: ok ? "pass" : "fail",
    observed: ok
      ? `exit 3: authentication failed (HTTP ${status} from /cli/wait)`
      : [
          `exit ${exit.code ?? exit.signal}`,
          status === undefined ? "no authentication diagnostic" : `the authentication diagnostic (HTTP ${status})`,
          retried ? "a retry line" : "no retry line",
          exit.stdout === "" ? "nothing on stdout" : `${Buffer.byteLength(exit.stdout)} bytes on stdout`,
          `${lines.length} stderr lines`,
        ].join("; "),
  });
}

const CliTimeout = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({ status: v.literal("timeout"), next: v.literal("wait") }),
);

// E5: two raw polls with the service token, and prq wait across more than one poll. Each poll is timed from its start
// to its own end.
export async function checkLongPoll(
  options: Pick<EdgeOptions, "pace" | "version" | "prq">,
  origin: Origin,
  signal: AbortSignal,
): Promise<Observation[]> {
  const { pace, version } = options;
  const polls = [startPoll(origin, "edge-poll", pace, signal), startPoll(origin, "edge-poll", pace, signal)];
  const cli = options.prq(["wait", "--timeout", String(pace.cliWaitSeconds)], { PRQ_AGENT_ID: "edge-cli" });
  const stop = () => void cli.kill();
  signal.addEventListener("abort", stop, { once: true });
  try {
    const observations: Observation[] = [];
    for (const [index, poll] of polls.entries()) {
      const { answer, endedAt } = await poll.ended;
      signal.throwIfAborted();
      observations.push({
        id: "E5",
        what: `POST /cli/wait (edge-poll, poll ${index + 1})`,
        ...pollVerdict(answer, endedAt - poll.started, version, pace),
        ...(answer instanceof Error ? {} : { evidence: correlation("/cli/wait", answer) }),
      });
    }
    const exit = await cli.exited;
    signal.throwIfAborted();
    const ok = exit.code === 2 && v.is(CliTimeout, exit.stdout) && exit.stderr === "";
    observations.push({
      id: "E5",
      what: `prq wait --timeout ${pace.cliWaitSeconds} (edge-cli)`,
      verdict: ok ? "pass" : "fail",
      observed: ok
        ? 'exit 2, {"status":"timeout","next":"wait"}, nothing on stderr (no version notice)'
        : [
            `exit ${exit.code ?? exit.signal}`,
            v.is(CliTimeout, exit.stdout) ? "the timeout JSON on stdout" : "no timeout JSON on stdout",
            exit.stderr === "" ? "nothing on stderr" : `${stderrLines(exit).length} stderr lines`,
          ].join("; "),
    });
    return observations;
  } finally {
    signal.removeEventListener("abort", stop);
    for (const poll of polls) {
      poll.abort();
    }
    await Promise.all(polls.map((poll) => poll.ended));
  }
}

// E9: a client's departure from a poll reaches the Hub through the edge, against a poll left to its deadline. The
// pair's agent IDs are this run's own, so that no earlier run's poll is read for them.
export async function checkDeparture(origin: Origin, pace: EdgePace, signal: AbortSignal): Promise<Observation[]> {
  const run = randomBytes(3).toString("hex");
  const keepId = `edge-keep-${run}`;
  const cutId = `edge-cut-${run}`;
  const keep = startPoll(origin, keepId, pace, signal);
  const cut = startPoll(origin, cutId, pace, signal);
  try {
    const watched = await watchAgents(
      origin,
      [keepId, cutId],
      { untilMs: pace.waitMs + pace.shownMs + pace.nearAfterMs, pace },
      (agentId) => {
        if (agentId === cutId) {
          cut.abort();
        }
      },
      signal,
    );
    const [kept, cutEnded] = await Promise.all([keep.ended, cut.ended]);
    signal.throwIfAborted();
    const keepSeen = watched.get(keepId) ?? { waitingAt: null, stoppedAt: null };
    const cutSeen = watched.get(cutId) ?? { waitingAt: null, stoppedAt: null };
    const verdicts = departureVerdicts(
      { started: keep.started, ...keepSeen, ending: pollEnding(kept.answer) },
      {
        started: cut.started,
        ...cutSeen,
        ending: pollEnding(cutEnded.answer),
        abortedAt: cut.abortedAt,
        begunBeforeAbort: cut.begunBeforeAbort,
        endedByAbort:
          cut.abortedAt !== null &&
          cut.begunBeforeAbort === null &&
          cutEnded.answer instanceof Error &&
          cutEnded.answer.name === "AbortError",
      },
      pace,
    );
    return [
      {
        id: "E9",
        what: "POST /cli/wait (edge-keep) left to its deadline",
        ...verdicts.keep,
        evidence: { at: keep.at, path: "/cli/wait", agentId: keepId },
      },
      {
        id: "E9",
        what: "POST /cli/wait (edge-cut) aborted once waiting",
        ...verdicts.cut,
        evidence: { at: cut.at, path: "/cli/wait", agentId: cutId },
      },
    ];
  } finally {
    keep.abort();
    cut.abort();
    await Promise.all([keep.ended, cut.ended]);
  }
}

// --- The check's children ---

// How long a prq run may take past its own --timeout before it is killed.
const PRQ_GRACE_MS = 30_000;
// How long a stopped tool's process group has between SIGTERM and SIGKILL, how long past that the check waits for it to
// end, and how often it looks; how long its stdout may stay open once its group has ended (a process outside the group
// may hold it), and how much of it is kept.
const TOOL_GRACE_MS = 5_000;
const TOOL_END_MS = 5_000;
const TOOL_POLL_MS = 25;
const TOOL_DRAIN_MS = 250;
const TOOL_STDOUT_BYTES = 64 * 1024;

// The variables a tool the check runs (pnpm's build, gh) takes from the caller's environment, by name: where it finds
// its commands and home, the locale and the terminal, XDG's directories, gh's own login and settings and the git
// configuration it reads, the tool versions' managers, a proxy and its certificates. Nothing of the deployment's: only
// the prq runs below are given that, and a proxy's bypass list loses the entries that name it or an Access team.
const TOOL_ENV = [
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TZ)$/,
  /^(LANG|LANGUAGE|LC_[A-Z]+)$/,
  /^(TERM|COLORTERM|NO_COLOR|FORCE_COLOR)$/,
  /^XDG_[A-Z_]+$/,
  /^(GH_[A-Z_]+|GITHUB_TOKEN|GITHUB_ENTERPRISE_TOKEN|GIT_CONFIG_GLOBAL|GIT_CONFIG_NOSYSTEM)$/,
  /^(MISE_[A-Z_]+|PNPM_HOME|COREPACK_HOME|BUN_INSTALL)$/,
  /^(HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/,
];

// A bypass entry naming an Access team's host (<team>.cloudflareaccess.com, perhaps with a leading dot or a port): no
// tool needs it, and a check that is given no team domain (summary's gh) still withholds it.
const ACCESS_TEAM_HOST = /[a-z0-9-]\.cloudflareaccess\.com(?::[0-9]+)?$/i;

function toolEnv(source: NodeJS.ProcessEnv, withheld: readonly string[]): NodeJS.ProcessEnv {
  const hosts = withheld.map((host) => host.toLowerCase()).filter((host) => host !== "");
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !TOOL_ENV.some((allowed) => allowed.test(name))) {
      continue;
    }
    if (name === "NO_PROXY" || name === "no_proxy") {
      const kept = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(
          (entry) =>
            entry !== "" && !ACCESS_TEAM_HOST.test(entry) && !hosts.some((host) => entry.toLowerCase().includes(host)),
        );
      if (kept.length > 0) {
        env[name] = kept.join(",");
      }
      continue;
    }
    env[name] = value;
  }
  return env;
}

export type ToolOptions = {
  cwd?: string;
  timeoutMs: number;
  signal: AbortSignal;
  graceMs?: number;
  // The environment toolEnv picks from; the caller's by default.
  env?: NodeJS.ProcessEnv;
  // The deployment's hostnames (its own, the Access team's), which no variable the tool gets may name.
  withheld?: readonly string[];
  // Whether the tool's stdout is the result (gh's read); otherwise it is discarded (the build's).
  keepStdout?: boolean;
};

// Runs a tool to its end within the bound or until the signal: its stdout when kept (up to TOOL_STDOUT_BYTES; more is an
// error), else ""; its stderr is not kept. It runs in a process group of its own, with toolEnv's environment. The bound,
// the signal and the check's own exit stop the whole group: SIGTERM, then SIGKILL after the grace. Whatever the tool
// leaves in its group when it exits is stopped the same way, and the call returns once the group has ended and its
// stdout has closed, or TOOL_DRAIN_MS after that, within the same deadline. A stopped tool is an error (a TimeoutError,
// the signal's reason, too much output) even if it then exits 0; one that exits otherwise than 0 is an error naming the
// exit.
export async function runTool(
  command: string,
  args: readonly string[],
  {
    cwd,
    timeoutMs,
    signal,
    graceMs = TOOL_GRACE_MS,
    env = process.env,
    withheld = [],
    keepStdout = false,
  }: ToolOptions,
): Promise<string> {
  signal.throwIfAborted();
  const child = spawn(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    env: toolEnv(env, withheld),
    detached: true,
    stdio: ["ignore", keepStdout ? "pipe" : "ignore", "ignore"],
  });
  const { stdout } = child;
  const chunks: Buffer[] = [];
  let kept = 0;
  stdout?.on("data", (chunk: Buffer) => {
    kept += chunk.length;
    if (kept > TOOL_STDOUT_BYTES) {
      stop(new CheckError(`${command} wrote more than ${TOOL_STDOUT_BYTES} bytes`));
      return;
    }
    chunks.push(chunk);
  });
  const drained =
    stdout === null ? Promise.resolve() : new Promise<void>((resolve) => stdout.once("close", () => resolve()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  const group = child.pid;
  const alive = () => {
    if (group === undefined) {
      return false;
    }
    try {
      process.kill(-group, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signalGroup = (name: NodeJS.Signals) => {
    if (group !== undefined) {
      try {
        process.kill(-group, name);
      } catch {
        // The group has ended.
      }
    }
  };
  let escalation: NodeJS.Timeout | undefined;
  const terminate = () => {
    if (escalation === undefined) {
      signalGroup("SIGTERM");
      escalation = setTimeout(() => signalGroup("SIGKILL"), graceMs);
    }
  };
  let stopped: Error | undefined;
  const stop = (reason: Error) => {
    stopped ??= reason;
    terminate();
  };
  const timer = setTimeout(
    () => stop(new DOMException(`${command} did not end within ${timeoutMs} ms`, "TimeoutError")),
    timeoutMs,
  );
  const onAbort = () => stop(signal.reason instanceof Error ? signal.reason : new CheckError("stopped"));
  signal.addEventListener("abort", onAbort, { once: true });
  // The check's own exit (a second Ctrl-C) leaves nothing of the tool running.
  const onExit = () => signalGroup("SIGKILL");
  process.once("exit", onExit);
  try {
    const exit = await exited;
    if (alive()) {
      terminate();
    }
    const deadline = performance.now() + graceMs + TOOL_END_MS;
    while (alive()) {
      if (performance.now() > deadline) {
        throw new CheckError(`${command}'s processes did not end after SIGKILL`);
      }
      await sleep(TOOL_POLL_MS);
    }
    // A process outside the group may still hold stdout: what came by then is the output.
    await Promise.race([drained, sleep(Math.max(0, Math.min(TOOL_DRAIN_MS, deadline - performance.now())))]);
    if (stopped !== undefined) {
      throw stopped;
    }
    if (exit.code !== 0) {
      throw new CheckError(`${command} ${args[0] ?? ""} exited with ${exit.code ?? exit.signal}`);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    stdout?.destroy();
    clearTimeout(timer);
    clearTimeout(escalation);
    signal.removeEventListener("abort", onAbort);
    process.removeListener("exit", onExit);
  }
}

// Runs body with a runner of the prq binary built from this checkout (cli.ts): each run in a HOME made for this call in
// the OS temp directory, with nothing of the caller's environment but PATH, the deployment's configuration and the
// run's overrides. No run starts once the signal has ended the check. A run is killed at its --timeout plus the grace,
// when the signal ends the check, and when body ends however it ends; the HOME is then removed, only while it is still
// the directory made here.
export async function withPrq<T>(
  config: PrqConfig,
  signal: AbortSignal,
  body: (prq: EdgeOptions["prq"], home: string) => Promise<T>,
  graceMs = PRQ_GRACE_MS,
): Promise<T> {
  signal.throwIfAborted();
  const home = await mkdtemp(join(tmpdir(), "prq-deployed-"));
  const running = new Set<Running>();
  const prq = (args: readonly string[], overrides: Readonly<Record<string, string>>): Running => {
    signal.throwIfAborted();
    const started = startCli(
      args,
      {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        PRQ_HOME: join(home, "state"),
        PRQ_URL: config.url,
        PRQ_ACCESS_CLIENT_ID: config.clientId,
        PRQ_ACCESS_CLIENT_SECRET: config.clientSecret,
        ...overrides,
      },
      home,
    );
    running.add(started);
    const timeout = args.indexOf("--timeout");
    const seconds = timeout < 0 ? 0 : Number(args[timeout + 1] ?? 0);
    const timer = setTimeout(() => void started.kill(), seconds * 1000 + graceMs);
    const stop = () => void started.kill();
    signal.addEventListener("abort", stop, { once: true });
    const forget = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      running.delete(started);
    };
    void started.exited.then(forget, forget);
    return started;
  };
  try {
    return await body(prq, home);
  } finally {
    await Promise.all([...running].map((started) => started.kill()));
    const made = await lstat(home).catch(() => null);
    if (made?.isDirectory() === true) {
      await rm(home, { recursive: true, force: true });
    }
  }
}

// --- E10: workers.dev ---

// The workers.dev addresses of the Worker `prq` on the account's subdomain: the production URL, and the version's
// preview URL when a version ID is given (only the bootstrap's Worker can have one: a Worker with Durable Objects has
// no version URLs).
export function workersDevUrls(subdomain: string, version: string | undefined): { what: string; url: string }[] {
  const base = `${subdomain}.workers.dev`;
  return [
    { what: "the production URL", url: `https://prq.${base}/` },
    ...(version === undefined
      ? []
      : [{ what: "the version's preview URL", url: `https://${version.slice(0, 8)}-prq.${base}/` }]),
  ];
}

// The page Cloudflare serves at a workers.dev address with nothing behind it.
const NOTHING_HERE = "There is nothing here yet";

// E10's verdict: prq's answer (the bootstrap's header, a Prq-Version, the Worker's error JSON, the shell) fails;
// Cloudflare's page for an address with nothing behind it passes. Anything else, or no HTTP answer, leaves it
// unexercised: the dashboard's settings decide.
function endpointVerdict(outcome: Outcome, site: Site): { verdict: Verdict; observed: string } {
  if (outcome.status === null) {
    return { verdict: "unexercised", observed: `${describe(outcome, site)}; the dashboard's settings decide` };
  }
  const signs = [
    ...(outcome.headers["x-prq-bootstrap"] === undefined ? [] : ["the bootstrap's x-prq-bootstrap header"]),
    ...workerSigns({ ...outcome, status: null }),
  ];
  if (signs.length > 0) {
    return { verdict: "fail", observed: `prq answered (${signs.join("; ")}): ${describe(outcome, site)}` };
  }
  if (outcome.status === 404 && outcome.body.includes(NOTHING_HERE)) {
    return {
      verdict: "pass",
      observed: `Cloudflare's page for an address with nothing behind it: ${describe(outcome, site)}`,
    };
  }
  return {
    verdict: "unexercised",
    observed: `neither prq nor Cloudflare's page for an address with nothing behind it: ${describe(outcome, site)}; the dashboard's settings decide`,
  };
}

export async function checkEndpoints(
  targets: readonly { what: string; url: string }[],
  report: Report,
  signal: AbortSignal,
): Promise<void> {
  for (const { what, url } of targets) {
    const target = new URL(url);
    const site: Site = { origin: target.origin };
    const outcome = await sample(
      serviceOrigin(target.origin, null),
      { kind: "http", what, path: target.pathname, method: "GET", headers: NAVIGATION },
      signal,
    );
    report.add({
      id: "E10",
      what,
      ...endpointVerdict(outcome, site),
      evidence: { ...correlation(target.pathname, { ...outcome, status: outcome.status ?? 0 }), url },
    });
  }
}
