// The setup's cloudflare step (docs/operations.md, Setup: Cloudflare): the account, the zone and the hostname, Workers
// Paid, the zone's settings that would get in prq's way, the Zero Trust organization, and prq's Access: the one-time PIN,
// the service token prq-cli, three reusable policies and two applications. Each part first reads what is there.
//
// - wrangler's login gives the accounts and, when its grant reads them, the zones; target.env records the account and
//   the hostname. Everything after that is read and written with an API token the owner creates for this run, scoped
//   to that account and zone (RECIPE), pasted at a prompt that does not echo, and held in this process alone.
// - Reads come before writes: the zone's reads before its one write (the Configuration Rule prq-no-rewrites, added only
//   when something could rewrite the hostname's HTML, and never changing another rule); the organization, then every
//   Access read (applications that cover the hostname or prq's Worker refuse) before any Access write.
// - Every create is read back; an existing policy or application that differs from what prq needs is refused, naming
//   the field (the step changes none it finds). A service token whose secret access.env does not hold is rotated only on
//   the owner's yes, and its secret is recorded as unconfirmed in the setup's state until first-deploy's edge check.
// - Records: CLOUDFLARE_ACCOUNT_ID and PRQ_HOST (target.env), ACCESS_TEAM_DOMAIN and ACCESS_AUD (worker.env), and
//   access.env (PRQ_URL and the service token).

import { constants } from "node:fs";
import { access } from "node:fs/promises";

import * as v from "valibot";

import { CloudflareApi, wranglerHeaders } from "./cloudflare-api.ts";
import { fixture } from "./fixture.ts";
import {
  ACCESS_ENV,
  answer,
  ask,
  askSecret,
  checkConfigAccount,
  DEPLOY_DIRECTORY,
  failed,
  print,
  privateDirectory,
  readEnvFile,
  Refusal,
  reveal,
  succeeded,
  TARGET_ENV,
  TOP_LEVEL,
  Unconfirmed,
  WORKER,
  WORKER_ENV,
  wrangler,
  writePrivate,
} from "./operations.ts";
import { readState, recordState } from "./setup-state.ts";

const TOKEN_NAME = "prq-cli";
const RULE_REF = "prq-no-rewrites";
const CONFIG_PHASE = "http_config_settings";
const OTP_NAME = "One-time PIN";
const POLICY = { owner: "prq owner", cli: "prq-cli", webhook: "prq webhook" } as const;
const APP = { main: "prq", webhook: "prq webhook" } as const;
const SESSION = "24h";
const TOKEN_DURATION = "8760h";
// A service token that expires within this is not taken as done.
const EXPIRY_MARGIN_MS = 30 * 24 * 60 * 60_000;
const API_TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";
const ZERO_TRUST = "https://one.dash.cloudflare.com/";
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// What access.env holds, so that sourcing it runs nothing: no space, quote or shell metacharacter.
const SOURCE_SAFE = /^[A-Za-z0-9._~+/=:@-]+$/;
// The token's permissions (docs/operations.md, Setup: Cloudflare). Each call names the one it needs.
const PERMISSION = {
  zone: "Zone Read (the zone)",
  dns: "DNS Read (the zone)",
  settings: "Zone Settings Read (the zone)",
  bot: "Bot Management Read (the zone)",
  pageRules: "Page Rules Read (the zone)",
  configRules: "Config Rules Edit (the zone)",
  billing: "Billing Read (the account)",
  rum: "Account Settings Read (the account)",
  workers: "Workers Scripts Read (the account)",
  organization: "Access: Organizations, Identity Providers, and Groups Write (the account)",
  apps: "Access: Apps and Policies Write (the account)",
  tokens: "Access: Service Tokens Write (the account)",
} as const;
const RECIPE = [
  `Account: Access: Organizations, Identity Providers, and Groups (Edit); Access: Apps and Policies (Edit); Access: Service Tokens (Edit); Account Settings (Read); Billing (Read); Workers Scripts (Read)`,
  `Zone: Zone (Read); DNS (Read); Zone Settings (Read); Bot Management (Read); Page Rules (Read); Config Rules (Edit)`,
];
// RECIPE's permissions as the dashboard's token template link names them (Cloudflare's docs, API token template URLs).
const RECIPE_KEYS = [
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
] as const;

// The profile's API Tokens page with RECIPE filled in for the account; the dashboard drops a key it does not know.
function tokenLink(accountId: string): string {
  const keys = JSON.stringify(RECIPE_KEYS.map(([key, type]) => ({ key, type })));
  const query = new URLSearchParams({ permissionGroupKeys: keys, accountId, zoneId: "all", name: "prq setup" });
  return `${API_TOKENS_PAGE}?${query.toString()}`;
}
// What turns a rewrite of the page off for the hostname.
const NO_REWRITES = { rocket_loader: false, email_obfuscation: false, disable_rum: true } as const;

// Only the tests' fixture sets a shorter wait for what the owner does in a browser.
const browserMs = fixture.stepMs ?? 30 * 60_000;

// The account, the hostname and its zone (the zone's ID once a list gave it).
type Target = { accountId: string; host: string; zone: string; zoneId: string | null };

const Accounts = v.array(v.object({ id: v.string(), name: v.optional(v.string()) }));
const Whoami = v.object({ loggedIn: v.optional(v.boolean()), accounts: v.optional(Accounts) });
const Zone = v.object({ id: v.string(), name: v.string() });

// The accounts wrangler's login reaches; null when it is not logged in.
async function loginAccounts(): Promise<v.InferOutput<typeof Accounts> | null> {
  const outcome = await wrangler(["whoami", "--json", ...TOP_LEVEL], "");
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), Whoami), outcome.stdout);
  if (parsed.success && parsed.output.loggedIn === false) {
    return null;
  }
  if (!succeeded(outcome)) {
    throw failed("whoami", outcome);
  }
  if (!parsed.success) {
    throw new Refusal("wrangler whoami did not answer in the shape this step reads");
  }
  return parsed.output.accounts ?? [];
}

// A choice among items listed by label, by number or by an item's name (any case); refused when none is chosen, or
// when the name is several items'.
async function choose(what: string, labels: readonly string[], names = labels): Promise<number> {
  for (const [index, label] of labels.entries()) {
    print(`  ${index + 1}. ${label}`);
  }
  const line = ((await ask(`${what} [1-${labels.length}]: `)) ?? "").trim();
  if (/^\d+$/.test(line)) {
    const chosen = Number(line);
    if (chosen < 1 || chosen > labels.length) {
      throw new Refusal(`no ${what.toLowerCase()} was chosen`);
    }
    return chosen - 1;
  }
  const named = names.flatMap((name, index) => (name.toLowerCase() === line.toLowerCase() ? [index] : []));
  if (named.length > 1) {
    throw new Refusal(`${named.length} ${what.toLowerCase()}s are named ${line}: choose one by its number`);
  }
  const [index] = named;
  if (index === undefined) {
    throw new Refusal(`no ${what.toLowerCase()} was chosen`);
  }
  return index;
}

