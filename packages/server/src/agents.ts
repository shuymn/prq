import type { ErrorResponse, ServerVersionMessage } from "@prq/protocol";
import { type Connection, routeAgentRequest } from "agents";
import type { Context } from "hono";

import { errorResponse } from "./http.ts";
import { isRoutedAgent, servedAgentRoute } from "./names.ts";
import { SERVER_VERSION } from "./version.ts";

// Headers the Agents SDK passes from its own router to an instance (startup properties, the outer URL of a sub-agent
// connection, which skips onBeforeSubAgent). A client must not set them.
const INTERNAL_HEADERS = ["x-agents-lifecycle-props", "x-cf-agents-subagent-url"];

// /agents/*: the Agents SDK's routes, behind Access. Only what servedAgentRoute accepts reaches the SDK router: the
// router creates the instance before the instance's own checks (sub-agent paths, unknown endpoints) run, so anything
// else is refused here. The SDK's hooks check the name again on the SDK's own parse of the path, and remove the
// headers a client must not set.
export async function routeAgents(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (servedAgentRoute(c.req.raw) === null) {
    return errorResponse(c, "not_found");
  }
  const guard = (request: Request, route: { className: string; name: string }): Request | Response => {
    if (!isRoutedAgent(route)) {
      return errorResponse(c, "not_found");
    }
    for (const header of INTERNAL_HEADERS) {
      request.headers.delete(header);
    }
    return request;
  };
  const response = await routeAgentRequest(c.req.raw, c.env, { onBeforeConnect: guard, onBeforeRequest: guard });
  return response ?? errorResponse(c, "not_found");
}

// Sent on every WebSocket connection, after the SDK's own frames.
export function sendServerVersion(connection: Connection): void {
  const message: ServerVersionMessage = { type: "prq:version", version: SERVER_VERSION };
  connection.send(JSON.stringify(message));
}

// Sub-agents (`/sub/<class>/<name>` below an instance) would create child instances under any name; prq has none. The
// Worker never routes such a path; this answers one that reaches an instance some other way.
export function refuseSubAgent(): Response {
  const body: ErrorResponse = { error: "not_found" };
  return Response.json(body, { status: 404 });
}
