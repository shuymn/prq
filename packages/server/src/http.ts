import { type ErrorCode, type ErrorResponse, PRQ_VERSION_HEADER } from "@prq/protocol";
import type { Context, ErrorHandler, MiddlewareHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as v from "valibot";

import { log } from "./log.ts";
import { SERVER_VERSION } from "./version.ts";
import { WaitTimeout } from "./wait.ts";

// How long a route waits for a call to a Durable Object, the object's start included. Below the edge's 100 s limit
// on a response.
export const ROUTE_CALL_MS = 30_000;

// How a route bounds a call: the call's outcome, or a WaitTimeout once ms has passed (withTimeout in production).
export type CallBound = <T>(call: PromiseLike<T>, ms: number, what: string) => Promise<T>;

const STATUS = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  internal: 500,
  unavailable: 503,
  unknown_job: 404,
  stale_claim: 409,
  target_mismatch: 409,
  not_retryable: 409,
} as const satisfies Record<ErrorCode, ContentfulStatusCode>;

export function errorResponse(c: Context, error: ErrorCode, detail?: string): Response {
  const body: ErrorResponse = detail === undefined ? { error } : { error, detail };
  return c.json(body, STATUS[error]);
}

// The validators' shared hook: a request that does not match its schema gets 400 naming the fields at fault, never
// their values.
export function invalidRequest(result: v.SafeParseResult<v.GenericSchema>, c: Context): Response | undefined {
  if (result.success) {
    return undefined;
  }
  const fields = [...new Set(result.issues.map((issue) => v.getDotPath(issue) ?? "the body"))];
  return errorResponse(c, "bad_request", `invalid ${fields.join(", ")}`);
}

// Sets a header on the response a handler produced. A response from fetch or a Durable Object stub has immutable
// headers, so it is copied first. A WebSocket upgrade passes as it is, without either header: a copy would drop its
// socket. Only /agents/* upgrades; /cli/* never does, so every /cli/* response carries the version.
function setResponseHeader(c: Context, name: string, value: string): void {
  if (c.res.status === 101) {
    return;
  }
  try {
    c.res.headers.set(name, value);
  } catch {
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set(name, value);
  }
}

// Outermost: every response the Worker generates is private and live (docs/design.md, Caching). Hono runs it after
// onError and notFound, so error responses carry it too.
export const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  setResponseHeader(c, "Cache-Control", "no-store");
};

// On /cli/*, mounted before the Access check, so a rejected request carries the version too.
export const prqVersion: MiddlewareHandler = async (c, next) => {
  await next();
  setResponseHeader(c, PRQ_VERSION_HEADER, SERVER_VERSION);
};

export const notFound: NotFoundHandler = (c) => errorResponse(c, "not_found");

// Logs the error's name only: a message can carry a configuration value or request content. Hono's validator throws a
// 400 HTTPException for a body that is not JSON. A route that stopped waiting for a Durable Object answers 503, which
// the caller retries; the call keeps running, and each route says what its late outcome does.
export const onError: ErrorHandler = (error, c) => {
  if (error instanceof HTTPException && error.status === 400) {
    return errorResponse(c, "bad_request", "the body is not JSON");
  }
  if (error instanceof WaitTimeout) {
    log("prq.request.timed_out", { method: c.req.method, path: c.req.path }, "warn");
    return errorResponse(c, "unavailable", "the server did not answer in time; try again");
  }
  log("prq.request.failed", { method: c.req.method, path: c.req.path, error: error.name }, "error");
  return errorResponse(c, "internal");
};