// The zones of the account as wrangler's login lists them; null when its grant does not read them.
async function loginZones(accountId: string): Promise<v.InferOutput<typeof Zone>[] | null> {
  try {
    const api = new CloudflareApi(await wranglerHeaders(accountId));
    return await api.list(
      `/zones?account.id=${accountId}`,
      { what: "the account's zones", permission: "zone:read" },
      Zone,
    );
  } catch (error) {
    if (!(error instanceof Refusal)) {
      throw error;
    }
    print(`cloudflare: wrangler's login does not list the zones (${error.lines.join("; ")})`);
    return null;
  }
}

// Step 1: wrangler's login, the account and the zone, then the hostname; recorded in target.env.
async function chooseTarget(): Promise<Target> {
  let accounts = await loginAccounts();
  if (accounts === null) {
    print("cloudflare: wrangler is not logged in: allow its access in the browser it opens");
    const outcome = await wrangler(["login", ...TOP_LEVEL], "", { foreground: true, timeoutMs: browserMs });
    if (!succeeded(outcome)) {
      throw new Refusal(`wrangler login did not finish (${outcome.timedOut ? "its wait passed" : "it failed"})`);
    }
    accounts = await loginAccounts();
    if (accounts === null) {
      throw new Refusal("wrangler is still not logged in");
    }
  }
  const target = (await readEnvFile(TARGET_ENV)) ?? new Map<string, string>();
  const storedAccount = target.get("CLOUDFLARE_ACCOUNT_ID");
  let accountId: string;
  if (storedAccount !== undefined) {
    if (!accounts.some((each) => each.id === storedAccount)) {
      throw new Refusal(
        `wrangler's login does not reach the account ${TARGET_ENV} names: log wrangler in to it (pnpm --dir packages/server exec wrangler login)`,
      );
    }
    accountId = storedAccount;
  } else if (accounts.length === 0) {
    throw new Refusal("wrangler's login reaches no account");
  } else if (accounts.length === 1) {
    accountId = accounts[0]?.id ?? "";
  } else {
    const index = await choose(
      "Account",
      accounts.map((each) => `${each.name ?? "unnamed"} (${each.id})`),
      accounts.map((each) => each.name ?? ""),
    );
    accountId = accounts[index]?.id ?? "";
  }
  const name = accounts.find((each) => each.id === accountId)?.name ?? "unnamed";
  await checkConfigAccount(accountId);

  const zones = await loginZones(accountId);
  const storedHost = target.get("PRQ_HOST")?.toLowerCase();
  let zone: string;
  let host: string;
  if (storedHost !== undefined) {
    const listed = (zones ?? [])
      .filter((each) => storedHost === each.name || storedHost.endsWith(`.${each.name}`))
      .toSorted((a, b) => b.name.length - a.name.length)[0];
    zone = listed?.name ?? (await askZone(storedHost.slice(storedHost.indexOf(".") + 1)));
    host = storedHost;
  } else {
    if (zones !== null && zones.length === 0) {
      throw new Refusal("the account has no zone: add one, then run setup cloudflare again");
    }
    if (zones === null) {
      zone = await askZone(null);
    } else if (zones.length === 1) {
      zone = zones[0]?.name ?? "";
    } else {
      zone =
        zones[
          await choose(
            "Zone",
            zones.map((each) => each.name),
          )
        ]?.name ?? "";
    }
    const label = ((await ask("Hostname label [prq]: ")) ?? "").trim().toLowerCase() || "prq";
    if (!LABEL.test(label)) {
      throw new Refusal("the label is not one DNS label (letters, digits and hyphens)");
    }
    host = `${label}.${zone}`;
  }
  if (!HOST.test(host) || (host !== zone && !host.endsWith(`.${zone}`))) {
    throw new Refusal(`${host} is not a hostname in the zone ${zone}`);
  }
  const zoneId = zones?.find((each) => each.name === zone)?.id ?? null;
  const changed = await writePrivate(TARGET_ENV, { CLOUDFLARE_ACCOUNT_ID: accountId, PRQ_HOST: host });
  // Not secrets: the owner checks them here, before creating the token for them.
  reveal([accountId, host]);
  print(
    `cloudflare: account ${name} (${accountId}), zone ${zone}, hostname ${host}${changed.length > 0 ? `; wrote ${changed.join(", ")} to ${TARGET_ENV}` : ""}`,
  );
  return { accountId, host, zone, zoneId };
}

async function askZone(suggested: string | null): Promise<string> {
  const typed = ((await ask(`Zone${suggested === null ? " (such as example.com)" : ` [${suggested}]`}: `)) ?? "")
    .trim()
    .toLowerCase();
  const zone = typed === "" ? (suggested ?? "") : typed;
  if (!HOST.test(zone)) {
    throw new Refusal("the zone is not a domain name");
  }
  return zone;
}

const Verified = v.object({ status: v.string() });

// The token's verification at the user's endpoint. A token made on an account's API Tokens page is invalid there; it is
// refused with where to make one, since the Page Rules endpoint does not take account-owned tokens (error 1011).
async function verify(api: CloudflareApi, accountId: string): Promise<v.InferOutput<typeof Verified> | null> {
  const call = { what: "the token's verification", permission: "no permission (the token must be active)" };
  try {
    return await api.get("/user/tokens/verify", call, Verified);
  } catch (error) {
    // Only Cloudflare's refusal of the credentials is probed; a timeout or another answer stands as it is.
    if (!(error instanceof Refusal) || !error.message.startsWith("Cloudflare's API did not accept the credentials")) {
      throw error;
    }
    const owned = await api.get(`/accounts/${accountId}/tokens/verify`, call, Verified).catch(() => null);
    if (owned !== null) {
      throw new Refusal(
        `the token was made on the account's API Tokens page, and the zone's Page Rules are not read with such a token: make it at ${API_TOKENS_PAGE} (My Profile)`,
      );
    }
    throw error;
  }
}

