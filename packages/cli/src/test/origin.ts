// A prq origin as a client reaches it over HTTP and WebSocket, with the headers its front needs: the harness's Access
// token for the local Worker (pr.ts), the service token for a deployment (the deployed checks). It reads what the UI
// reads, through the same routes: the ledger and the present agents, a session's Agent state as its frames carry it,
// its stored conversation as get-messages returns it, raw; and it asks a question and retries a job as the UI does.
//
// HTTP goes through node:http(s) rather than fetch, which sets Sec-Fetch-Mode itself: a navigation must say so. No
// redirect is followed, every request has a bound, and an answer's body is decoded once. A WebSocket goes through ws,
// which gives a refused handshake's HTTP answer (status, headers, body) where Node's own WebSocket gives only an error;
// a socket error is never read as a status. Every call takes the caller's signal, which ends it at once. An error it
// raises in its own words is a CheckError, whose message quotes nothing the origin sent.

import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { buffer } from "node:stream/consumers";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";

import {
  AgentPage,
  type AgentRow,
  type LedgerRow,
  LedgerPage,
  type PrRef,
  PrSessionView,
  sessionName,
} from "@prq/protocol";
import * as v from "valibot";
import { WebSocket } from "ws";

// An error in the check's own words: its message names routes, statuses and bounds, never what an answer held.
export class CheckError extends Error {
  override name = "CheckError";
}

// What kind of error ended a call: its code (ECONNRESET), else its name (TimeoutError), never its message, which may
// quote an address or a child's output.
export function errorKind(error: unknown): string {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) {
    return code;
  }
  return error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "an error";
}

export type Origin = {
  // The origin's URL: http(s)://host[:port].
  url: string;
  // The headers every request carries to get past the front.
  headers(): Promise<Record<string, string>>;
};

// The origin with the service token's headers, or with no credentials.
export function serviceOrigin(url: string, token: { clientId: string; clientSecret: string } | null): Origin {
  const headers: Record<string, string> =
    token === null ? {} : { "CF-Access-Client-Id": token.clientId, "CF-Access-Client-Secret": token.clientSecret };
  return { url, headers: () => Promise.resolve(headers) };
}

// An HTTP answer: when the request was sent (ISO), its status and headers (names in lower case, repeated values joined)
// and its decoded body.
export type Answer = {
  at: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

const REQUEST_MS = 30_000;
// The most of a body a refused handshake's answer keeps.
const DENIAL_BODY_BYTES = 64 * 1024;

function flatHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      flat[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return flat;
}

// The body as sent, without its content codings, in the order they were applied.
function decoded(body: Buffer, encoding: string | undefined): Buffer {
  const codings = (encoding ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity");
  return codings.toReversed().reduce((bytes, coding) => {
    switch (coding) {
      case "gzip":
      case "x-gzip":
        return gunzipSync(bytes);
      case "deflate":
        return inflateSync(bytes);
      case "br":
        return brotliDecompressSync(bytes);
      case "zstd":
        return zstdDecompressSync(bytes);
      default:
        throw new CheckError("the answer has a content coding this check does not read");
    }
  }, body);
}

export type SendOptions = {
  method?: string;
  // Headers besides the front's, replacing any of the same name.
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  // Called with each status line the answer's head is parsed with: an informational one (103), then the final one.
  onStatus?: (status: number) => void;
  // Called once, when the first byte of an answer comes on the connection, before any of it is parsed.
  onBytes?: () => void;
};

// One HTTP request to the origin: its answer, or a rejection when it had none within the bound (a TimeoutError) or the
// signal ended it (the signal's reason). Redirects are answers.
export async function send(origin: Origin, path: string, options: SendOptions = {}): Promise<Answer> {
  const { method = "GET", body, timeoutMs = REQUEST_MS, signal: caller } = options;
  caller?.throwIfAborted();
  const url = new URL(path, origin.url);
  const headers: Record<string, string> = { "Accept-Encoding": "identity", ...(await origin.headers()) };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    for (const existing of Object.keys(headers).filter((key) => key.toLowerCase() === name.toLowerCase())) {
      delete headers[existing];
    }
    headers[name] = value;
  }
  if (body !== undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }
  const bound = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([bound, ...(caller === undefined ? [] : [caller])]);
  const at = new Date();
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  let response: IncomingMessage;
  let raw: Buffer;
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(url, { method, headers, signal }, (answer) => {
        options.onStatus?.(answer.statusCode ?? 0);
        resolve(answer);
      });
      req.on("information", (info) => options.onStatus?.(info.statusCode));
      const { onBytes } = options;
      if (onBytes !== undefined) {
        // The connection may carry later requests: its listener goes with this one.
        req.once("socket", (socket) => {
          socket.once("data", onBytes);
          req.once("close", () => socket.off("data", onBytes));
        });
      }
      req.once("error", reject);
      req.end(body);
    });
    raw = await buffer(response);
  } catch (error) {
    caller?.throwIfAborted();
    if (bound.aborted) {
      throw new DOMException(`no answer within ${timeoutMs} ms`, "TimeoutError");
    }
    throw error;
  }
  return {
    at: at.toISOString(),
    status: response.statusCode ?? 0,
    headers: flatHeaders(response.headers),
    body: decoded(raw, response.headers["content-encoding"]),
  };
}

