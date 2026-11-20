// The setup's cloudflare step (setup-cloudflare.ts) through the tests' entry (test-entry.ts), whose fixture gives it a
// deploy directory and a state directory in the OS temp directory, a stand-in for wrangler (its login and accounts in
// a state file each call reads, every call's arguments and environment logged), and a local server answering
// Cloudflare's API from an in-memory account. Runs get a terminal from python3's pty module, where the questions and
// the token are answered. Every token and secret below is a sentinel no output may hold. Nothing reaches the network.

import { type ChildProcess, execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fixtureRoot } from "../../cli/src/test/git.ts";
import type { Fixture } from "./fixture.ts";
import { runInTerminal, type TerminalResult } from "./test-terminal.ts";

const TEST_ENTRY = fileURLToPath(new URL("test-entry.ts", import.meta.url));
const ACCOUNT = "5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e";
const OTHER_ACCOUNT = "feedfacefeedfacefeedfacefeedface";
const ZONE = "sentinel-zone.example";
const ZONE_ID = "0123456789abcdef0123456789abcdef";
const HOST = `prq.${ZONE}`;
const API_TOKEN = "sentinel-cf-api-token-91c2e7";
const WRANGLER_TOKEN = "sentinel-wrangler-oauth-4d0b1a";
const EMAIL = "owner@sentinel-mail.example";
const TOKEN_PROMPT = "Cloudflare API token (not shown): ";
const SECRET_PREFIX = "sentinel-client-secret-";
const SENTINELS = [API_TOKEN, WRANGLER_TOKEN, SECRET_PREFIX];
const EXPRESSION = `http.host eq "${HOST}"`;