// Step 2: the token, from the printed recipe, checked active and scoped to the zone.
async function token(target: Target): Promise<{ api: CloudflareApi; zoneId: string }> {
  print(
    `cloudflare: create an API token from this link, which fills its permissions in: ${tokenLink(target.accountId)}`,
  );
  print(
    `cloudflare: there, check it has these permissions, set its zone resources to only the zone ${target.zone} and its TTL to end tomorrow (Cloudflare ends it at that date's 00:00 UTC):`,
  );
  for (const line of RECIPE) {
    print(`  ${line}`);
  }
  print("cloudflare: it is used in this run alone and kept nowhere; delete it when the step ends");
  const typed = await askSecret("Cloudflare API token (not shown): ", browserMs);
  if (!/^[\x21-\x7e]+$/.test(typed)) {
    throw new Refusal("the token is not one line of printable characters without spaces; nothing was sent");
  }
  const api = new CloudflareApi({ Authorization: `Bearer ${typed}` });
  const verified = await verify(api, target.accountId);
  if (verified?.status !== "active") {
    throw new Refusal(`Cloudflare does not take the token as active (${verified?.status ?? "not found"})`);
  }
  const found = await api.list(
    `/zones?name=${encodeURIComponent(target.zone)}&account.id=${target.accountId}`,
    { what: `the zone ${target.zone}`, permission: PERMISSION.zone },
    Zone,
  );
  const zone = found.find((each) => each.name === target.zone);
  if (zone === undefined || (target.zoneId !== null && zone.id !== target.zoneId)) {
    throw new Refusal(
      `the token does not read the zone ${target.zone} on the account: scope its zone resources to it (${PERMISSION.zone})`,
    );
  }
  print("cloudflare: the token is active and reads the zone");
  return { api, zoneId: zone.id };
}

const Subscription = v.object({
  state: v.optional(v.string()),
  rate_plan: v.optional(v.object({ id: v.optional(v.string()), public_name: v.optional(v.string()) })),
});
type Subscription = v.InferOutput<typeof Subscription>;

function workersPaid(each: Subscription): boolean {
  const named =
    each.rate_plan?.id?.toUpperCase() === "WORKERS_PAID" || /workers paid/i.test(each.rate_plan?.public_name ?? "");
  return named && ["Paid", "Provisioned"].includes(each.state ?? "");
}

// Step 3: Workers Paid on the account, subscribed in the dashboard when missing.
async function workersPlan(api: CloudflareApi, accountId: string): Promise<void> {
  const call = { what: "the account's subscriptions", permission: PERMISSION.billing };
  const read = async () => (await api.get(`/accounts/${accountId}/subscriptions`, call, v.array(Subscription))) ?? [];
  let listed = await read();
  if (listed.some(workersPaid)) {
    print("cloudflare: Workers Paid: pass");
    return;
  }
  print(
    `cloudflare: the account has no Workers Paid subscription: add a billing profile and subscribe at https://dash.cloudflare.com/${accountId}/workers/plans`,
  );
  if (!(await answer("Subscribed to Workers Paid? [y/N] ", browserMs))) {
    throw new Refusal("the account has no Workers Paid subscription");
  }
  listed = await read();
  if (listed.some(workersPaid)) {
    print("cloudflare: Workers Paid: pass");
    return;
  }
  const names = listed.map(
    (each) => `${each.rate_plan?.public_name ?? each.rate_plan?.id ?? "unnamed"} (${each.state ?? "no state"})`,
  );
  if (names.length > 0) {
    print(`cloudflare: the account's subscriptions: ${names.join(", ")}`);
    if (await answer("Is one of these the account's Workers Paid plan, paid? [y/N] ")) {
      print("cloudflare: Workers Paid: pass (as you said)");
      return;
    }
  }
  throw new Refusal("the account has no Workers Paid subscription that this step can find");
}

const Setting = v.object({ value: v.unknown() });
const DnsRecord = v.object({ type: v.string(), name: v.string() });
const Domain = v.object({ hostname: v.string(), service: v.optional(v.string()), zone_id: v.optional(v.string()) });
const Site = v.object({
  auto_install: v.optional(v.boolean()),
  ruleset: v.nullish(v.object({ zone_tag: v.optional(v.string()), enabled: v.optional(v.boolean()) })),
});
const PageRule = v.object({
  status: v.optional(v.string()),
  targets: v.optional(
    v.array(
      v.object({
        constraint: v.optional(v.object({ operator: v.optional(v.string()), value: v.optional(v.string()) })),
      }),
    ),
    [],
  ),
  actions: v.optional(v.array(v.object({ id: v.string(), value: v.optional(v.unknown()) })), []),
});
type PageTarget = v.InferOutput<typeof PageRule>["targets"][number];

// A Page Rule URL that names its host: an optional http:// or https://, a hostname with * wildcards, and an optional
// path.
const PAGE_URL = /^(?:https?:\/\/)?([a-z0-9*.-]+)(?:\/.*)?$/i;

// Whether a Page Rule's target can be ruled out for host: only a URL pattern (matches, each alternative) or an exact URL
// (equals) whose alternatives all read as URLs of other hosts. contains, not_equal, not_contain, a URL read otherwise
// (a wildcard scheme such as http*://, a port) and anything else may match it.
function pageRuleMayMatch(target: PageTarget, host: string): boolean {
  const operator = target.constraint?.operator ?? "matches";
  const value = target.constraint?.value ?? "*";
  if (operator !== "matches" && operator !== "equals") {
    return true;
  }
  return value.split("|").some((each) => {
    const named = PAGE_URL.exec(each.trim())?.[1];
    return named === undefined || covers(named, host);
  });
}

const Rule = v.object({
  id: v.string(),
  ref: v.optional(v.string()),
  expression: v.optional(v.string()),
  action: v.optional(v.string()),
  action_parameters: v.optional(v.record(v.string(), v.unknown())),
  enabled: v.optional(v.boolean()),
});
type Rule = v.InferOutput<typeof Rule>;
const Ruleset = v.object({ id: v.string(), rules: v.optional(v.array(Rule), []) });

