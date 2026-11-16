import { type ErrorCode, type ErrorResponse, PRQ_VERSION_HEADER } from "@prq/protocol";
import type { Context, ErrorHandler, MiddlewareHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { log } from "./log.ts";
import { SERVER_VERSION } from "./version.ts";

const STATUS = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  internal: 500,
  unavailable: 503,
} as const satisfies Record<ErrorCode, ContentfulStatusCode>;

export function errorResponse(c: Context, error: ErrorCode, detail?: string): Response {
  const body: ErrorResponse = detail === undefined ? { error } : { error, detail };
  return c.json(body, STATUS[error]);
}

// Sets a header on the response a handler produced. A response from fetch or a Durable Object stub has immutable
// headers, so it is copied first. A WebSocket upgrade passes as it is: a copy would drop its socket.
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

export const onError: ErrorHandler = (error, c) => {
  log(
    "prq.request.failed",
    { method: c.req.method, path: c.req.path, error: error.name, message: error.message },
    "error",
  );
  return errorResponse(c, "internal");
};