// The stand-in for wrangler: whoami (refused as wrangler refuses it without a login), login, and auth token.
const FAKE_WRANGLER = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ args, env: process.env }) + "\\n");
const statePath = process.env.FAKE_WRANGLER_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
if (args[0] === "whoami") {
  if (!state.loggedIn) {
    console.log(JSON.stringify({ loggedIn: false }));
    process.exit(1);
  }
  console.log(JSON.stringify({ loggedIn: true, accounts: state.accounts }));
} else if (args[0] === "login") {
  state.loggedIn = true;
  writeFileSync(statePath, JSON.stringify(state));
  console.log("Successfully logged in.");
} else if (args[0] === "auth" && args[1] === "token") {
  console.log(JSON.stringify({ type: "oauth", token: ${JSON.stringify(WRANGLER_TOKEN)} }));
} else {
  process.exit(2);
}
`;

const JsonObject = v.record(v.string(), v.unknown());
type Json = v.InferOutput<typeof JsonObject>;
const RuleBody = v.object({
  ref: v.optional(v.string()),
  expression: v.string(),
  action: v.string(),
  action_parameters: JsonObject,
  enabled: v.optional(v.boolean()),
});
type Rule = v.InferOutput<typeof RuleBody> & { id: string };
// The account as the API stand-in holds it.
type Account = {
  // The page the token was made on: a profile's (the user's) or an account's.
  tokenOwner: "user" | "account";
  zones: { id: string; name: string }[];
  // wrangler's login lists zones (its grant reads them).
  loginListsZones: boolean;
  subscriptions: Json[];
  fightMode: boolean;
  dns: { type: string; name: string }[];
  domains: { hostname: string; service: string; zone_id: string }[];
  settings: Record<string, string>;
  sites: Json[];
  pageRules: Json[];
  entry: { id: string; rules: Rule[] } | null;
  // Rules the stand-in adds after any rule written, as another tool would.
  laterRules: Rule[];
  org: Json | null;
  worker: { id: string } | null;
  apps: Json[];
  idps: Json[];
  tokens: Json[];
  policies: Json[];
  // Paths (a prefix, with the method) answered 403; writes answered 500, and 200 with a body that is not JSON, after
  // they took effect.
  deny: string[];
  lost: string[];
  garbled: string[];
  // Web Analytics' list answered with total_pages null, as its schema allows.
  nullTotalPages: boolean;
  // The page size lists are answered in whatever per_page asks for (an API's own cap), or the asked one.
  pageSize: number | null;
  // How the service token list reads after a create or rotation: as it is, or with another client ID.
  tokenReadBack: "same" | "other";
  // A field the stand-in drops from a created application.
  dropOnCreate: string | null;
  // The secret a token's create or rotation returns, unless given.
  nextSecret: string | null;
  requests: { method: string; path: string; auth: string; body: unknown }[];
};
let cf: Account;
let ids = 0;
let server: Server;
let origin: string;
let root: string;
let directory: string;
let stateDir: string;
let env: Record<string, string>;
const started: ChildProcess[] = [];

function nextId(prefix: string): string {
  ids += 1;
  return `${prefix}-${String(ids).padStart(4, "0")}`;
}

function newSecret(): string {
  return cf.nextSecret ?? `${SECRET_PREFIX}${nextId("s")}`;
}

// After a rule is written: the rules another tool adds after it.
function addLaterRules(): void {
  const entry = cf.entry;
  if (entry !== null) {
    entry.rules.push(...cf.laterRules.filter((each) => !entry.rules.some((other) => other.id === each.id)));
  }
}

// Cloudflare's API from cf: the result, or [status, result].
function answer(method: string, path: string, query: URLSearchParams, body: Json): unknown {
  const account = `/accounts/${ACCOUNT}`;
  const zone = `/zones/${ZONE_ID}`;
  const route = `${method} ${path}`;
  const access = `${account}/access`;
  let match: RegExpExecArray | null;
  switch (route) {
    case "GET /user/tokens/verify":
      return cf.tokenOwner === "user" ? { id: "token-id", status: "active" } : [401, null];
    case `GET ${account}/tokens/verify`:
      return cf.tokenOwner === "account" ? { id: "token-id", status: "active" } : [401, null];
    case "GET /zones": {
      const name = query.get("name");
      return cf.zones.filter((each) => name === null || each.name === name);
    }
    case `GET ${zone}/bot_management`:
      return { fight_mode: cf.fightMode };
    case `GET ${zone}/dns_records`:
      return cf.dns.filter((each) => each.name === query.get("name"));
    case `GET ${account}/workers/domains`:
      return cf.domains.filter(
        (each) => each.hostname === query.get("hostname") && each.zone_id === query.get("zone_id"),
      );
    case `GET ${account}/rum/site_info/list`:
      return cf.sites;
    case `GET ${zone}/pagerules`:
      // The list's status filter defaults to disabled rules.
      return cf.pageRules.filter((each) => each["status"] === (query.get("status") ?? "disabled"));
    case `GET ${zone}/rulesets/phases/http_config_settings/entrypoint`:
      return cf.entry ?? [404, null];
    case `POST ${zone}/rulesets`: {
      cf.entry = {
        id: nextId("ruleset"),
        rules: v.parse(v.array(RuleBody), body["rules"]).map((rule) => ({ ...rule, id: nextId("rule") })),
      };
      addLaterRules();
      return cf.entry;
    }
    case `GET ${account}/subscriptions`:
      return cf.subscriptions;
    case `GET ${access}/organizations`:
      return cf.org ?? [404, null];
    case `PATCH ${access}/organizations`:
      cf.org = { ...cf.org, ...body };
      return cf.org;
    case `GET ${account}/workers/workers/prq`:
      return cf.worker ?? [404, null];
    case `GET ${access}/apps`:
      return cf.apps;
    case `POST ${access}/apps`: {
      const app: Json = { ...body, id: nextId("app"), aud: `aud-${nextId("a")}` };
      if (cf.dropOnCreate !== null) {
        delete app[cf.dropOnCreate];
      }
      cf.apps.push(app);
      return app;
    }
    case `GET ${access}/identity_providers`:
      return cf.idps;
    case `POST ${access}/identity_providers`: {
      const idp = { ...body, id: nextId("idp") };
      cf.idps.push(idp);
      return idp;
    }
    case `GET ${access}/service_tokens`:
      return cf.tokens
        .filter((each) => query.get("name") === null || each["name"] === query.get("name"))
        .map((each) =>
          cf.tokenReadBack === "other" && cf.requests.some((request) => request.method === "POST")
            ? { ...each, client_id: "other-client.access" }
            : each,
        );
    case `POST ${access}/service_tokens`: {
      const created = {
        id: nextId("token"),
        name: body["name"],
        client_id: `${nextId("client")}.access`,
        enabled: true,
        duration: body["duration"],
        expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      };
      cf.tokens.push(created);
      return { ...created, client_secret: newSecret() };
    }
    case `GET ${access}/policies`:
      return cf.policies;
    case `POST ${access}/policies`: {
      const policy = { ...body, id: nextId("policy"), reusable: true };
      cf.policies.push(policy);
      return policy;
    }
  }
  if ((match = new RegExp(`^POST ${zone}/rulesets/([^/]+)/rules$`).exec(route)) !== null && cf.entry !== null) {
    const rule = { ...v.parse(RuleBody, body), id: nextId("rule") };
    cf.entry.rules.push(rule);
    addLaterRules();
    return cf.entry;
  }
  if ((match = new RegExp(`^PATCH ${zone}/rulesets/[^/]+/rules/([^/]+)$`).exec(route)) !== null && cf.entry !== null) {
    const id = match[1];
    cf.entry.rules = cf.entry.rules.map((rule) =>
      rule.id === id ? { ...v.parse(RuleBody, body), id: rule.id } : rule,
    );
    return cf.entry;
  }
  if ((match = new RegExp(`^GET ${zone}/settings/(\\w+)$`).exec(route)) !== null) {
    return { id: match[1], value: cf.settings[match[1] ?? ""] ?? "off" };
  }
  if ((match = new RegExp(`^GET ${access}/(apps|identity_providers|policies)/([^/]+)$`).exec(route)) !== null) {
    const list = match[1] === "apps" ? cf.apps : match[1] === "policies" ? cf.policies : cf.idps;
    return list.find((each) => each["id"] === match?.[2]) ?? [404, null];
  }
  if ((match = new RegExp(`^POST ${access}/service_tokens/([^/]+)/rotate$`).exec(route)) !== null) {
    const found = cf.tokens.find((each) => each["id"] === match?.[1]);
    return found === undefined ? [404, null] : { ...found, client_secret: newSecret() };
  }
  return [404, null];
}

// An answer in Cloudflare's envelope.
// An envelope as Cloudflare's API answers; Web Analytics' list answers a success with errors and messages null.
function reply(response: ServerResponse, status: number, result: unknown, info?: Json, nulls = false): void {
  response.writeHead(status, { "content-type": "application/json" }).end(
    JSON.stringify({
      success: status < 400,
      errors: status < 400 ? (nulls ? null : []) : [{ code: 10_000 + status, message: "stand-in" }],
      messages: nulls ? null : [],
      result,
      ...(info === undefined ? {} : { result_info: info }),
    }),
  );
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://stand-in.invalid");
      const path = url.pathname.replace(/^\/client\/v4/, "");
      const send = (status: number, result: unknown, info?: Json) =>
        reply(response, status, result, info, path.endsWith("/rum/site_info/list"));
      const method = request.method ?? "GET";
      const auth = request.headers.authorization ?? "";
      const body = text === "" ? {} : v.parse(JsonObject, JSON.parse(text));
      cf.requests.push({ method, path, auth, body });
      // wrangler's login lists zones; everything else takes the pasted token.
      const zonesByLogin = method === "GET" && path === "/zones" && auth === `Bearer ${WRANGLER_TOKEN}`;
      if (zonesByLogin ? !cf.loginListsZones : auth !== `Bearer ${API_TOKEN}`) {
        send(zonesByLogin ? 403 : 401, null);
        return;
      }
      if (cf.deny.some((each) => `${method} ${path}`.startsWith(each))) {
        send(403, null);
        return;
      }
      const result = answer(method, path, url.searchParams, body);
      if (Array.isArray(result) && typeof result[0] === "number") {
        send(result[0], result[1]);
        return;
      }
      if (cf.lost.includes(`${method} ${path}`)) {
        send(500, null);
        return;
      }
      if (cf.garbled.includes(`${method} ${path}`)) {
        response.writeHead(200, { "content-type": "application/json" }).end("<html>");
        return;
      }
      if (Array.isArray(result)) {
        const perPage = cf.pageSize ?? Number(url.searchParams.get("per_page") ?? "1000");
        const page = Number(url.searchParams.get("page") ?? "1");
        const pages = Math.max(1, Math.ceil(result.length / perPage));
        const nullPages = cf.nullTotalPages && path.endsWith("/rum/site_info/list");
        send(200, result.slice((page - 1) * perPage, page * perPage), {
          page,
          // Web Analytics' list, as its documented answer, reports no page size either.
          ...(nullPages ? { total_pages: null } : { per_page: perPage, total_pages: pages }),
          total_count: result.length,
        });
        return;
      }
      send(200, result);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  // macOS checks python3 on its first run, which can take seconds.
  await new Promise<void>((resolve) => {
    execFile("python3", ["-I", "-S", "-c", "pass"], { timeout: 60_000 }, () => resolve());
  });
}, 120_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function wranglerState(state: Json): void {
  writeFileSync(join(root, "wrangler-state.json"), JSON.stringify(state));
}

beforeEach(async () => {
  root = await fixtureRoot("prq-setup-cloudflare-");
  directory = join(root, "config", "deploy");
  stateDir = join(root, "state");
  env = { PATH: process.env["PATH"] ?? "", HOME: root, TERM: "xterm" };
  await writeFile(join(root, "wrangler"), FAKE_WRANGLER, { mode: 0o755 });
  wranglerState({ loggedIn: true, accounts: [{ id: ACCOUNT, name: "Synthetic Account" }] });
  cf = {
    tokenOwner: "user",
    zones: [{ id: ZONE_ID, name: ZONE }],
    loginListsZones: true,
    subscriptions: [{ id: "sub-1", state: "Paid", rate_plan: { id: "WORKERS_PAID", public_name: "Workers Paid" } }],
    fightMode: false,
    dns: [],
    domains: [],
    settings: { rocket_loader: "off", email_obfuscation: "off" },
    sites: [],
    pageRules: [],
    entry: null,
    laterRules: [],
    org: { name: "sentinel team", auth_domain: "sentinel-team.cloudflareaccess.com", strict_service_token_auth: true },
    worker: null,
    apps: [],
    idps: [],
    tokens: [],
    policies: [],
    deny: [],
    lost: [],
    garbled: [],
    nullTotalPages: false,
    pageSize: null,
    tokenReadBack: "same",
    dropOnCreate: null,
    nextSecret: null,
    requests: [],
  };
});

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await rm(root, { recursive: true, force: true });
});

// The setup with these arguments in a terminal, typing each reply (entered) once the output shows its prompt, in turn.
// Its output never holds a sentinel.
async function setup(args: string[], turns: [string, string][] = []): Promise<TerminalResult> {
  const file = join(root, "fixture.json");
  const settings: v.InferOutput<typeof Fixture> = {
    directory,
    stateDir,
    wrangler: join(root, "wrangler"),
    api: `${origin}/client/v4`,
    waitMs: 15_000,
    stepMs: 15_000,
    childEnv: {
      FAKE_WRANGLER_STATE: join(root, "wrangler-state.json"),
      FAKE_WRANGLER_LOG: join(root, "wrangler.jsonl"),
    },
  };
  writeFileSync(file, JSON.stringify(settings));
  const prompt = new RegExp(turns.map(([text]) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "(?!)");
  const run = runInTerminal([process.execPath, TEST_ENTRY, file, "setup", ...args], {
    cwd: root,
    env,
    prompt,
    // Each is entered with a newline.
    answers: turns.map(([, typed]) => typed.replace(/\r$/, "")),
  });
  started.push(run.child);
  const result = await run.result;
  for (const sentinel of SENTINELS) {
    expect(result.output).not.toContain(sentinel);
  }
  // The pasted token reaches no program: neither wrangler's arguments nor its environment.
  const log = await readFile(join(root, "wrangler.jsonl"), "utf8").catch(() => "");
  expect(log).not.toContain(API_TOKEN);
  return result;
}

const TOKEN_TURN: [string, string] = [TOKEN_PROMPT, `${API_TOKEN}\r`];
const EMAIL_TURN: [string, string] = ["The email address you sign in to prq with: ", `${EMAIL}\r`];
const FRESH: [string, string][] = [["Hostname label [prq]: ", "\r"], TOKEN_TURN, EMAIL_TURN];

function writes(): string[] {
  return cf.requests.filter((each) => each.method !== "GET").map((each) => `${each.method} ${each.path}`);
}

async function envFile(name: string): Promise<string> {
  return readFile(join(directory, name), "utf8");
}

async function privateFile(name: string, text: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, name), text, { mode: 0o600 });
  await chmod(join(directory, name), 0o600);
}

// The account after a complete run: what the stand-in holds, and access.env.
async function completed(): Promise<void> {
  const result = await setup(["cloudflare"], FRESH);
  expect(result.code).toBe(0);
  cf.requests = [];
}

describe("setup cloudflare", () => {
  it("sets a fresh account up, then does nothing on a re-run", async () => {
    wranglerState({ loggedIn: false, accounts: [{ id: ACCOUNT, name: "Synthetic Account" }] });
    cf.zones.push({ id: "fedcba9876543210fedcba9876543210", name: "other-zone.example" });
    cf.settings["rocket_loader"] = "on";

    const result = await setup(["cloudflare"], [["Zone [1-2]: ", "1\r"], ...FRESH]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("cloudflare: wrangler is not logged in");
    const shown = `cloudflare: account Synthetic Account (${ACCOUNT}), zone ${ZONE}, hostname ${HOST}; wrote CLOUDFLARE_ACCOUNT_ID, PRQ_HOST`;
    expect(result.output).toContain(shown);
    expect(result.output.indexOf(shown)).toBeLessThan(result.output.indexOf(TOKEN_PROMPT));
    expect(result.output).toContain("Zone: Zone (Read); DNS (Read)");
    expect(result.output).toContain("HTML rewrites: the zone's rocket_loader is on");
    expect(result.output).toContain("cloudflare: created the zone's Configuration Rules with prq-no-rewrites");
    expect(result.output).toContain("cloudflare: added the one-time PIN login method");
    expect(result.output).toContain("cloudflare: created the service token prq-cli and wrote access.env");
    expect(result.output).toContain('cloudflare: created the Access application "prq"');
    expect(result.output).toContain("cloudflare: wrote ACCESS_TEAM_DOMAIN, ACCESS_AUD to worker.env");
    expect(result.output).toContain("delete the API token now");
    const link = /from this link, which fills its permissions in: (\S+)/.exec(result.output)?.[1] ?? "";
    const url = new URL(link);
    expect(`${url.origin}${url.pathname}`).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(url.searchParams.get("accountId")).toBe(ACCOUNT);
    expect(url.searchParams.get("zoneId")).toBe("all");
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "[]")).toEqual(
      [
        ["access_acct", "edit"],
        ["access", "edit"],
        ["access_service_token", "edit"],
        ["account_settings", "read"],
        ["billing", "read"],
        ["workers_scripts", "read"],
        ["zone", "read"],
        ["dns", "read"],
        ["zone_settings", "read"],
        ["bot_management", "read"],
        ["page_rules", "read"],
        ["config_settings", "edit"],
      ].map(([key, type]) => ({ key, type })),
    );
    const app = cf.apps.find((each) => each["name"] === "prq");
    expect(app).toMatchObject({
      domain: HOST,
      destinations: [{ type: "public", uri: HOST }],
      session_duration: "24h",
      allowed_idps: [cf.idps[0]?.["id"]],
    });
    expect(cf.apps.find((each) => each["name"] === "prq webhook")).toMatchObject({ domain: `${HOST}/webhook` });
    expect(cf.entry?.rules).toEqual([
      expect.objectContaining({
        ref: "prq-no-rewrites",
        expression: EXPRESSION,
        action_parameters: { rocket_loader: false, email_obfuscation: false, disable_rum: true },
      }),
    ]);
    const token = cf.tokens[0] ?? {};
    const access = await envFile("access.env");
    expect(access).toMatch(
      new RegExp(
        `^PRQ_URL=https://${HOST}\\nPRQ_ACCESS_CLIENT_ID=${String(token["client_id"])}\\nPRQ_ACCESS_CLIENT_SECRET=${SECRET_PREFIX}s-\\d+\\n$`,
      ),
    );
    expect((await stat(join(directory, "access.env"))).mode & 0o777).toBe(0o600);
    expect(await envFile("target.env")).toBe(`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nPRQ_HOST=${HOST}\n`);
    expect(await envFile("worker.env")).toBe(
      `ACCESS_TEAM_DOMAIN=https://sentinel-team.cloudflareaccess.com\nACCESS_AUD=${String(app?.["aud"])}\n`,
    );
    // Every Access write after the Access reads (the policies list is the last of them).
    const firstAccessWrite = cf.requests.findIndex((each) => each.method !== "GET" && each.path.includes("/access/"));
    const policiesRead = cf.requests.findIndex(
      (each) => each.method === "GET" && each.path.endsWith("/access/policies"),
    );
    expect(policiesRead).toBeGreaterThan(-1);
    expect(firstAccessWrite).toBeGreaterThan(policiesRead);
    const files = { access, target: await envFile("target.env"), worker: await envFile("worker.env") };
    cf.requests = [];
    // After the deploy: the hostname's record is the Worker's custom domain.
    cf.dns = [{ type: "AAAA", name: HOST }];
    cf.domains = [{ hostname: HOST, service: "prq", zone_id: ZONE_ID }];

    const again = await setup(["cloudflare"], [TOKEN_TURN]);

    expect(again.code).toBe(0);
    expect(writes()).toEqual([]);
    expect(again.output).toContain(
      `cloudflare: account Synthetic Account (${ACCOUNT}), zone ${ZONE}, hostname ${HOST}`,
    );
    expect(again.output).toContain(`cloudflare: DNS: ${HOST} is the Worker prq's custom domain`);
    expect(again.output).toContain("cloudflare: the service token prq-cli: pass");
    expect(again.output).toContain('cloudflare: the Access application "prq": pass');
    expect(again.output).toContain("cloudflare: the Configuration Rule prq-no-rewrites: pass");
    expect(again.output).not.toContain("The email address");
    expect({
      access: await envFile("access.env"),
      target: await envFile("target.env"),
      worker: await envFile("worker.env"),
    }).toEqual(files);
  });

  it("asks for the zone when wrangler's login does not list zones, and adds no rule when nothing rewrites", async () => {
    cf.loginListsZones = false;

    const result = await setup(["cloudflare"], [["Zone (such as example.com): ", `${ZONE}\r`], ...FRESH]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("cloudflare: wrangler's login does not list the zones");
    expect(result.output).toContain(`cloudflare: HTML rewrites: none for ${HOST}`);
    expect(cf.entry).toBeNull();
  });

  it("chooses among the accounts the login reaches, and refuses one target.env names that it does not", async () => {
    wranglerState({
      loggedIn: true,
      accounts: [
        { id: OTHER_ACCOUNT, name: "Other" },
        { id: ACCOUNT, name: "Synthetic Account" },
      ],
    });

    const chosen = await setup(["cloudflare"], [["Account [1-2]: ", "synthetic account\r"], ...FRESH]);

    expect(chosen.code).toBe(0);
    expect(await envFile("target.env")).toContain(`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`);

    wranglerState({ loggedIn: true, accounts: [{ id: OTHER_ACCOUNT, name: "Other" }] });
    const refused = await setup(["cloudflare"]);

    expect(refused.code).toBe(1);
    expect(refused.output).toContain("setup: wrangler's login does not reach the account target.env names");
  });

  it("names the permission a denied read needed, and writes nothing to the account", async () => {
    cf.deny = [`GET /zones/${ZONE_ID}/bot_management`];

    const result = await setup(["cloudflare"], FRESH);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "setup: Cloudflare's API denied the zone's Bot Fight Mode: the token needs Bot Management Read (the zone)",
    );
    expect(writes()).toEqual([]);
  });

  it("takes a zone by its name", async () => {
    cf.zones.push({ id: "fedcba9876543210fedcba9876543210", name: "other-zone.example" });

    const result = await setup(["cloudflare"], [["Zone [1-2]: ", `${ZONE.toUpperCase()}\r`], ...FRESH]);

    expect(result.code).toBe(0);
    expect(result.output).toContain(`zone ${ZONE}, hostname ${HOST}`);
  });

  it("stands by a lost verification without probing the account's", async () => {
    cf.lost = ["GET /user/tokens/verify"];

    const result = await setup(["cloudflare"], FRESH);

    expect(result.code).toBe(1);
    expect(cf.requests.some((each) => each.path === `/accounts/${ACCOUNT}/tokens/verify`)).toBe(false);
  });

  it("refuses a token made on the account's API Tokens page, naming the profile's", async () => {
    cf.tokenOwner = "account";

    const result = await setup(["cloudflare"], FRESH);

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: the token was made on the account's API Tokens page");
  });

  it("refuses a token that does not read the zone", async () => {
    cf.zones = [];
    cf.loginListsZones = false;

    const result = await setup(["cloudflare"], [["Zone (such as example.com): ", `${ZONE}\r`], ...FRESH]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`setup: the token does not read the zone ${ZONE} on the account`);
  });

  it.each([
    [
      "Bot Fight Mode",
      () => (cf.fightMode = true),
      "setup: Bot Fight Mode is on for the zone, and it challenges prq and GitHub's webhook deliveries",
    ],
    [
      "a DNS record that is not the Worker's",
      () => (cf.dns = [{ type: "CNAME", name: HOST }]),
      `setup: ${HOST} has a DNS record (CNAME) that is not the Worker prq's custom domain`,
    ],
    [
      "another hostname's rule",
      () =>
        (cf.entry = {
          id: "ruleset-x",
          rules: [
            {
              id: "rule-x",
              ref: "prq-no-rewrites",
              expression: 'http.host eq "prq.other.example"',
              action: "set_config",
              action_parameters: { rocket_loader: false },
            },
          ],
        }),
      "setup: the zone's Configuration Rule prq-no-rewrites matches another expression than",
    ],
  ])("refuses %s before anything is written", async (_what, arrange, refusal) => {
    arrange();

    const result = await setup(["cloudflare"], FRESH);

    expect(result.code).toBe(1);
    expect(result.output).toContain(refusal);
    expect(writes()).toEqual([]);
  });

  it("adds the rule last for a Page Rule, leaving the other rules as they are", async () => {
    const other: Rule = {
      id: "rule-other",
      ref: "keep-me",
      expression: 'http.host eq "shop.sentinel-zone.example"',
      action: "set_config",
      action_parameters: { rocket_loader: true },
    };
    cf.entry = { id: "ruleset-1", rules: [other] };
    cf.pageRules = [
      {
        status: "active",
        targets: [{ target: "url", constraint: { operator: "matches", value: `*${ZONE}/*` } }],
        actions: [{ id: "email_obfuscation", value: "on" }],
      },
    ];

    const result = await setup(["cloudflare"], FRESH);

    expect(result.code).toBe(0);
    expect(result.output).toContain(`HTML rewrites: a Page Rule turns a rewrite on for ${HOST}`);
    expect(result.output).toContain("cloudflare: added the Configuration Rule prq-no-rewrites, last");
    expect(cf.entry?.rules[0]).toEqual(other);
    expect(cf.entry?.rules[1]).toMatchObject({ ref: "prq-no-rewrites", expression: EXPRESSION });
    expect(writes()).toContainEqual("POST /zones/0123456789abcdef0123456789abcdef/rulesets/ruleset-1/rules");
    expect(writes().filter((each) => each.includes("rulesets"))).toHaveLength(1);
  });

  it.each([
    ["Web Analytics", () => (cf.sites = [{ auto_install: true, ruleset: { zone_tag: ZONE_ID, enabled: true } }])],
    [
      "a Configuration Rule for every host",
      () =>
        (cf.entry = {
          id: "ruleset-1",
          rules: [{ id: "r1", expression: "true", action: "set_config", action_parameters: { disable_rum: false } }],
        }),
    ],
    [
      "Web Analytics listed without a page count",
      () => {
        cf.nullTotalPages = true;
        cf.sites = [{ auto_install: true, ruleset: { zone_tag: ZONE_ID, enabled: true } }];
      },
    ],
    [
      "Web Analytics on the second page of a list without a page count",
      () => {
        cf.nullTotalPages = true;
        cf.pageSize = 1;
        cf.sites = [
          { auto_install: true, ruleset: { zone_tag: "another-zone", enabled: true } },
          { auto_install: true, ruleset: { zone_tag: ZONE_ID, enabled: true } },
        ];
      },
    ],
    [
      "an active Page Rule whose second alternative matches",
      () =>
        (cf.pageRules = [
          {
            status: "active",
            targets: [{ constraint: { operator: "matches", value: `other.elsewhere.example/*|${HOST}/*` } }],
            actions: [{ id: "email_obfuscation", value: "on" }],
          },
        ]),
    ],
    [
      "an active Page Rule with a wildcard scheme",
      () =>
        (cf.pageRules = [
          {
            status: "active",
            targets: [{ constraint: { operator: "matches", value: `http*://${HOST}/*` } }],
            actions: [{ id: "rocket_loader", value: "on" }],
          },
        ]),
    ],
    [
      "an active Page Rule matching a path anywhere",
      () =>
        (cf.pageRules = [
          {
            status: "active",
            targets: [{ constraint: { operator: "contains", value: "/ui" } }],
            actions: [{ id: "rocket_loader", value: "on" }],
          },
        ]),
    ],
  ])("adds the rule for %s", async (_what, arrange) => {
    arrange();

    const result = await setup(["cloudflare"], FRESH);

    expect(result.code).toBe(0);
    expect(cf.entry?.rules.at(-1)).toMatchObject({ ref: "prq-no-rewrites" });
  });

  it("adds no rule for an active Page Rule that equals another host's URL", async () => {
    cf.pageRules = [
      {
        status: "active",
        targets: [{ constraint: { operator: "equals", value: "https://shop.elsewhere.example/" } }],
        actions: [{ id: "rocket_loader", value: "on" }],
      },
    ];

    const result = await setup(["cloudflare"], FRESH);

    expect(result.code).toBe(0);
    expect(result.output).toContain(`cloudflare: HTML rewrites: none for ${HOST}`);
    expect(cf.entry).toBeNull();
  });

  it("fails the rule's read-back when a later rule turns a rewrite on again", async () => {
    cf.settings["email_obfuscation"] = "on";
    cf.laterRules = [
      { id: "rule-late", expression: "true", action: "set_config", action_parameters: { email_obfuscation: true } },
    ];

    const result = await setup(["cloudflare"], FRESH);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `setup: the Configuration Rule rule-late after prq-no-rewrites could turn a rewrite on again for ${HOST}`,
    );
    expect(writes().some((each) => each.includes("/access/"))).toBe(false);
  });

  it("asks the owner to subscribe to Workers Paid, then takes a plan they name", async () => {
    cf.subscriptions = [{ state: "Paid", rate_plan: { id: "workers_standard", public_name: "Workers Standard" } }];

    const result = await setup(
      ["cloudflare"],
      [
        ["Hostname label [prq]: ", "\r"],
        TOKEN_TURN,
        ["Subscribed to Workers Paid? [y/N] ", "y\r"],
        ["Is one of these the account's Workers Paid plan, paid? [y/N] ", "y\r"],
        EMAIL_TURN,
      ],
    );

    expect(result.code).toBe(0);
    expect(result.output).toContain("/workers/plans");
    expect(result.output).toContain("the account's subscriptions: Workers Standard (Paid)");
  });

  it("refuses without Workers Paid", async () => {
    cf.subscriptions = [];

    const result = await setup(
      ["cloudflare"],
      [["Hostname label [prq]: ", "\r"], TOKEN_TURN, ["Subscribed to Workers Paid? [y/N] ", "n\r"]],
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: the account has no Workers Paid subscription");
    expect(writes()).toEqual([]);
  });

  it("asks for the Zero Trust organization when there is none", async () => {
    cf.org = null;

    const result = await setup(
      ["cloudflare"],
      [["Hostname label [prq]: ", "\r"], TOKEN_TURN, ["Is the Zero Trust organization made? [y/N] ", "n\r"]],
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain("https://one.dash.cloudflare.com/");
    expect(result.output).toContain("setup: the account has no Zero Trust organization");
    expect(writes().some((each) => each.includes("/access/"))).toBe(false);
  });

  it("stops before any Access write when strict service token authentication stays off", async () => {
    cf.org = { ...cf.org, strict_service_token_auth: false };

    const result = await setup(
      ["cloudflare"],
      [
        ["Hostname label [prq]: ", "\r"],
        TOKEN_TURN,
        ["Turn strict service token authentication on for the account? [y/N] ", "n\r"],
      ],
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain("applies to every Access application on the account");
    expect(result.output).toContain(
      "setup: kept strict service token authentication off: first-deploy's edge check E2",
    );
    expect(writes().some((each) => each.includes("/access/"))).toBe(false);
  });

  it("turns strict service token authentication on alone when the owner says yes", async () => {
    cf.org = { ...cf.org, strict_service_token_auth: false, session_duration: "24h" };

    const result = await setup(
      ["cloudflare"],
      [
        ["Hostname label [prq]: ", "\r"],
        TOKEN_TURN,
        ["Turn strict service token authentication on for the account? [y/N] ", "y\r"],
        EMAIL_TURN,
      ],
    );

    expect(result.code).toBe(0);
    expect(result.output).toContain("an integration whose service token an Allow policy lets in loses access");
    expect(result.output).toContain("cloudflare: turned strict service token authentication on");
    const patches = cf.requests.filter((each) => each.path.endsWith("/access/organizations") && each.method !== "GET");
    expect(patches).toEqual([expect.objectContaining({ method: "PATCH", body: { strict_service_token_auth: true } })]);
    const patch = cf.requests.findIndex((each) => each.method === "PATCH");
    expect(patch).toBeGreaterThan(cf.requests.findIndex((each) => each.path.endsWith("/access/policies")));
  });

  it.each([
    [
      "an application covering the hostname at another path",
      () => cf.apps.push({ id: "app-x", name: "admin", type: "self_hosted", domain: `*.${ZONE}/admin` }),
      `setup: the Access application "admin" covers ${HOST} (at some path)`,
    ],
    [
      "an application on the second page covering it by a destination",
      () => {
        for (let index = 0; index < 50; index++) {
          cf.apps.push({ id: `app-${index}`, name: `filler ${index}`, domain: `app${index}.elsewhere.example` });
        }
        cf.apps.push({
          id: "app-late",
          name: "late",
          domain: "late.elsewhere.example",
          destinations: [{ type: "public", uri: `${HOST}/x` }],
        });
      },
      `setup: the Access application "late" covers ${HOST}`,
    ],
    [
      "an application on the Worker",
      () => {
        cf.worker = { id: "worker-id-1" };
        cf.apps.push({ id: "app-w", name: "workers", destinations: [{ type: "worker", worker_id: "worker-id-1" }] });
      },
      'setup: the Access application "workers" covers the Worker prq',
    ],
    [
      "an application on every Worker",
      () => cf.apps.push({ id: "app-all", name: "all", destinations: [{ type: "all_workers" }] }),
      'setup: the Access application "all" covers every Worker',
    ],
  ])("refuses %s before any Access write", async (_what, arrange, refusal) => {
    arrange();

    const result = await setup(["cloudflare"], FRESH);

    expect(result.code).toBe(1);
    expect(result.output).toContain(refusal);
    expect(writes().some((each) => each.includes("/access/"))).toBe(false);
  });

  it.each([
    ["prq", { domain: "old.elsewhere.example" }],
    // A path's case is its own (RFC 3986 §6.2.2.1); the hostname's and the scheme's are not.
    [
      "prq webhook",
      {
        domain: `HTTPS://${HOST.toUpperCase()}/Webhook`,
        destinations: [{ type: "public", uri: `${HOST.toUpperCase()}/Webhook` }],
      },
    ],
  ])("refuses an application named %j at another destination before any Access write", async (name, at) => {
    cf.apps.push({ id: "app-old", name, type: "self_hosted", allowed_idps: [], ...at });

    const result = await setup(["cloudflare"], FRESH);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`setup: the Access application "${name}" has prq's name but is not prq's`);
    expect(writes().some((each) => each.includes("/access/"))).toBe(false);
  });

  it("counts prq's own application among those the one-time PIN would be offered on", async () => {
    cf.apps.push({
      id: "app-own",
      name: "prq",
      type: "self_hosted",
      domain: HOST,
      destinations: [{ type: "public", uri: HOST }],
    });

    const result = await setup(
      ["cloudflare"],
      [
        ["Hostname label [prq]: ", "\r"],
        TOKEN_TURN,
        ["Add the one-time PIN login method to the account? [y/N] ", "n\r"],
      ],
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain('adding it would also offer it on "prq"');
    expect(writes().some((each) => each.includes("/access/"))).toBe(false);
  });

  it("asks before adding the one-time PIN that other applications would offer, and adds none on no", async () => {
    cf.apps.push({ id: "app-o", name: "wiki", domain: `wiki.elsewhere.example` });

    const result = await setup(
      ["cloudflare"],
      [
        ["Hostname label [prq]: ", "\r"],
        TOKEN_TURN,
        ["Add the one-time PIN login method to the account? [y/N] ", "n\r"],
      ],
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain('adding it would also offer it on "wiki"');
    expect(result.output).toContain("setup: kept the account without the one-time PIN login method");
    expect(cf.idps).toEqual([]);
    expect(writes().some((each) => each.includes("/access/"))).toBe(false);
  });

  it("refuses an application whose allowed login methods do not read back", async () => {
    cf.dropOnCreate = "allowed_idps";

    const result = await setup(["cloudflare"], FRESH);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      'setup: the Access application "prq" does not read back as created (its allowed_idps)',
    );
  });

  it("refuses an existing application that differs, changing nothing of it", async () => {
    await completed();
    const app = cf.apps.find((each) => each["name"] === "prq") ?? {};
    app["session_duration"] = "720h";

    const result = await setup(["cloudflare"], [TOKEN_TURN]);

    expect(result.code).toBe(1);
    expect(result.output).toContain('setup: the Access application "prq" differs from prq\'s in its session_duration');
    expect(writes()).toEqual([]);
  });

  it("asks before letting an existing owner policy decide who signs in, and remembers a yes", async () => {
    cf.idps.push({ id: "idp-otp", type: "onetimepin", name: "One-time PIN" });
    cf.policies.push({
      id: "p-owner",
      name: "prq owner",
      decision: "allow",
      include: [{ email: { email: "former-owner@sentinel-mail.example" } }],
    });
    const question = `Let it decide who signs in to ${HOST}? [y/N] `;

    const declined = await setup(["cloudflare"], [["Hostname label [prq]: ", "\r"], TOKEN_TURN, [question, "n\r"]]);

    expect(declined.code).toBe(1);
    expect(declined.output).toContain("which lets in former-owner@sentinel-mail.example");
    expect(declined.output).toContain('setup: kept the Access policy "prq owner" out of');
    expect(writes().filter((each) => each.includes("/access/apps") || each.includes("/access/policies"))).toEqual([]);

    const taken = await setup(["cloudflare"], [TOKEN_TURN, [question, "y\r"]]);

    expect(taken.code).toBe(0);
    expect(cf.apps.find((each) => each["name"] === "prq")?.["policies"]).toContainEqual({
      id: "p-owner",
      precedence: 1,
    });
    cf.requests = [];

    const again = await setup(["cloudflare"], [TOKEN_TURN]);

    expect(again.code).toBe(0);
    expect(again.output).not.toContain(question);
    expect(writes()).toEqual([]);
  });

  it("refuses an existing policy that differs", async () => {
    cf.policies.push({ id: "p-1", name: "prq webhook", decision: "allow", include: [{ everyone: {} }] });

    const result = await setup(["cloudflare"], FRESH);

    expect(result.code).toBe(1);
    expect(result.output).toContain('setup: the Access policy "prq webhook" differs from prq\'s in its decision');
  });

  describe("the service token", () => {
    it("is rotated only on yes when access.env lacks its secret, and the secret recorded unconfirmed", async () => {
      await completed();
      const blank = (await envFile("access.env")).replace(
        /^PRQ_ACCESS_CLIENT_SECRET=.*$/m,
        "PRQ_ACCESS_CLIENT_SECRET=",
      );
      await privateFile("access.env", blank);
      const rotate: [string, string] = ["Rotate prq-cli's secret?", "y\r"];
      const question = "Replace PRQ_ACCESS_CLIENT_SECRET in access.env?";

      const declined = await setup(["cloudflare"], [TOKEN_TURN, ["Rotate prq-cli's secret?", "n\r"]]);

      expect(declined.code).toBe(1);
      expect(declined.output).toContain("setup: kept prq-cli's secret; access.env does not hold it");
      expect(writes()).toEqual([]);

      const kept = await setup(["cloudflare"], [TOKEN_TURN, rotate, [question, "n\r"]]);

      expect(kept.code).toBe(1);
      expect(kept.output).toContain("setup: kept PRQ_ACCESS_CLIENT_SECRET in access.env; the secret was not rotated");
      expect(writes()).toEqual([]);
      expect(await envFile("access.env")).toBe(blank);

      const rotated = await setup(["cloudflare"], [TOKEN_TURN, rotate, [question, "y\r"]]);

      expect(rotated.code).toBe(0);
      expect(writes()).toEqual([
        `POST /accounts/${ACCOUNT}/access/service_tokens/${String(cf.tokens[0]?.["id"])}/rotate`,
      ]);
      expect(await envFile("access.env")).toContain(`PRQ_ACCESS_CLIENT_SECRET=${SECRET_PREFIX}`);
      const state = v.parse(JsonObject, JSON.parse(readFileSync(join(stateDir, "setup.json"), "utf8")));
      expect(state["serviceToken"]).toMatchObject({ id: cf.tokens[0]?.["id"], confirmed: false });
      cf.requests = [];

      const again = await setup(["cloudflare"], [TOKEN_TURN]);

      expect(again.code).toBe(0);
      expect(again.output).toContain(
        "its rotated secret is unconfirmed until first-deploy's edge check passes with it",
      );
      expect(writes()).toEqual([]);
    });

    it("records the secret as unconfirmed before the rotation is sent", async () => {
      await completed();
      await rm(join(directory, "access.env"));
      cf.lost = [`POST /accounts/${ACCOUNT}/access/service_tokens/${String(cf.tokens[0]?.["id"])}/rotate`];

      const result = await setup(["cloudflare"], [TOKEN_TURN, ["Rotate prq-cli's secret?", "y\r"]]);

      expect(result.code).toBe(2);
      const state = v.parse(JsonObject, JSON.parse(readFileSync(join(stateDir, "setup.json"), "utf8")));
      expect(state["serviceToken"]).toMatchObject({
        id: cf.tokens[0]?.["id"],
        clientId: cf.tokens[0]?.["client_id"],
        confirmed: false,
      });
    });

    it("refuses a token that reads back with another client ID", async () => {
      cf.tokenReadBack = "other";

      const result = await setup(["cloudflare"], FRESH);

      expect(result.code).toBe(1);
      expect(result.output).toContain("setup: the service token prq-cli does not read back as created");
    });

    it.each([
      ["answered 500", "lost" as const],
      ["answered 200 with a body that is not JSON", "garbled" as const],
    ])("leaves a create %s unconfirmed", async (_what, how) => {
      cf[how] = [`POST /accounts/${ACCOUNT}/access/service_tokens`];

      const result = await setup(["cloudflare"], FRESH);

      expect(result.code).toBe(2);
      expect(result.output).toContain("whether it changed is not known; run the step again");
      await expect(lstat(join(directory, "access.env"))).rejects.toThrow("ENOENT");
    });

    it("recovers a create whose answer was lost by rotation", async () => {
      cf.lost = [`POST /accounts/${ACCOUNT}/access/service_tokens`];

      const lost = await setup(["cloudflare"], FRESH);

      expect(lost.code).toBe(2);
      expect(cf.tokens).toHaveLength(1);
      cf.lost = [];

      const again = await setup(["cloudflare"], [TOKEN_TURN, ["Rotate prq-cli's secret?", "y\r"], EMAIL_TURN]);

      expect(again.code).toBe(0);
      expect(cf.tokens).toHaveLength(1);
      expect(await envFile("access.env")).toContain(`PRQ_ACCESS_CLIENT_ID=${String(cf.tokens[0]?.["client_id"])}\n`);
    });

    it("leaves a secret access.env cannot hold unconfirmed, writing nothing", async () => {
      cf.nextSecret = `${SECRET_PREFIX}with space`;

      const result = await setup(["cloudflare"], FRESH);

      expect(result.code).toBe(2);
      expect(result.output).toContain("setup: access.env: the service token holds characters access.env does not hold");
      expect(result.output).toContain("offers to rotate prq-cli's secret");
      await expect(lstat(join(directory, "access.env"))).rejects.toThrow("ENOENT");
    });

    it.each([
      ["disabled", { enabled: false }, "setup: the service token prq-cli is disabled"],
      [
        "expiring within 30 days",
        { expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString() },
        "setup: the service token prq-cli expires within 30 days",
      ],
    ])("refuses a token that is %s", async (_what, change, refusal) => {
      await privateFile("target.env", `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nPRQ_HOST=${HOST}\n`);
      cf.idps.push({ id: "idp-otp", type: "onetimepin", name: "One-time PIN" });
      cf.tokens.push({
        id: "token-1",
        name: "prq-cli",
        client_id: "client-1.access",
        enabled: true,
        expires_at: new Date(Date.now() + 300 * 86_400_000).toISOString(),
        ...change,
      });

      const result = await setup(["cloudflare"], [TOKEN_TURN]);

      expect(result.code).toBe(1);
      expect(result.output).toContain(refusal);
      expect(writes()).toEqual([]);
    });
  });

  it("stops at Ctrl-C at the token, sending nothing with it", async () => {
    const result = await setup(
      ["cloudflare"],
      [
        ["Hostname label [prq]: ", "\r"],
        [TOKEN_PROMPT, "sentinel-cf-api-token-part\u0003"],
      ],
    );

    expect(result.code).toBe(130);
    expect(cf.requests.map((each) => each.auth)).toEqual([`Bearer ${WRANGLER_TOKEN}`]);
  });
});