// Whether a host pattern (as a page rule's target or an Access destination writes it, with * for any characters and
// an optional scheme and path) covers host.
function covers(pattern: string, host: string): boolean {
  const hostPart =
    pattern
      .replace(/^[a-z]+:\/\//i, "")
      .split("/")[0]
      ?.split(":")[0]
      ?.toLowerCase() ?? "";
  const glob = hostPart.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${glob.join(".*")}$`).test(host);
}

// Whether an expression names a single other host alone, so that it cannot match host.
function otherHostOnly(expression: string, host: string): boolean {
  const named = /^\s*http\.host\s+eq\s+"([^"]+)"\s*$/.exec(expression)?.[1];
  return named !== undefined && named.toLowerCase() !== host;
}

// Whether a rule could turn one of the rewrites on for host.
function rewritesOn(rule: Rule, host: string): boolean {
  const params = rule.action_parameters ?? {};
  return (
    rule.action === "set_config" &&
    rule.enabled !== false &&
    (params["rocket_loader"] === true || params["email_obfuscation"] === true || params["disable_rum"] === false) &&
    !otherHostOnly(rule.expression ?? "", host)
  );
}

function ruleExpression(host: string): string {
  return `http.host eq "${host}"`;
}

function isOurs(rule: Rule, host: string): boolean {
  return (
    rule.action === "set_config" &&
    rule.enabled !== false &&
    rule.expression === ruleExpression(host) &&
    Object.entries(NO_REWRITES).every(([key, value]) => rule.action_parameters?.[key] === value)
  );
}

// Step 4: the zone's checks, and the rule when something could rewrite the hostname's page.
async function zoneChecks(api: CloudflareApi, target: Target, zoneId: string): Promise<void> {
  const { host, accountId } = target;
  const zonePath = `/zones/${zoneId}`;
  const bot = await api.get(
    `${zonePath}/bot_management`,
    { what: "the zone's Bot Fight Mode", permission: PERMISSION.bot },
    v.object({ fight_mode: v.optional(v.boolean()) }),
  );
  if (bot?.fight_mode === true) {
    throw new Refusal(
      "Bot Fight Mode is on for the zone, and it challenges prq and GitHub's webhook deliveries: choose another zone, turn it off for the zone, or move the zone to Pro and use Super Bot Fight Mode with a skip rule for the hostname (docs/operations.md, Setup)",
    );
  }
  print("cloudflare: Bot Fight Mode: pass");

  const records = await api.list(
    `${zonePath}/dns_records?name=${encodeURIComponent(host)}`,
    { what: `the DNS records of ${host}`, permission: PERMISSION.dns },
    DnsRecord,
  );
  const own = records.filter((each) => each.name.toLowerCase() === host);
  if (own.length > 0) {
    const domains = await api.list(
      `/accounts/${accountId}/workers/domains?zone_id=${zoneId}&hostname=${encodeURIComponent(host)}`,
      { what: "the Workers custom domains", permission: PERMISSION.workers },
      Domain,
    );
    if (!domains.some((each) => each.hostname.toLowerCase() === host && each.service === WORKER)) {
      throw new Refusal(
        `${host} has a DNS record (${own.map((each) => each.type).join(", ")}) that is not the Worker ${WORKER}'s custom domain: remove it, or choose another label`,
      );
    }
    print(`cloudflare: DNS: ${host} is the Worker ${WORKER}'s custom domain`);
  } else {
    print(`cloudflare: DNS: ${host} has no record`);
  }

  const reasons: string[] = [];
  for (const name of ["rocket_loader", "email_obfuscation"]) {
    const setting = await api.get(
      `${zonePath}/settings/${name}`,
      { what: `the zone's ${name} setting`, permission: PERMISSION.settings },
      Setting,
    );
    if (setting?.value !== "off") {
      reasons.push(`the zone's ${name} is ${typeof setting?.value === "string" ? setting.value : "unreadable"}`);
    }
  }
  const sites = await api.list(
    `/accounts/${accountId}/rum/site_info/list`,
    { what: "the account's Web Analytics sites", permission: PERMISSION.rum },
    Site,
  );
  if (
    sites.some(
      (each) => each.auto_install !== false && each.ruleset?.zone_tag === zoneId && each.ruleset.enabled !== false,
    )
  ) {
    reasons.push("Web Analytics injects its script in the zone");
  }
  const pageRules =
    (await api.get(
      `${zonePath}/pagerules?status=active`,
      { what: "the zone's Page Rules", permission: PERMISSION.pageRules },
      v.array(PageRule),
    )) ?? [];
  if (
    pageRules.some(
      (rule) =>
        rule.status !== "disabled" &&
        rule.targets.some((each) => pageRuleMayMatch(each, host)) &&
        rule.actions.some((each) => ["rocket_loader", "email_obfuscation"].includes(each.id) && each.value !== "off"),
    )
  ) {
    reasons.push(`a Page Rule turns a rewrite on for ${host}`);
  }
  const entryPath = `${zonePath}/rulesets/phases/${CONFIG_PHASE}/entrypoint`;
  const entryCall = { what: "the zone's Configuration Rules", permission: PERMISSION.configRules };
  const entry = await api.get(entryPath, entryCall, Ruleset);
  const others = (entry?.rules ?? []).filter((rule) => rule.ref !== RULE_REF);
  if (others.some((rule) => rewritesOn(rule, host))) {
    reasons.push(`a Configuration Rule could turn a rewrite on for ${host}`);
  }
  const ours = (entry?.rules ?? []).find((rule) => rule.ref === RULE_REF);
  if (ours !== undefined && ours.expression !== ruleExpression(host)) {
    throw new Refusal(
      `the zone's Configuration Rule ${RULE_REF} matches another expression than ${ruleExpression(host)} (another hostname's): remove it or choose that hostname`,
    );
  }
  if (ours === undefined && reasons.length === 0) {
    print(`cloudflare: HTML rewrites: none for ${host}`);
    return;
  }
  print(`cloudflare: HTML rewrites: ${reasons.length > 0 ? reasons.join("; ") : "none now"}`);
  const rule = {
    ref: RULE_REF,
    description: `prq: no HTML rewrites on ${host}`,
    expression: ruleExpression(host),
    action: "set_config",
    action_parameters: NO_REWRITES,
    enabled: true,
  };
  const write = { what: `the Configuration Rule ${RULE_REF}`, permission: PERMISSION.configRules };
  if (entry === null) {
    await api.send(
      "POST",
      `${zonePath}/rulesets`,
      { ...write, body: { name: "default", kind: "zone", phase: CONFIG_PHASE, rules: [rule] } },
      Ruleset,
    );
    print(`cloudflare: created the zone's Configuration Rules with ${RULE_REF}`);
  } else if (ours === undefined) {
    await api.send("POST", `${zonePath}/rulesets/${entry.id}/rules`, { ...write, body: rule }, Ruleset);
    print(`cloudflare: added the Configuration Rule ${RULE_REF}, last`);
  } else if (!isOurs(ours, host)) {
    await api.send("PATCH", `${zonePath}/rulesets/${entry.id}/rules/${ours.id}`, { ...write, body: rule }, Ruleset);
    print(`cloudflare: updated the Configuration Rule ${RULE_REF}`);
  }
  const after = (await api.get(entryPath, entryCall, Ruleset))?.rules ?? [];
  const index = after.findIndex((each) => each.ref === RULE_REF);
  const read = after[index];
  if (read === undefined || !isOurs(read, host)) {
    throw new Refusal(`the Configuration Rule ${RULE_REF} does not read back as written`);
  }
  const later = after.slice(index + 1).filter((each) => rewritesOn(each, host));
  if (later.length > 0) {
    throw new Refusal(
      `the Configuration Rule${later.length === 1 ? "" : "s"} ${later.map((each) => each.id).join(", ")} after ${RULE_REF} could turn a rewrite on again for ${host}: change ${later.length === 1 ? "it" : "them"}, or move ${RULE_REF} after ${later.length === 1 ? "it" : "them"}`,
    );
  }
  print(`cloudflare: the Configuration Rule ${RULE_REF}: pass`);
}

const Organization = v.looseObject({
  auth_domain: v.optional(v.string()),
  strict_service_token_auth: v.optional(v.boolean()),
});
type Organization = v.InferOutput<typeof Organization>;