// The body as JSON, or undefined when it is not.
export function jsonOf(answer: Answer): unknown {
  return parseJson(answer.body.toString("utf8"));
}

// A GET whose 200 answer is parsed with the schema; any other answer is an error naming its status.
async function getParsed<S extends v.GenericSchema>(
  origin: Origin,
  path: string,
  schema: S,
  signal: AbortSignal | undefined,
): Promise<v.InferOutput<S>> {
  const answer = await send(origin, path, signal === undefined ? {} : { signal });
  const route = path.split("?")[0] ?? path;
  if (answer.status !== 200) {
    throw new CheckError(`GET ${route} answered ${answer.status}`);
  }
  const parsed = v.safeParse(schema, jsonOf(answer));
  if (!parsed.success) {
    throw new CheckError(`GET ${route} answered 200 with a body that is not its page`);
  }
  return parsed.output;
}

// The most pages a read follows.
const MAX_PAGES = 100;

// Every page of a paged read, following nextCursor.
async function allPages<R>(
  read: (cursor: string | null) => Promise<{ rows: R[]; nextCursor: string | null }>,
  what: string,
): Promise<R[]> {
  const rows: R[] = [];
  let cursor: string | null = null;
  for (let count = 0; count < MAX_PAGES; count += 1) {
    const page = await read(cursor);
    rows.push(...page.rows);
    if (page.nextCursor === null) {
      return rows;
    }
    cursor = page.nextCursor;
  }
  throw new CheckError(`${what} has more than ${MAX_PAGES} pages`);
}

// The ledger's rows under these filters (GET /api/ledger), every page.
export function ledgerRows(
  origin: Origin,
  filters: { state?: "open" | "all"; repo?: string } = {},
  signal?: AbortSignal,
): Promise<LedgerRow[]> {
  return allPages(async (cursor) => {
    const query = new URLSearchParams();
    if (cursor !== null) {
      query.set("cursor", cursor);
    }
    if (filters.state !== undefined) {
      query.set("state", filters.state);
    }
    if (filters.repo !== undefined) {
      query.set("repo", filters.repo);
    }
    return getParsed(origin, `/api/ledger?${query.toString()}`, LedgerPage, signal);
  }, "the ledger");
}

// The present agents (GET /api/agents), every page.
export function agentRows(origin: Origin, signal?: AbortSignal): Promise<AgentRow[]> {
  return allPages(
    (cursor) =>
      getParsed(
        origin,
        `/api/agents${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
        AgentPage,
        signal,
      ),
    "the agent list",
  );
}

// A session's path under /agents.
export function sessionPath(pr: PrRef): string {
  return `/agents/pr-session/${sessionName(pr)}`;
}

// The session's stored conversation as the UI loads it (get-messages), raw.
export async function readMessages(origin: Origin, pr: PrRef, signal?: AbortSignal): Promise<unknown> {
  const answer = await send(origin, `${sessionPath(pr)}/get-messages`, signal === undefined ? {} : { signal });
  if (answer.status !== 200) {
    throw new CheckError(`get-messages answered ${answer.status}`);
  }
  return jsonOf(answer);
}

// The host's retry of a job from the revision it was read at (POST .../jobs/:jobId/retry): the route's answer.
export function postRetry(
  origin: Origin,
  pr: PrRef,
  jobId: string,
  expectedRev: number,
  signal?: AbortSignal,
): Promise<Answer> {
  return send(origin, `/api/pr/${pr.owner}/${pr.repo}/${pr.number}/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRev }),
    ...(signal === undefined ? {} : { signal }),
  });
}

