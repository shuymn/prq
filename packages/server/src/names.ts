import { HUB_NAME, parseSessionName, type PrRef, sessionName } from "@prq/protocol";
import { getAgentByName } from "agents";

// The only code that addresses a Durable Object: the Hub by HUB_NAME and a PrSession by its canonical session name,
// so one pull request never reaches two instances.

export function hubStub(env: Env) {
  return getAgentByName(env.Hub, HUB_NAME);
}

export function prSessionStub(env: Env, ref: PrRef) {
  return getAgentByName(env.PrSession, sessionName(ref));
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