// Step 5: the Zero Trust organization, made in the dashboard when missing.
async function organization(api: CloudflareApi, accountId: string): Promise<Organization & { auth_domain: string }> {
  const path = `/accounts/${accountId}/access/organizations`;
  const call = { what: "the Zero Trust organization", permission: PERMISSION.organization };
  let found = await api.get(path, call, v.nullable(Organization));
  if (found?.auth_domain === undefined) {
    print(
      `cloudflare: the account has no Zero Trust organization: in ${ZERO_TRUST}, choose a team name and the Free plan, and finish its payment step`,
    );
    if (!(await answer("Is the Zero Trust organization made? [y/N] ", browserMs))) {
      throw new Refusal("the account has no Zero Trust organization");
    }
    found = await api.get(path, call, v.nullable(Organization));
  }
  const domain = found?.auth_domain;
  if (found === null || found === undefined || domain === undefined) {
    throw new Refusal("the account still has no Zero Trust organization that this step can read");
  }
  print(`cloudflare: Zero Trust organization ${domain}`);
  return { ...found, auth_domain: domain };
}

// Strict service token authentication, turned on (on the owner's yes) when the organization has it off.
async function strictMode(api: CloudflareApi, accountId: string, found: Organization): Promise<void> {
  const path = `/accounts/${accountId}/access/organizations`;
  const call = { what: "the Zero Trust organization", permission: PERMISSION.organization };
  if (found.strict_service_token_auth === true) {
    print("cloudflare: strict service token authentication: pass");
    return;
  }
  print(
    "cloudflare: strict service token authentication is off: turning it on applies to every Access application on the account: a request with service token headers is then let in only by a Service Auth policy (an integration whose service token an Allow policy lets in loses access), a bad token is refused instead of sent to sign-in, and no session cookie is returned",
  );
  if (!(await answer("Turn strict service token authentication on for the account? [y/N] "))) {
    throw new Refusal(
      "kept strict service token authentication off: first-deploy's edge check E2 (a bad service token refused) cannot pass on this account; another account is the alternative",
    );
  }
  // This one field alone, as Cloudflare documents turning it on: every other setting stays as it is now.
  await api.send("PATCH", path, { ...call, body: { strict_service_token_auth: true } }, Organization);
  const read = await api.get(path, call, v.nullable(Organization));
  if (read?.strict_service_token_auth !== true || read.auth_domain !== found.auth_domain) {
    throw new Refusal("the organization does not read back with strict service token authentication on");
  }
  print("cloudflare: turned strict service token authentication on");
}

const Destination = v.looseObject({
  type: v.optional(v.string()),
  uri: v.optional(v.string()),
  worker_id: v.optional(v.string()),
});
const AppPolicy = v.looseObject({ id: v.optional(v.string()), precedence: v.optional(v.number()) });
const Application = v.looseObject({
  id: v.string(),
  name: v.optional(v.string()),
  type: v.optional(v.string()),
  domain: v.optional(v.string()),
  aud: v.optional(v.string()),
  destinations: v.nullish(v.array(Destination)),
  self_hosted_domains: v.nullish(v.array(v.string())),
  session_duration: v.optional(v.string()),
  allowed_idps: v.nullish(v.array(v.string())),
  policies: v.nullish(v.array(AppPolicy)),
});
type Application = v.InferOutput<typeof Application>;
const IdentityProvider = v.object({ id: v.string(), type: v.string(), name: v.optional(v.string()) });
const ServiceToken = v.object({
  id: v.string(),
  name: v.string(),
  client_id: v.string(),
  enabled: v.optional(v.boolean()),
  expires_at: v.nullish(v.string()),
});
type ServiceToken = v.InferOutput<typeof ServiceToken>;
const NewSecret = v.object({ id: v.string(), client_id: v.string(), client_secret: v.string() });
const Policy = v.looseObject({
  id: v.string(),
  name: v.optional(v.string()),
  decision: v.optional(v.string()),
  include: v.nullish(v.array(v.record(v.string(), v.unknown()))),
  exclude: v.nullish(v.array(v.unknown())),
  require: v.nullish(v.array(v.unknown())),
});
type Policy = v.InferOutput<typeof Policy>;

// What Access holds that prq's part depends on, all read before anything is written.
type AccessState = {
  apps: Application[];
  providers: v.InferOutput<typeof IdentityProvider>[];
  tokens: ServiceToken[];
  policies: Policy[];
};

function patterns(app: Application): string[] {
  return [
    ...(app.domain === undefined ? [] : [app.domain]),
    ...(app.self_hosted_domains ?? []),
    ...(app.destinations ?? []).flatMap((each) =>
      (each.type ?? "public") === "public" && each.uri !== undefined ? [each.uri] : [],
    ),
  ];
}

// Step 6: Access's applications, login methods, service tokens and policies; refused when another application covers
// the hostname or prq's Worker.
async function readAccess(api: CloudflareApi, target: Target): Promise<AccessState> {
  const base = `/accounts/${target.accountId}`;
  const worker = await api.get(
    `${base}/workers/workers/${WORKER}`,
    { what: `the Worker ${WORKER}`, permission: PERMISSION.workers },
    v.looseObject({ id: v.optional(v.string()) }),
  );
  const apps = await api.list(
    `${base}/access/apps`,
    { what: "the Access applications", permission: PERMISSION.apps },
    Application,
  );
  const providers = await api.list(
    `${base}/access/identity_providers`,
    { what: "the Access login methods", permission: PERMISSION.organization },
    IdentityProvider,
  );
  const tokens = await namedTokens(api, target.accountId, "the Access service tokens");
  const policies = await api.list(
    `${base}/access/policies`,
    { what: "the Access policies", permission: PERMISSION.apps },
    Policy,
  );
  const workerIds = [WORKER, ...(worker?.id === undefined ? [] : [worker.id])];
  for (const app of apps) {
    const name = app.name ?? app.id;
    const destinations = app.destinations ?? [];
    if (destinations.some((each) => each.type === "all_workers")) {
      throw new Refusal(
        `the Access application "${name}" covers every Worker, and Worker-level Access answers the web UI's WebSocket 403: narrow it`,
      );
    }
    if (
      destinations.some(
        (each) => ["worker", "preview_worker"].includes(each.type ?? "") && workerIds.includes(each.worker_id ?? ""),
      )
    ) {
      throw new Refusal(
        `the Access application "${name}" covers the Worker ${WORKER}, and Worker-level Access answers the web UI's WebSocket 403: remove that destination`,
      );
    }
    const own = ownDomain(app.name, target.host);
    if (own !== null) {
      // prq's own name: taken only for an application of prq's type at prq's exact destination.
      const uris = (app.destinations ?? []).map((each) => `${each.type ?? "public"} ${normalize(each.uri ?? "")}`);
      if (
        app.type !== "self_hosted" ||
        normalize(app.domain ?? "") !== own ||
        uris.length !== 1 ||
        uris[0] !== `public ${own}`
      ) {
        throw new Refusal(
          `the Access application "${name}" has prq's name but is not prq's (a ${app.type ?? "typeless"} application for ${app.domain ?? "no domain"}): rename or remove it`,
        );
      }
      continue;
    }
    if (patterns(app).some((each) => covers(each, target.host))) {
      throw new Refusal(
        `the Access application "${name}" covers ${target.host} (at some path): narrow it, or choose another hostname`,
      );
    }
  }
  for (const name of [APP.main, APP.webhook]) {
    if (apps.filter((each) => each.name === name).length > 1) {
      throw new Refusal(`the account has more than one Access application named "${name}": keep one`);
    }
  }
  if (tokens.length > 1) {
    throw new Refusal(`the account has more than one service token named ${TOKEN_NAME}: keep one`);
  }
  for (const name of Object.values(POLICY)) {
    if (policies.filter((each) => each.name === name).length > 1) {
      throw new Refusal(`the account has more than one Access policy named "${name}": keep one`);
    }
  }
  print(`cloudflare: Access: no other application covers ${target.host} or the Worker ${WORKER}`);
  return { apps, providers, tokens, policies };
}

