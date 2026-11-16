import type { ErrorResponse, ServerVersionMessage } from "@prq/protocol";
import { type Connection, routeAgentRequest } from "agents";
import type { Context } from "hono";

import { errorResponse } from "./http.ts";
import { isRoutedAgent } from "./names.ts";
import { SERVER_VERSION } from "./version.ts";

// Headers the Agents SDK passes from its own router to an instance (startup properties, the outer URL of a sub-agent
// connection, which skips onBeforeSubAgent). A client must not set them.
const INTERNAL_HEADERS = ["x-agents-lifecycle-props", "x-cf-agents-subagent-url"];

// /agents/:binding/:name[/...]: the Agents SDK's HTTP and WebSocket routes, behind Access. Only the Hub named hub and
// PrSessions with a canonical name are reached; any other name is refused before an instance exists. The check runs
// in the SDK's hooks, so it sees the binding and the name exactly as the SDK routes them (not percent-decoded).
export async function routeAgents(c: Context<{ Bindings: Env }>): Promise<Response> {
  let checked = false;
  const guard = (request: Request, route: { className: string; name: string }): Request | Response => {
    checked = true;
    if (!isRoutedAgent(route)) {
      return errorResponse(c, "not_found");
    }
    for (const header of INTERNAL_HEADERS) {
      request.headers.delete(header);
    }
    return request;
  };
  const response = await routeAgentRequest(c.req.raw, c.env, { onBeforeConnect: guard, onBeforeRequest: guard });
  // A path without a name, or with a binding the SDK does not know (its own 400), never reaches the hooks.
  return checked && response !== null ? response : errorResponse(c, "not_found");
}

// Sent on every WebSocket connection, after the SDK's own frames.
export function sendServerVersion(connection: Connection): void {
  const message: ServerVersionMessage = { type: "prq:version", version: SERVER_VERSION };
  connection.send(JSON.stringify(message));
}

// Sub-agents (`/sub/<class>/<name>` below an instance) would create child instances under any name; prq has none.
export function refuseSubAgent(): Response {
  const body: ErrorResponse = { error: "not_found" };
  return Response.json(body, { status: 404 });
}
