import { HUB_NAME, parseSessionName, type PrRef, sessionName } from "@prq/protocol";
import { getAgentByName } from "agents";

import type { Workspace } from "./workspace.ts";

// The only code that addresses a Durable Object: the Hub by HUB_NAME, and a PrSession and its Workspace by the
// canonical session name, so one pull request never reaches two instances of either.

export function hubStub(env: Env) {
  return getAgentByName(env.Hub, HUB_NAME);
}

// A call to the Hub, the stub's lookup included, under `bound` (withTimeout, or a route's injected bound) at `ms`:
// when the bound passes, the caller stops waiting and the call keeps running.
export function boundedHubCall<T>(
  bound: (call: PromiseLike<T>, ms: number, what: string) => Promise<T>,
  env: Env,
  ms: number,
  what: string,
  call: (hub: Awaited<ReturnType<typeof hubStub>>) => PromiseLike<T>,
): Promise<T> {
  return bound((async () => call(await hubStub(env)))(), ms, what);
}

export function prSessionStub(env: Env, ref: PrRef) {
  return getAgentByName(env.PrSession, sessionName(ref));
}

// The Workspace is not an Agent and no route reaches it: only its session calls it.
export function workspaceStub(env: Env, ref: PrRef): DurableObjectStub<Workspace> {
  return env.Workspace.getByName(sessionName(ref));
}

type AgentRoute = { className: string; name: string };

// Whether an Agents route (its binding and the literal name segment) names an instance prq uses.
export function isRoutedAgent(route: AgentRoute): boolean {
  switch (route.className) {
    case "Hub":
      return route.name === HUB_NAME;
    case "PrSession":
      return parseSessionName(route.name) !== null;
    default:
      return false;
  }
}

// The Agents SDK's binding segments (kebab-case binding names) for the classes prq serves.
const CLASS_NAMES = new Map([
  ["hub", "Hub"],
  ["pr-session", "PrSession"],
]);

// The instance an /agents/* request addresses, when it is a request prq serves: a WebSocket to the Hub or a PrSession,
// or a GET of a session's stored history (get-messages). Null for anything else. The path is split as the SDK router
// splits it, on "/" with empty segments dropped and nothing percent-decoded.
export function servedAgentRoute(request: Request): AgentRoute | null {
  const [prefix, binding, name, ...rest] = new URL(request.url).pathname.split("/").filter(Boolean);
  const className = binding === undefined ? undefined : CLASS_NAMES.get(binding);
  if (prefix !== "agents" || className === undefined || name === undefined) {
    return null;
  }
  const route = { className, name };
  const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  const served =
    rest.length === 0
      ? upgrade
      : className === "PrSession" && rest.join("/") === "get-messages" && request.method === "GET" && !upgrade;
  return served && isRoutedAgent(route) ? route : null;
}