// The destination of the application named name when it is one of prq's, else null.
function ownDomain(name: string | undefined, host: string): string | null {
  return name === APP.main ? host : name === APP.webhook ? `${host}/webhook` : null;
}

// The service tokens named prq-cli, from every page of the list (its name filter, then the exact name).
async function namedTokens(api: CloudflareApi, accountId: string, what: string): Promise<ServiceToken[]> {
  const listed = await api.list(
    `/accounts/${accountId}/access/service_tokens?name=${TOKEN_NAME}`,
    { what, permission: PERMISSION.tokens },
    ServiceToken,
  );
  return listed.filter((each) => each.name === TOKEN_NAME);
}

// The one-time PIN login method, added when missing (on the owner's yes when other applications would offer it too).
async function oneTimePin(api: CloudflareApi, accountId: string, state: AccessState): Promise<string> {
  const found = state.providers.find((each) => each.type === "onetimepin");
  if (found !== undefined) {
    print("cloudflare: the one-time PIN login method: pass");
    return found.id;
  }
  // Every application that allows every login method, prq's own included (one this step would take as it is).
  const offering = state.apps.filter((each) => (each.allowed_idps ?? []).length === 0);
  if (offering.length > 0) {
    print(
      `cloudflare: the account has no one-time PIN login method; adding it would also offer it on ${offering.map((each) => `"${each.name ?? each.id}"`).join(", ")}, which allow every login method`,
    );
    if (!(await answer("Add the one-time PIN login method to the account? [y/N] "))) {
      throw new Refusal("kept the account without the one-time PIN login method, which prq signs in with");
    }
  }
  const path = `/accounts/${accountId}/access/identity_providers`;
  const call = { what: "the one-time PIN login method", permission: PERMISSION.organization };
  const created = await api.send(
    "POST",
    path,
    { ...call, body: { name: OTP_NAME, type: "onetimepin", config: {} } },
    IdentityProvider,
  );
  const read = await api.get(`${path}/${created.id}`, call, IdentityProvider);
  if (read?.type !== "onetimepin") {
    throw new Refusal("the one-time PIN login method does not read back");
  }
  print("cloudflare: added the one-time PIN login method");
  return created.id;
}

function expiresSoon(each: ServiceToken): boolean {
  const at = each.expires_at === null || each.expires_at === undefined ? Number.NaN : Date.parse(each.expires_at);
  return !Number.isNaN(at) && at - Date.now() < EXPIRY_MARGIN_MS;
}

// The service token as Access lists it now: one, with this ID and client ID, enabled, not expiring soon.
async function readBackToken(api: CloudflareApi, accountId: string, id: string, clientId: string): Promise<void> {
  const listed = await namedTokens(api, accountId, "the service token");
  const read = listed[0];
  if (listed.length !== 1 || read?.id !== id || read.client_id !== clientId) {
    throw new Refusal(`the service token ${TOKEN_NAME} does not read back as created`);
  }
  if (read.enabled === false || expiresSoon(read)) {
    throw new Refusal(
      `the service token ${TOKEN_NAME} reads back ${read.enabled === false ? "disabled" : "expiring within 30 days"}`,
    );
  }
}

// The names of access.env a new secret replaces, each agreed to before Access makes the secret, which it shows only
// once: a no after would lose it. The client ID is the one the secret comes with, when known.
async function agreeReplacements(
  stored: ReadonlyMap<string, string>,
  url: string,
  clientId: string | undefined,
  unsent: string,
): Promise<string[]> {
  const next = { PRQ_URL: url, PRQ_ACCESS_CLIENT_ID: clientId, PRQ_ACCESS_CLIENT_SECRET: undefined };
  const replace: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    const found = stored.get(key);
    if (found === undefined || found === value) {
      continue;
    }
    if (!(await answer(`Replace ${key} in ${ACCESS_ENV}? [y/N] `))) {
      throw new Refusal(`kept ${key} in ${ACCESS_ENV}; ${unsent}`);
    }
    replace.push(key);
  }
  return replace;
}

// access.env from a secret Access just returned, which exists nowhere else: written before anything else happens,
// replacing the names agreed to (agreeReplacements).
async function writeAccessEnv(
  host: string,
  secret: v.InferOutput<typeof NewSecret>,
  replace: readonly string[],
  lost: string,
): Promise<void> {
  try {
    if (!SOURCE_SAFE.test(secret.client_id) || !SOURCE_SAFE.test(secret.client_secret)) {
      throw new Refusal("the service token holds characters access.env does not hold");
    }
    await writePrivate(
      ACCESS_ENV,
      {
        PRQ_URL: `https://${host}`,
        PRQ_ACCESS_CLIENT_ID: secret.client_id,
        PRQ_ACCESS_CLIENT_SECRET: secret.client_secret,
      },
      { replace },
    );
  } catch (error) {
    const lines = error instanceof Refusal ? error.lines : ["could not write it"];
    throw new Unconfirmed(...lines.map((line) => `${ACCESS_ENV}: ${line}`), lost);
  }
}

