import { isAbsolute, join } from "node:path";

import { AgentId } from "@prq/protocol";
import * as v from "valibot";

import { CliError, EXIT } from "./errors.ts";

export type Env = Readonly<Record<string, string | undefined>>;

// What the CLI is run with: the Worker's origin, the Access service token, the agent ID, whether the version notice
// is on, and the directory of its local state.
export type Config = {
  url: string;
  clientId: string;
  clientSecret: string;
  agentId: string;
  versionNotice: boolean;
  home: string;
};

// What the defaults come from: the host name (the agent ID) and the home directory (the state root).
type System = { hostname: string; homedir: string };

// Plain http is allowed only to these hosts (tests and a local stack), so the service token never crosses a network in
// clear text.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// A header value fetch accepts and a service token is made of: visible ASCII.
const HEADER_VALUE = /^[\x21-\x7e]+$/;

// Reads the configuration (docs/design.md, Local CLI). Every refusal is exit 3, as an authentication failure is: the
// host must fix the configuration, and a rerun would fail the same way. No messages name a value: the URL can hold
// credentials, and the token never leaves the request headers.
export function readConfig(env: Env, agentIdFlag: string | undefined, system: System): Config {
  const url = workerOrigin(set(env["PRQ_URL"]));
  const clientId = set(env["PRQ_ACCESS_CLIENT_ID"]);
  const clientSecret = set(env["PRQ_ACCESS_CLIENT_SECRET"]);
  if (clientId === undefined || clientSecret === undefined) {
    throw new CliError(EXIT.setup, "no service token: set PRQ_ACCESS_CLIENT_ID and PRQ_ACCESS_CLIENT_SECRET");
  }
  if (!HEADER_VALUE.test(clientId) || !HEADER_VALUE.test(clientSecret)) {
    throw new CliError(
      EXIT.setup,
      "PRQ_ACCESS_CLIENT_ID and PRQ_ACCESS_CLIENT_SECRET must be printable ASCII without spaces",
    );
  }
  return {
    url,
    clientId,
    clientSecret,
    agentId: agentId(agentIdFlag, set(env["PRQ_AGENT_ID"]), system.hostname),
    versionNotice: env["PRQ_VERSION_NOTICE"] !== "0",
    home: stateHome(set(env["PRQ_HOME"]), set(env["XDG_STATE_HOME"]), system.homedir),
  };
}

// An empty variable counts as unset, as a shell's `VAR=` usually means.
function set(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

// The Worker's origin: https, or http to a loopback host; nothing after the host and port.
function workerOrigin(value: string | undefined): string {
  if (value === undefined) {
    throw new CliError(EXIT.setup, "PRQ_URL is not set: set it to the Worker's origin (https://<host>)");
  }
  const url = URL.parse(value);
  if (url === null) {
    throw new CliError(EXIT.setup, "PRQ_URL is not a URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new CliError(EXIT.setup, "PRQ_URL must use https (http only for localhost, 127.0.0.1 or [::1])");
  }
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new CliError(EXIT.setup, "PRQ_URL must be an origin, without credentials, path, query or fragment");
  }
  return url.origin;
}

// PRQ_CLONE_ROOTS: the directories prq checkout looks in for <owner>/<repo> clones, separated by ':', each absolute,
// since the commands of one job may run from different directories. Read by checkout alone, so a wrong value does not
// stop the other commands.
export function cloneRoots(value: string | undefined): string[] {
  const roots = (value ?? "").split(":").filter((root) => root !== "");
  if (!roots.every((root) => isAbsolute(root))) {
    throw new CliError(EXIT.setup, "PRQ_CLONE_ROOTS must list absolute paths, separated by ':'");
  }
  return roots;
}

// --agent-id, else PRQ_AGENT_ID, else the host name, as the protocol's AgentId.
function agentId(flag: string | undefined, env: string | undefined, hostname: string): string {
  const [id, source] =
    flag !== undefined ? [flag, "--agent-id"] : env !== undefined ? [env, "PRQ_AGENT_ID"] : [hostname, "the host name"];
  if (!v.is(AgentId, id)) {
    throw new CliError(
      EXIT.setup,
      `the agent ID from ${source} is not valid (printable ASCII without spaces, at most 128 characters); pass --agent-id`,
    );
  }
  return id;
}

// PRQ_HOME, else $XDG_STATE_HOME/prq, else ~/.local/state/prq. A relative XDG_STATE_HOME is ignored, as the XDG
// specification says; a relative PRQ_HOME is refused, since the commands of one job may run from different directories.
function stateHome(prqHome: string | undefined, xdgStateHome: string | undefined, homedir: string): string {
  if (prqHome !== undefined) {
    if (!isAbsolute(prqHome)) {
      throw new CliError(EXIT.setup, "PRQ_HOME must be an absolute path");
    }
    return prqHome;
  }
  if (xdgStateHome !== undefined && isAbsolute(xdgStateHome)) {
    return join(xdgStateHome, "prq");
  }
  return join(homedir, ".local", "state", "prq");
}