// --- WebSockets ---

// A frame the server sent: a JSON object with a type.
type Frame = { type: string } & Record<string, unknown>;

const FrameShape = v.looseObject({ type: v.string() });

// An open WebSocket and the frames it received, in order.
class AgentSocket {
  readonly #socket: WebSocket;
  readonly frames: Frame[] = [];
  readonly #waiters = new Set<() => void>();
  #closed = false;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data, binary) => {
      if (binary) {
        return;
      }
      const text = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      const parsed = v.safeParse(FrameShape, parseJson(text.toString("utf8")));
      if (parsed.success) {
        this.frames.push(parsed.output);
        this.#notify();
      }
    });
    socket.once("close", () => {
      this.#closed = true;
      this.#notify();
    });
    // An error after the switch ends the socket; its close ends every wait.
    socket.on("error", () => socket.terminate());
  }

  #notify(): void {
    for (const waiter of this.#waiters) {
      waiter();
    }
  }

  // The first frame of the type the predicate holds for, received or to come; rejects once the bound passes, the socket
  // closes without one, or the signal ends the wait (with its reason).
  next(
    type: string,
    {
      timeoutMs = REQUEST_MS,
      signal,
      holds = () => true,
    }: { timeoutMs?: number; signal?: AbortSignal; holds?: (frame: Frame) => boolean } = {},
  ): Promise<Frame> {
    const { promise, resolve, reject } = Promise.withResolvers<Frame>();
    const check = () => {
      const found = this.frames.find((frame) => frame.type === type && holds(frame));
      if (found !== undefined) {
        done();
        resolve(found);
      } else if (this.#closed) {
        done();
        reject(new CheckError(`the socket closed before a ${type} frame`));
      }
    };
    const stopped = () => {
      done();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      done();
      reject(new CheckError(`no ${type} frame within ${timeoutMs} ms`));
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      this.#waiters.delete(check);
      signal?.removeEventListener("abort", stopped);
    };
    if (signal?.aborted === true) {
      stopped();
      return promise;
    }
    signal?.addEventListener("abort", stopped, { once: true });
    this.#waiters.add(check);
    check();
    return promise;
  }

  send(frame: unknown): void {
    this.#socket.send(JSON.stringify(frame));
  }

  // Closes the socket, and ends it outright if the close is not done within waitMs.
  async close(waitMs = 1000): Promise<void> {
    if (this.#closed) {
      return;
    }
    const closed = new Promise<void>((resolve) => this.#socket.once("close", () => resolve()));
    this.#socket.close();
    const timer = setTimeout(() => this.#socket.terminate(), waitMs);
    await closed;
    clearTimeout(timer);
  }
}

// How a WebSocket handshake ended: switched protocols (the socket, with the 101's headers), refused with an HTTP answer,
// or failed without one: the bound, in the reason's words, or a network error, its cause.
export type Handshake =
  | { kind: "opened"; at: string; headers: Record<string, string>; socket: AgentSocket }
  | { kind: "refused"; at: string; status: number; headers: Record<string, string>; body: string }
  | { kind: "failed"; at: string; reason: string; cause?: Error };

// A WebSocket handshake to the origin's path (ws: or wss: as the origin is http: or https:), with the front's headers.
// The bound covers a refused handshake's answer too: its body is kept up to DENIAL_BODY_BYTES, as far as it came by
// then. The signal ends the handshake at once, rejecting with its reason.
export async function openSocket(
  origin: Origin,
  path: string,
  { timeoutMs = REQUEST_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Handshake> {
  signal?.throwIfAborted();
  const url = new URL(path, origin.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const headers = await origin.headers();
  const at = new Date().toISOString();
  const bound = AbortSignal.timeout(timeoutMs);
  const stop = AbortSignal.any([bound, ...(signal === undefined ? [] : [signal])]);
  const socket = new WebSocket(url, { headers, followRedirects: false });
  // The frames sent right after the switch are kept from the start.
  const opened = new AgentSocket(socket);
  const { promise, resolve, reject } = Promise.withResolvers<Handshake>();
  let denial: IncomingMessage | null = null;
  const stopped = () => {
    if (denial !== null) {
      // The refused answer's read ends where it is; what it kept is still the answer.
      denial.destroy();
      return;
    }
    socket.terminate();
    if (signal?.aborted === true) {
      reject(signal.reason);
    } else {
      resolve({ kind: "failed", at, reason: `no answer within ${timeoutMs} ms` });
    }
  };
  stop.addEventListener("abort", stopped, { once: true });
  let upgraded: Record<string, string> = {};
  socket.once("upgrade", (response) => {
    upgraded = flatHeaders(response.headers);
  });
  socket.once("open", () => resolve({ kind: "opened", at, headers: upgraded, socket: opened }));
  socket.once("unexpected-response", (req, response) => {
    denial = response;
    void (async () => {
      const kept: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of response) {
          if (Buffer.isBuffer(chunk)) {
            kept.push(chunk);
            size += chunk.length;
          }
          if (size >= DENIAL_BODY_BYTES) {
            break;
          }
        }
      } catch {
        // The answer broke off, or the bound ended its read: what arrived is kept.
      }
      response.destroy();
      req.destroy();
      socket.terminate();
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      resolve({
        kind: "refused",
        at,
        status: response.statusCode ?? 0,
        headers: flatHeaders(response.headers),
        body: decodedText(Buffer.concat(kept).subarray(0, DENIAL_BODY_BYTES), response.headers),
      });
    })();
  });
  // Before the switch, the first error ends the handshake; a later one changes nothing.
  socket.on("error", (error) => {
    socket.terminate();
    resolve({ kind: "failed", at, reason: error.message, cause: error });
  });
  try {
    return await promise;
  } finally {
    stop.removeEventListener("abort", stopped);
  }
}

function decodedText(body: Buffer, headers: IncomingHttpHeaders): string {
  try {
    return decoded(body, headers["content-encoding"]).toString("utf8");
  } catch {
    return body.toString("utf8");
  }
}

// Runs use on the session's WebSocket, opened with the origin's headers, within one bound for the handshake and use;
// the socket is closed after, within what is left of the bound (a second at most).
async function withSessionSocket<T>(
  origin: Origin,
  pr: PrRef,
  { timeoutMs = REQUEST_MS, signal }: { timeoutMs?: number; signal?: AbortSignal },
  use: (socket: AgentSocket, wait: { timeoutMs: number; signal?: AbortSignal }) => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  const left = () => Math.max(0, Math.round(deadline - performance.now()));
  const handshake = await openSocket(origin, sessionPath(pr), {
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  });
  if (handshake.kind !== "opened") {
    throw new CheckError(`the session's WebSocket did not open: ${describeHandshake(handshake)}`);
  }
  try {
    return await use(handshake.socket, { timeoutMs: left(), ...(signal === undefined ? {} : { signal }) });
  } finally {
    await handshake.socket.close(Math.min(1000, left()));
  }
}

// The session's Agent state as a new connection receives it: its first cf_agent_state frame, as a PrSessionView.
export function sessionState(origin: Origin, pr: PrRef, signal?: AbortSignal): Promise<PrSessionView> {
  return withSessionSocket(origin, pr, signal === undefined ? {} : { signal }, async (socket, wait) =>
    v.parse(PrSessionView, (await socket.next("cf_agent_state", wait))["state"]),
  );
}

// A question as the host asks it in the UI: a chat request over the session's WebSocket. Resolves with the time the
// session acknowledged the request (its done response), which says the question is stored with its job or intake row,
// not that it is answered. One bound covers the handshake and the acknowledgement.
export function sendQuestion(
  origin: Origin,
  pr: PrRef,
  question: { id: string; text: string },
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ acknowledgedAt: string }> {
  return withSessionSocket(origin, pr, options, async (socket, wait) => {
    const request = crypto.randomUUID();
    const messages = [{ id: question.id, role: "user", parts: [{ type: "text", text: question.text }] }];
    const body = JSON.stringify({ messages, trigger: "submit-message" });
    socket.send({ type: "cf_agent_use_chat_request", id: request, init: { method: "POST", body } });
    await socket.next("cf_agent_use_chat_response", {
      ...wait,
      holds: (frame) => frame["id"] === request && frame["done"] === true,
    });
    return { acknowledgedAt: new Date().toISOString() };
  });
}

// A handshake's outcome in a line, in the check's words.
function describeHandshake(handshake: Handshake): string {
  if (handshake.kind === "opened") {
    return "switched protocols";
  }
  return handshake.kind === "refused"
    ? `refused with HTTP ${handshake.status}`
    : `failed without an HTTP answer (${handshake.cause === undefined ? handshake.reason : errorKind(handshake.cause)})`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