// Step 7: the service token prq-cli and access.env.
async function serviceToken(api: CloudflareApi, target: Target, state: AccessState): Promise<string> {
  const base = `/accounts/${target.accountId}/access/service_tokens`;
  const call = { what: `the service token ${TOKEN_NAME}`, permission: PERMISSION.tokens };
  const stored = (await readEnvFile(ACCESS_ENV)) ?? new Map<string, string>();
  const found = state.tokens[0];
  const url = `https://${target.host}`;
  if (found === undefined) {
    const replace = await agreeReplacements(stored, url, undefined, "nothing was created");
    await privateDirectory({ make: true });
    await access(DEPLOY_DIRECTORY, constants.W_OK).catch(() => {
      throw new Refusal("the deploy directory is not writable; nothing was created");
    });
    const created = await api.send(
      "POST",
      base,
      { ...call, body: { name: TOKEN_NAME, duration: TOKEN_DURATION } },
      NewSecret,
    );
    await writeAccessEnv(
      target.host,
      created,
      replace,
      `its secret is lost: run setup cloudflare again, which offers to rotate ${TOKEN_NAME}'s secret`,
    );
    print(`cloudflare: created the service token ${TOKEN_NAME} and wrote ${ACCESS_ENV}`);
    await readBackToken(api, target.accountId, created.id, created.client_id);
    return created.id;
  }
  if (found.enabled === false) {
    throw new Refusal(
      `the service token ${TOKEN_NAME} is disabled (Zero Trust → Access controls → Service credentials): enable it, rotating its secret first if it was reported leaked, then run setup cloudflare again`,
    );
  }
  if (expiresSoon(found)) {
    throw new Refusal(
      `the service token ${TOKEN_NAME} expires within 30 days: refresh it (Zero Trust → Access controls → Service credentials → ${TOKEN_NAME} → Refresh), then run setup cloudflare again`,
    );
  }
  if (stored.get("PRQ_ACCESS_CLIENT_ID") === found.client_id && (stored.get("PRQ_ACCESS_CLIENT_SECRET") ?? "") !== "") {
    await writePrivate(ACCESS_ENV, { PRQ_URL: url });
    const recorded = v.safeParse(
      v.object({ id: v.string(), confirmed: v.boolean() }),
      (await readState())["serviceToken"],
    );
    const unconfirmed = recorded.success && recorded.output.id === found.id && !recorded.output.confirmed;
    print(
      `cloudflare: the service token ${TOKEN_NAME}: pass${unconfirmed ? " (its rotated secret is unconfirmed until first-deploy's edge check passes with it)" : ""}`,
    );
    return found.id;
  }
  print(
    `cloudflare: the service token ${TOKEN_NAME} exists, but ${ACCESS_ENV} ${stored.has("PRQ_ACCESS_CLIENT_ID") ? "holds another client ID" : "does not hold its secret"}, which Access shows only once`,
  );
  if (!(await answer(`Rotate ${TOKEN_NAME}'s secret? Its current secret stops working. [y/N] `))) {
    throw new Refusal(`kept ${TOKEN_NAME}'s secret; ${ACCESS_ENV} does not hold it`);
  }
  // The client ID stays the same across a rotation.
  const replace = await agreeReplacements(stored, url, found.client_id, "the secret was not rotated");
  await privateDirectory({ make: true });
  // Recorded before the rotation is sent: a stop at any point after leaves no rotated secret taken as confirmed.
  await recordState("serviceToken", {
    id: found.id,
    clientId: found.client_id,
    confirmed: false,
    rotatedAt: new Date().toISOString(),
  });
  const rotated = await api.send("POST", `${base}/${found.id}/rotate`, { ...call, body: {} }, NewSecret);
  await writeAccessEnv(
    target.host,
    rotated,
    replace,
    `the rotated secret is lost: run setup cloudflare again, which offers to rotate it again`,
  );
  print(
    `cloudflare: rotated ${TOKEN_NAME}'s secret and wrote ${ACCESS_ENV}; it is unconfirmed until first-deploy's edge check passes with it`,
  );
  await readBackToken(api, target.accountId, found.id, rotated.client_id);
  return found.id;
}

type PolicyWant = { name: string; decision: string; include: Record<string, unknown>[] };

function policyDiff(found: Policy, want: PolicyWant): string | null {
  if (found.decision !== want.decision) {
    return "decision";
  }
  if (JSON.stringify(found.include ?? []) !== JSON.stringify(want.include)) {
    return "include";
  }
  if ((found.exclude ?? []).length > 0) {
    return "exclude";
  }
  return (found.require ?? []).length > 0 ? "require" : null;
}

// A reusable policy by name: created when missing, refused when it differs.
async function policy(api: CloudflareApi, accountId: string, state: AccessState, want: PolicyWant): Promise<string> {
  const path = `/accounts/${accountId}/access/policies`;
  const call = { what: `the Access policy "${want.name}"`, permission: PERMISSION.apps };
  const found = state.policies.find((each) => each.name === want.name);
  if (found !== undefined) {
    const field = policyDiff(found, want);
    if (field !== null) {
      throw new Refusal(`the Access policy "${want.name}" differs from prq's in its ${field}: change it, or remove it`);
    }
    print(`cloudflare: the Access policy "${want.name}": pass`);
    return found.id;
  }
  const created = await api.send("POST", path, { ...call, body: want }, Policy);
  const read = await api.get(`${path}/${created.id}`, call, Policy);
  const field = read === null ? "existence" : policyDiff(read, want);
  if (field !== null) {
    throw new Refusal(`the Access policy "${want.name}" does not read back as created (its ${field})`);
  }
  print(`cloudflare: created the Access policy "${want.name}"`);
  return created.id;
}

type AppWant = {
  name: string;
  type: "self_hosted";
  domain: string;
  destinations: { type: "public"; uri: string }[];
  policies: { id: string; precedence: number }[];
  session_duration?: string;
  allowed_idps?: string[];
};

// A destination as Access compares it: without its scheme or a trailing slash, its hostname lowercased and its path's
// case kept (RFC 3986 §6.2.2.1).
function normalize(uri: string): string {
  const bare = uri.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const slash = bare.indexOf("/");
  return slash === -1 ? bare.toLowerCase() : `${bare.slice(0, slash).toLowerCase()}${bare.slice(slash)}`;
}

function appDiff(found: Application, want: AppWant): string | null {
  if (found.type !== want.type) {
    return "type";
  }
  if (normalize(found.domain ?? "") !== normalize(want.domain)) {
    return "domain";
  }
  const uris = (found.destinations ?? []).map((each) => `${each.type ?? "public"} ${normalize(each.uri ?? "")}`);
  if (
    JSON.stringify(uris.toSorted()) !== JSON.stringify(want.destinations.map((each) => `public ${normalize(each.uri)}`))
  ) {
    return "destinations";
  }
  const ids = (found.policies ?? [])
    .toSorted((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0))
    .map((each) => each.id);
  if (JSON.stringify(ids) !== JSON.stringify(want.policies.map((each) => each.id))) {
    return "policies";
  }
  if (want.session_duration !== undefined && found.session_duration !== want.session_duration) {
    return "session_duration";
  }
  if (
    want.allowed_idps !== undefined &&
    JSON.stringify((found.allowed_idps ?? []).toSorted()) !== JSON.stringify(want.allowed_idps.toSorted())
  ) {
    return "allowed_idps";
  }
  return null;
}

