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

// Whether an Agents route (its binding and the literal name segment) names an instance prq uses.
export function isRoutedAgent(route: { className: string; name: string }): boolean {
  switch (route.className) {
    case "Hub":
      return route.name === HUB_NAME;
    case "PrSession":
      return parseSessionName(route.name) !== null;
    default:
      return false;
  }
}