// An application by name: created when missing, refused when it differs; read back either way.
async function application(
  api: CloudflareApi,
  accountId: string,
  state: AccessState,
  want: AppWant,
): Promise<Application> {
  const path = `/accounts/${accountId}/access/apps`;
  const call = { what: `the Access application "${want.name}"`, permission: PERMISSION.apps };
  const found = state.apps.find((each) => each.name === want.name);
  if (found !== undefined) {
    const field = appDiff(found, want);
    if (field !== null) {
      throw new Refusal(
        `the Access application "${want.name}" differs from prq's in its ${field}: change it, or remove it`,
      );
    }
    print(`cloudflare: the Access application "${want.name}": pass`);
    return found;
  }
  const created = await api.send("POST", path, { ...call, body: want }, Application);
  const read = await api.get(`${path}/${created.id}`, call, Application);
  const field = read === null ? "existence" : appDiff(read, want);
  if (read === null || field !== null) {
    throw new Refusal(
      `the Access application "${want.name}" does not read back as created (its ${field ?? "existence"})`,
    );
  }
  print(`cloudflare: created the Access application "${want.name}"`);
  return read;
}

const EMAIL = /^[^\s@"]+@[^\s@"]+\.[^\s@"]+$/;
const OwnerRecord = v.object({ id: v.string(), emails: v.array(v.string()) });

// The email the policy "prq owner" lets in. An existing policy is taken only once the owner has seen whom it lets in and
// said yes (an account-wide policy can predate this host); the choice is recorded for later runs. Without one, asked.
async function ownerEmail(found: Policy | undefined, host: string): Promise<string> {
  if (found === undefined) {
    const typed = ((await ask("The email address you sign in to prq with: ")) ?? "").trim();
    if (!EMAIL.test(typed)) {
      throw new Refusal("that is not an email address");
    }
    return typed;
  }
  const emails = (found.include ?? []).flatMap((rule) => {
    const each = rule["email"];
    return v.is(v.object({ email: v.string() }), each) ? [each.email] : [];
  });
  const recorded = v.safeParse(OwnerRecord, (await readState())["ownerPolicy"]);
  const taken =
    recorded.success &&
    recorded.output.id === found.id &&
    JSON.stringify(recorded.output.emails) === JSON.stringify(emails);
  if (!taken) {
    print(
      `cloudflare: the account already has the Access policy "${POLICY.owner}", which lets in ${emails.length > 0 ? emails.join(", ") : "no single email address"}`,
    );
    if (!(await answer(`Let it decide who signs in to ${host}? [y/N] `))) {
      throw new Refusal(
        `kept the Access policy "${POLICY.owner}" out of ${host}: rename or remove it, then run setup cloudflare again`,
      );
    }
  }
  // One email address, or the policy's comparison refuses it.
  return emails[0] ?? "";
}

// Step 8: the policies and the applications; ACCESS_AUD from prq's.
async function applications(
  api: CloudflareApi,
  target: Target,
  state: AccessState,
  otp: string,
  tokenId: string,
): Promise<string> {
  const { accountId, host } = target;
  const email = await ownerEmail(
    state.policies.find((each) => each.name === POLICY.owner),
    host,
  );
  const owner = await policy(api, accountId, state, {
    name: POLICY.owner,
    decision: "allow",
    include: [{ email: { email } }],
  });
  await recordState("ownerPolicy", { id: owner, emails: [email] });
  const cli = await policy(api, accountId, state, {
    name: POLICY.cli,
    decision: "non_identity",
    include: [{ service_token: { token_id: tokenId } }],
  });
  const webhook = await policy(api, accountId, state, {
    name: POLICY.webhook,
    decision: "bypass",
    include: [{ everyone: {} }],
  });
  const main = await application(api, accountId, state, {
    name: APP.main,
    type: "self_hosted",
    domain: host,
    destinations: [{ type: "public", uri: host }],
    session_duration: SESSION,
    policies: [
      { id: owner, precedence: 1 },
      { id: cli, precedence: 2 },
    ],
    allowed_idps: [otp],
  });
  await application(api, accountId, state, {
    name: APP.webhook,
    type: "self_hosted",
    domain: `${host}/webhook`,
    destinations: [{ type: "public", uri: `${host}/webhook` }],
    policies: [{ id: webhook, precedence: 1 }],
  });
  if (main.aud === undefined || main.aud === "") {
    throw new Refusal(`the Access application "${APP.main}" reads back without its audience tag`);
  }
  return main.aud;
}

// Whether the step's results are recorded: target.env, worker.env's Access lines and access.env.
async function allRecorded(): Promise<boolean> {
  const target = (await readEnvFile(TARGET_ENV)) ?? new Map<string, string>();
  const worker = (await readEnvFile(WORKER_ENV)) ?? new Map<string, string>();
  const stored = (await readEnvFile(ACCESS_ENV)) ?? new Map<string, string>();
  return (
    ["CLOUDFLARE_ACCOUNT_ID", "PRQ_HOST"].every((name) => target.has(name)) &&
    ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"].every((name) => worker.has(name)) &&
    ["PRQ_URL", "PRQ_ACCESS_CLIENT_ID", "PRQ_ACCESS_CLIENT_SECRET"].every((name) => (stored.get(name) ?? "") !== "")
  );
}

// The step. In setup's run of every step, a step whose results are recorded is done without a token; named, it checks
// them against the account.
export async function cloudflareStep({ named }: { named: boolean }): Promise<void> {
  if (!named && (await allRecorded())) {
    print(
      `cloudflare: done (recorded in ${TARGET_ENV}, ${WORKER_ENV} and ${ACCESS_ENV}; setup cloudflare checks them against the account, with a new token)`,
    );
    return;
  }
  const target = await chooseTarget();
  const { api, zoneId } = await token(target);
  await workersPlan(api, target.accountId);
  await zoneChecks(api, target, zoneId);
  const org = await organization(api, target.accountId);
  const teamChanged = await writePrivate(WORKER_ENV, { ACCESS_TEAM_DOMAIN: `https://${org.auth_domain}` });
  const state = await readAccess(api, target);
  await strictMode(api, target.accountId, org);
  const otp = await oneTimePin(api, target.accountId, state);
  const tokenId = await serviceToken(api, target, state);
  const aud = await applications(api, target, state, otp, tokenId);
  const audChanged = await writePrivate(WORKER_ENV, { ACCESS_AUD: aud });
  const changed = [...teamChanged, ...audChanged];
  if (changed.length > 0) {
    print(`cloudflare: wrote ${changed.join(", ")} to ${WORKER_ENV}`);
  }
  print(`cloudflare: delete the API token now (${API_TOKENS_PAGE}); a later run asks for a new one`);
  print("cloudflare: done");
}
