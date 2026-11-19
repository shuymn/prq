// The deploy (`pnpm run deploy` in packages/server): --bootstrap [--resume], a release <tag>, and --read-back <record>.
// What each does, its record, read-back and exit codes are docs/operations.md's (The deploy command, First deploy and
// Recovery); what a release is, docs/design.md's (Versions).
//
// Implementation: wrangler runs as operations.ts runs it, a release's upload in the foreground on the terminal, where
// wrangler asks. The record is saved whole (written beside it, then renamed) as each part is known, the upload's result
// before anything after it is read. What wrangler has no read-only command for (the Worker's workers.dev and preview
// URLs, every container application) is read from Cloudflare's API with wrangler's own credentials, which stay in this
// process.

import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { LedgerPage } from "@prq/protocol";
import { isCI, name as ciName } from "ci-info";
import * as v from "valibot";
import { unstable_readConfig } from "wrangler";

import { fixture } from "./fixture.ts";
import {
  account,
  accountName,
  API,
  answer,
  answerOf,
  ask,
  checkConfigAccount,
  exited,
  failed,
  hide,
  NO_ENV_FILE,
  onInterrupt,
  print,
  printError,
  readPrivate,
  refuseOverrides,
  Refusal,
  run,
  runCommand,
  succeeded,
  TARGET_ENV,
  TOP_LEVEL,
  waitMs,
  WORKER,
  WORKER_ENV,
  wrangler,
  wranglerArgv,
  wranglerEnv,
  wranglerJson,
} from "./operations.ts";
import { TAG } from "./release-check.ts";

const BOOTSTRAP_TAG = "prq-bootstrap";
// The Workspace's container application, as wrangler names it from wrangler.jsonc (<Worker>-<class>, lowercased).
const APPLICATION = "prq-workspace";
const RELEASE_CHECK = fileURLToPath(new URL("release-check.ts", import.meta.url));
const USAGE =
  "usage: deploy --bootstrap [--resume] | <tag> [--ignore-running] [--immediate] [--keep-image] | --read-back <record>";
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// The bootstrap's Worker serves nothing, so any recent date will do.
const COMPATIBILITY_DATE = "2026-11-10";
const DASHBOARD = "Workers & Pages → prq → Settings → Domains & Routes";
const RESUME = "pnpm --dir packages/server run deploy -- --read-back";
// The CLI package of the checkout this script runs from, where the bootstrap's check runs.
const CLI_DIR = fileURLToPath(new URL("../../cli", import.meta.url));
// A changed application's instances, read a page at a time (wrangler's own page size) up to this many pages.
const INSTANCES_PER_PAGE = "25";
const INSTANCE_PAGES = 200;
// How long the owner has to look at a new container application in the dashboard.
const PROVISIONING_MS = 30 * 60_000;
// The web UI build's inputs for the browser check alone (vite.config.ts), which a release's build never takes.
const BUILD_OVERRIDES = ["PRQ_BUILD_VERSION", "PRQ_BUILD_PREFIX"];
// The most ledger pages the idle check reads.
const LEDGER_PAGES = 1_000;
const LEDGER_REQUEST_MS = 30_000;

// The variables ci-info, which wrangler bundles, takes as CI besides each CI service's own (ci-info's vendors.json),
// unless CI is "false".
const CI_VARIABLES = [
  "CI",
  "BUILD_ID",
  "BUILD_NUMBER",
  "CI_APP_ID",
  "CI_BUILD_ID",
  "CI_BUILD_NUMBER",
  "CI_NAME",
  "CONTINUOUS_INTEGRATION",
  "RUN_ID",
];
// A CI service's variables in vendors.json: a name, a list of them, { env: name, includes }, { any: [names] }, or
// { name: value }.
const VendorEnv = v.union([v.string(), v.record(v.string(), v.unknown())]);
const Vendors = v.array(v.object({ name: v.string(), env: v.union([VendorEnv, v.array(VendorEnv)]) }));

function vendorVariables(env: v.InferOutput<typeof VendorEnv>): string[] {
  if (typeof env === "string") {
    return [env];
  }
  if (typeof env["env"] === "string") {
    return [env["env"]];
  }
  return v.is(v.array(v.string()), env["any"]) ? env["any"] : Object.keys(env);
}

function isSet(name: string): boolean {
  return (process.env[name] ?? "") !== "";
}

// Only the tests' fixture sets shorter bounds for the clone's steps and the upload, a shorter poll interval, the
// Worker's origin for the idle check, or the API the deploy's own reads go to (a stand-in).
const stepMs = fixture.stepMs ?? 60 * 60_000;
const uploadMs = fixture.stepMs ?? 2 * 60 * 60_000;
const pollMs = fixture.pollMs ?? 10_000;
// The rollout is read every poll interval until it is complete or this long has passed since the poll began.
const rolloutMs = fixture.rolloutMs ?? 30 * 60_000;
const originOverride = fixture.origin;
const api = fixture.api ?? API;

// What wrangler answers: `deployments status --json`, `versions view --json`, `auth token --json` (wrangler's
// credentials: an OAuth or API token, or a global API key with its email), `containers info --json` and a page of `containers instances --json --per-page` (a Durable Object with no instance
// is a row of its own, its state "inactive").
const DeploymentAnswer = v.object({
  id: v.nullish(v.string()),
  versions: v.array(v.object({ version_id: v.string(), percentage: v.number() })),
});
const VersionAnswer = v.object({
  annotations: v.nullish(v.record(v.string(), v.string())),
  resources: v.nullish(v.object({ bindings: v.nullish(v.array(v.object({ type: v.string() }))) })),
});
const AuthAnswer = v.variant("type", [
  v.object({ type: v.picklist(["oauth", "api_token"]), token: v.string() }),
  v.object({ type: v.literal("api_key"), key: v.string(), email: v.string() }),
]);
const ApplicationAnswer = v.object({
  id: v.string(),
  version: v.nullish(v.number()),
  configuration: v.nullish(v.object({ image: v.nullish(v.string()) })),
  active_rollout_id: v.nullish(v.string()),
});
const Instance = v.object({ state: v.string(), version: v.nullish(v.number()) });
type Instance = v.InferOutput<typeof Instance>;
const InstancesPage = v.object({
  instances: v.array(Instance),
  result_info: v.object({ next_page_token: v.nullish(v.string()) }),
});
// An entry of wrangler's output file (WRANGLER_OUTPUT_FILE_PATH): the deploy's, with the version it created.
const DeployEntry = v.object({ type: v.literal("deploy"), version_id: v.string() });
// What Cloudflare's API answers the deploy's own reads, the two wrangler's deploy makes: the Worker's settings, its
// workers.dev and preview URLs among them, and every container application.
const WorkerAnswer = v.object({
  subdomain: v.object({ enabled: v.nullish(v.boolean()), previews_enabled: v.nullish(v.boolean()) }),
});
const ApplicationsAnswer = v.array(v.object({ id: v.string(), name: v.string() }));

const Deployment = v.object({
  id: v.nullable(v.string()),
  // inert: a version whose bindings are listed, none but secrets, as the bootstrap's Worker and the versions secrets put
  // makes of it.
  versions: v.array(
    v.object({ versionId: v.string(), percentage: v.number(), tag: v.nullable(v.string()), inert: v.boolean() }),
  ),
});
type Deployment = v.InferOutput<typeof Deployment>;
const Application = v.object({
  id: v.string(),
  version: v.nullable(v.number()),
  image: v.nullable(v.string()),
  activeRollout: v.nullable(v.string()),
});
type Application = v.InferOutput<typeof Application>;
// Whether the Worker's workers.dev address and preview URLs are on.
const Endpoints = v.object({ workersDev: v.boolean(), previews: v.boolean() });
type Endpoints = v.InferOutput<typeof Endpoints>;
// What a read found: a value, or null when there is none, with what could not be read.
const State = v.object({
  deployment: v.nullable(Deployment),
  endpoints: v.nullable(Endpoints),
  application: v.nullable(Application),
  unread: v.array(v.string()),
});
type State = v.InferOutput<typeof State>;
const Rollout = v.object({ id: v.string(), image: v.nullable(v.string()), version: v.nullable(v.number()) });
type Rollout = v.InferOutput<typeof Rollout>;

const DeployRecord = v.object({
  kind: v.literal("prq-deploy"),
  tag: v.string(),
  sha: v.string(),
  accountId: v.string(),
  worker: v.string(),
  host: v.string(),
  clone: v.string(),
  startedAt: v.string(),
  flags: v.object({ ignoreRunning: v.boolean(), immediate: v.boolean(), keepImage: v.boolean() }),
  before: State,
  outcome: v.string(),
  idle: v.nullable(v.string()),
  upload: v.nullable(
    v.object({
      exit: v.nullable(v.number()),
      signal: v.nullable(v.string()),
      timedOut: v.boolean(),
      versionId: v.nullable(v.string()),
    }),
  ),
  // Read right after the upload, and again by the latest --read-back.
  after: v.nullable(State),
  reread: v.nullable(State),
  // The container application: created by this deploy, changed (a rollout), unchanged, kept (--keep-image), or absent.
  application: v.nullable(v.picklist(["created", "changed", "unchanged", "kept", "absent"])),
  // The rollout the read-back follows, once a read found it, with the application's image and version it found.
  rollout: v.nullable(Rollout),
  readBack: v.nullable(
    v.object({
      state: v.picklist(["complete", "incomplete"]),
      reason: v.string(),
      at: v.string(),
      provisioning: v.nullable(v.picklist(["observed", "unverified"])),
      rounds: v.array(v.object({ at: v.string(), application: v.nullable(Application), instances: v.string() })),
    }),
  ),
});
type DeployRecord = v.InferOutput<typeof DeployRecord>;

// A record file, replaced whole on each save: written next to it, then renamed over it. Saves run one after another,
// so an earlier one never lands over a later one (a signal's save can start while another is under way).
class Saved {
  readonly dir: string;
  readonly file: string;
  readonly data: DeployRecord;
  #saving: Promise<void> = Promise.resolve();

  constructor(dir: string, file: string, data: DeployRecord) {
    this.dir = dir;
    this.file = file;
    this.data = data;
  }

  save(): Promise<void> {
    const text = `${JSON.stringify(this.data, null, 2)}\n`;
    const next = join(this.dir, `.${randomBytes(6).toString("hex")}.json`);
    this.#saving = this.#saving
      .catch(() => {})
      .then(async () => {
        await writeFile(next, text, { flag: "wx", mode: 0o600 });
        await rename(next, this.file);
      });
    return this.#saving;
  }
}

// The time as a name, to the millisecond: 2026-11-19T04-05-06.789Z.
function stamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

function now(): string {
  return new Date().toISOString();
}

// A directory this process made in the OS temp directory, removed when it is still one (not a link to elsewhere).
async function removeOwn(dir: string): Promise<void> {
  const info = await lstat(dir).catch(() => null);
  if (info?.isDirectory() === true) {
    await rm(dir, { recursive: true, force: true });
  }
}

// The directory the records go into, the owner's alone.
async function records(...names: string[]): Promise<string> {
  const xdg = process.env["XDG_STATE_HOME"];
  const dir = join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state"), "prq", "deploys");
  const made = join(dir, ...names);
  await mkdir(made, { recursive: true, mode: 0o700 });
  for (const each of [dir, made]) {
    const info = await lstat(each);
    if (!info.isDirectory()) {
      throw new Refusal(`${each} is not a directory`);
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Refusal(`${each} is open to others than its owner: chmod 700 it`);
    }
  }
  return made;
}

// target.env's account, which the repository's wrangler configuration must not override, and hostname.
async function target(): Promise<{ accountId: string; host: string }> {
  const accountId = await account();
  await checkConfigAccount(accountId);
  const host = (parseEnv(await readPrivate(TARGET_ENV))["PRQ_HOST"] ?? "").toLowerCase();
  if (!HOST.test(host)) {
    throw new Refusal(`${TARGET_ENV} does not set PRQ_HOST to a hostname (such as prq.example.com)`);
  }
  return { accountId, host };
}

// The version a deploy created, from wrangler's output file: none when it stopped before its end.
async function deployedVersion(file: string): Promise<string | null> {
  const text = await readFile(file, "utf8").catch(() => "");
  let found: string | null = null;
  for (const line of text.split("\n")) {
    try {
      const parsed = v.safeParse(DeployEntry, JSON.parse(line));
      if (parsed.success) {
        found = parsed.output.version_id;
      }
    } catch {
      // Not an entry.
    }
  }
  return found;
}

// A version's tag, and whether its bindings are listed, none but secrets (one whose bindings are not listed is not).
async function version(accountId: string, versionId: string): Promise<{ tag: string | null; inert: boolean }> {
  const viewed = await wranglerJson(
    "versions view",
    ["versions", "view", versionId, "--json", "--name", WORKER, ...TOP_LEVEL],
    accountId,
    VersionAnswer,
  );
  const bindings = viewed.resources?.bindings ?? null;
  return {
    tag: viewed.annotations?.["workers/tag"] ?? null,
    inert: bindings !== null && bindings.every((binding) => binding.type === "secret_text"),
  };
}

// The Worker's live versions with their tags; null when there is no Worker prq or it has no deployment.
async function liveDeployment(accountId: string): Promise<Deployment | null> {
  const outcome = await wrangler(["deployments", "status", "--json", "--name", WORKER, ...TOP_LEVEL], accountId);
  if (!succeeded(outcome)) {
    // The API's "no such Worker", or wrangler's "has no deployments".
    if (/\[code: 10007\]|has no deployments/.test(`${outcome.stdout}${outcome.stderr}`)) {
      return null;
    }
    throw failed("deployments status", outcome);
  }
  const answered = answerOf("deployments status", DeploymentAnswer, outcome.stdout);
  const versions: Deployment["versions"] = [];
  for (const each of answered.versions) {
    versions.push({
      versionId: each.version_id,
      percentage: each.percentage,
      ...(await version(accountId, each.version_id)),
    });
  }
  return { id: answered.id ?? null, versions };
}

// The headers of a read with wrangler's login: its credentials, from `wrangler auth token --json`, held in this
// process alone (in no argument, other process's environment, file or line printed), read once before the upload and
// once after it.
let credentials: Promise<Record<string, string>> | null = null;

function authHeaders(accountId: string): Promise<Record<string, string>> {
  credentials ??= (async () => {
    // No log file: its output is the credentials.
    const outcome = await wrangler(["auth", "token", "--json", ...TOP_LEVEL], accountId, {
      env: { WRANGLER_WRITE_LOGS: "false" },
    });
    if (!succeeded(outcome)) {
      // Its output is not shown: it can hold the credentials.
      throw new Refusal(
        `wrangler auth token ${outcome.timedOut ? "did not finish" : `failed (${exited(outcome)})`}: log wrangler in (docs/operations.md, Cloudflare account)`,
      );
    }
    let json: unknown = null;
    try {
      json = JSON.parse(outcome.stdout);
    } catch {
      // Refused below.
    }
    const parsed = v.safeParse(AuthAnswer, json);
    if (!parsed.success) {
      throw new Refusal("wrangler auth token did not answer in the shape this command reads");
    }
    const auth = parsed.output;
    if (auth.type === "api_key") {
      hide([auth.key, auth.email]);
      return { "X-Auth-Key": auth.key, "X-Auth-Email": auth.email };
    }
    hide([auth.token]);
    return { Authorization: `Bearer ${auth.token}` };
  })();
  return credentials;
}

// A GET of Cloudflare's API on the account with wrangler's login, its result as schema reads it; null when the API
// answers 404.
async function apiRead<S extends v.GenericSchema>(
  what: string,
  accountId: string,
  path: string,
  schema: S,
): Promise<v.InferOutput<S> | null> {
  const headers = await authHeaders(accountId);
  let response: Response;
  try {
    response = await fetch(`${api}/accounts/${accountId}${path}`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(waitMs),
    });
  } catch (error) {
    throw new Refusal(
      `Cloudflare's API could not be read for ${what} (${error instanceof Error ? error.name : "error"})`,
    );
  }
  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new Refusal(`Cloudflare's API answered HTTP ${response.status} for ${what}`);
  }
  const parsed = v.safeParse(
    v.object({ success: v.literal(true), result: schema }),
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    throw new Refusal(`Cloudflare's API answered ${what} in another shape`);
  }
  return parsed.output.result;
}

// The Worker's workers.dev address and preview URLs, as wrangler's deploy reads them (each off unless set); null when
// there is no Worker prq.
async function endpoints(accountId: string): Promise<Endpoints | null> {
  const worker = await apiRead("the Worker's settings", accountId, `/workers/workers/${WORKER}`, WorkerAnswer);
  return worker === null
    ? null
    : { workersDev: worker.subdomain.enabled ?? false, previews: worker.subdomain.previews_enabled ?? false };
}

// The application's ID, from every container application, as wrangler's deploy finds it (`containers list --json`
// prints the first page alone).
async function applicationId(accountId: string): Promise<string | null> {
  const listed = await apiRead("the container applications", accountId, "/containers/applications", ApplicationsAnswer);
  if (listed === null) {
    throw new Refusal("Cloudflare's API answered HTTP 404 for the container applications");
  }
  return listed.find((app) => app.name === APPLICATION)?.id ?? null;
}

async function applicationInfo(accountId: string, id: string): Promise<Application> {
  const app = await wranglerJson(
    "containers info",
    ["containers", "info", id, "--json", ...TOP_LEVEL],
    accountId,
    ApplicationAnswer,
  );
  return {
    id: app.id,
    version: app.version ?? null,
    image: app.configuration?.image ?? null,
    activeRollout: app.active_rollout_id ?? null,
  };
}

// Every page of the application's instances, each read only while late() is false. (Without --per-page, wrangler
// prints the first page alone.)
async function instances(accountId: string, id: string, late: () => boolean): Promise<Instance[]> {
  const rows: Instance[] = [];
  let token: string | null = null;
  for (let page = 0; page < INSTANCE_PAGES; page++) {
    if (late()) {
      throw new Refusal("its time passed while the instances were read");
    }
    const answered: v.InferOutput<typeof InstancesPage> = await wranglerJson(
      "containers instances",
      [
        "containers",
        "instances",
        id,
        "--json",
        "--per-page",
        INSTANCES_PER_PAGE,
        ...(token === null ? [] : ["--page-token", token]),
        ...TOP_LEVEL,
      ],
      accountId,
      InstancesPage,
    );
    rows.push(...answered.instances);
    token = answered.result_info.next_page_token ?? null;
    if (token === null || token === "") {
      return rows;
    }
  }
  throw new Refusal(`wrangler containers instances listed more than ${INSTANCE_PAGES} pages`);
}

// The live versions and the container application (the one known by its ID, else by its name), each null when there
// is none; what could not be read is named instead of stopping the read.
async function readState(accountId: string, knownId: string | null = null): Promise<State> {
  const unread: string[] = [];
  const attempt = async <T>(what: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof Refusal)) {
        throw error;
      }
      unread.push(`${what}: ${error.lines.join("; ")}`);
      return null;
    }
  };
  const deployment = await attempt("the live versions", () => liveDeployment(accountId));
  const ingress = await attempt("the Worker's workers.dev and preview URLs", () => endpoints(accountId));
  const id = knownId ?? (await attempt("the container applications", () => applicationId(accountId)));
  const application =
    id === null ? null : await attempt("the container application", () => applicationInfo(accountId, id));
  return { deployment, endpoints: ingress, application, unread };
}

function versionsLine(versions: Deployment["versions"] = []): string {
  if (versions.length === 0) {
    return "none";
  }
  return versions.map((each) => `${each.versionId} (${each.tag ?? "untagged"}, ${each.percentage} %)`).join(", ");
}

function endpointsLine(ingress: Endpoints | null): string {
  if (ingress === null) {
    return "workers.dev and preview URLs unknown";
  }
  return `workers.dev ${ingress.workersDev ? "on" : "off"}, preview URLs ${ingress.previews ? "on" : "off"}`;
}

function applicationLine(app: Application | null): string {
  if (app === null) {
    return "none";
  }
  return `${app.id}, version ${app.version ?? "unknown"}, image ${app.image ?? "unknown"}, rollout ${app.activeRollout ?? "none active"}`;
}

// The service token prq uses, from the environment, for the idle check.
function serviceToken(): { id: string; secret: string } | null {
  const id = process.env["PRQ_ACCESS_CLIENT_ID"] ?? "";
  const secret = process.env["PRQ_ACCESS_CLIENT_SECRET"] ?? "";
  hide([secret].filter((value) => value !== ""));
  return id === "" || secret === "" ? null : { id, secret };
}

// The pull requests whose cloud work is waiting or running, from every page of the ledger.
async function busyRows(origin: string, token: { id: string; secret: string }): Promise<string[]> {
  const busy: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < LEDGER_PAGES; page++) {
    const url = new URL("/api/ledger", origin);
    url.searchParams.set("state", "all");
    if (cursor !== null) {
      url.searchParams.set("cursor", cursor);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "CF-Access-Client-Id": token.id, "CF-Access-Client-Secret": token.secret },
        redirect: "manual",
        signal: AbortSignal.timeout(LEDGER_REQUEST_MS),
      });
    } catch (error) {
      throw new Refusal(`the idle check could not read the ledger (${error instanceof Error ? error.name : "error"})`);
    }
    if (response.status !== 200) {
      throw new Refusal(`the idle check got HTTP ${response.status} for the ledger`);
    }
    const parsed = v.safeParse(LedgerPage, await response.json().catch(() => null));
    if (!parsed.success) {
      throw new Refusal("the idle check got a ledger page in another shape");
    }
    for (const row of parsed.output.rows) {
      if (row.owner === "cloud" && (row.jobs.waiting > 0 || row.jobs.running > 0)) {
        busy.push(
          `${row.pr.owner}/${row.pr.repo}#${row.pr.number} (waiting ${row.jobs.waiting}, running ${row.jobs.running})`,
        );
      }
    }
    cursor = parsed.output.nextCursor;
    if (cursor === null) {
      return busy;
    }
  }
  throw new Refusal(`the idle check read ${LEDGER_PAGES} pages of the ledger without reaching its end`);
}

// Whether any cloud work waits or runs, refused when some does or the check cannot tell; with ignoreRunning, a warning.
async function idleCheck(host: string, ignoreRunning: boolean): Promise<string> {
  try {
    const token = serviceToken();
    if (token === null) {
      throw new Refusal(
        "the idle check reads the ledger with the service token: set PRQ_ACCESS_CLIENT_ID and PRQ_ACCESS_CLIENT_SECRET as for prq",
      );
    }
    const busy = await busyRows(originOverride ?? `https://${host}`, token);
    if (busy.length > 0) {
      throw new Refusal(
        `cloud work is waiting or running: ${busy.join(", ")}`,
        "deploy once it has finished, in an interval without new pushes or questions (or pass --ignore-running)",
      );
    }
    print("idle check: no cloud work waiting or running");
    return "idle";
  } catch (error) {
    if (!(error instanceof Refusal) || !ignoreRunning) {
      throw error;
    }
    for (const line of error.lines) {
      printError(`deploy: warning (--ignore-running): ${line}`);
    }
    return `ignored: ${error.lines.join("; ")}`;
  }
}

// The environment of the clone's steps: this process's, less the build's overrides, with path (the pinned tools first)
// as its PATH when given.
function stepEnv(path?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of BUILD_OVERRIDES) {
    delete env[name];
  }
  if (path !== undefined) {
    env["PATH"] = path;
  }
  return env;
}

// A step in the clone, its output shown, refused when it fails.
async function step(name: string, command: string, args: readonly string[], cwd: string, path?: string): Promise<void> {
  print(`deploy: ${name}`);
  const outcome = await run(name, command, args, { cwd, env: stepEnv(path), output: "show", timeoutMs: stepMs });
  if (outcome.timedOut) {
    throw new Refusal(`${name} did not finish within ${Math.round(stepMs / 1000)} s and was stopped`);
  }
  if (outcome.code !== 0) {
    throw new Refusal(`${name} failed (exit ${outcome.code ?? outcome.signal ?? "unknown"})`);
  }
}

// A git command's output in a directory.
async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const outcome = await run("git", "git", args, { cwd, env: process.env, output: "keep", timeoutMs: waitMs });
  if (!succeeded(outcome)) {
    throw new Refusal(`git ${args[0] ?? ""} failed (exit ${outcome.code ?? "by a signal"})`);
  }
  return outcome.stdout.trim();
}

// The clone as the release check checked it: HEAD still sha, and its tracked files as sha has them (none changed,
// added to the index or removed).
async function treeCheck(clone: string, sha: string, when: string): Promise<void> {
  const head = await gitOutput(clone, ["rev-parse", "--verify", "HEAD"]);
  const diff = await run("git diff", "git", ["diff", "--quiet", "--no-ext-diff", "--no-textconv", sha, "--"], {
    cwd: clone,
    env: process.env,
    output: "keep",
    timeoutMs: stepMs,
  });
  if (head !== sha || diff.code === 1) {
    throw new Refusal(`the clone's tracked files are no longer ${sha}'s ${when}: something in the clone changed them`);
  }
  if (!succeeded(diff)) {
    throw new Refusal(`git diff failed (exit ${diff.code ?? "by a signal"})`);
  }
}

// None of the deployment's values in the clone's tracked files: each searched as a fixed string, ignoring case, read
// from a file of its own (not an argument, which others can list); a finding names the variable and the path.
async function publicationCheck(clone: string, values: Readonly<Record<string, string>>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prq-deploy-search-"));
  onInterrupt(() => removeOwn(dir));
  try {
    const found: string[] = [];
    for (const [name, value] of Object.entries(values)) {
      const file = join(dir, name);
      await writeFile(file, `${value}\n`, { flag: "wx", mode: 0o600 });
      const outcome = await run("git grep", "git", ["grep", "-l", "-z", "-i", "-F", "-f", file], {
        cwd: clone,
        env: process.env,
        output: "keep",
        timeoutMs: stepMs,
      });
      if (outcome.code === 0) {
        found.push(
          ...outcome.stdout
            .split("\0")
            .filter((path) => path !== "")
            .map((path) => `${name} is in ${path}`),
        );
      } else if (outcome.code !== 1) {
        throw new Refusal(`git grep failed (exit ${outcome.code ?? "by a signal"})`);
      }
    }
    if (found.length > 0) {
      throw new Refusal(...found, "the tag holds a deployment value, which stays out of the repository");
    }
    print(`publication check: none of ${Object.keys(values).join(", ")} is in the tag's files`);
  } finally {
    onInterrupt(null);
    await removeOwn(dir);
  }
}

// The tag's Worker configuration as wrangler reads it for the upload (its top level, its warnings not printed): the
// Worker prq, with workers.dev and preview URLs off, which wrangler sets on every deploy; no route, which wrangler would
// publish beside the hostname the owner confirmed; and no account_id, which wrangler would deploy to in place of
// target.env's.
function configCheck(clone: string): void {
  const config = unstable_readConfig(
    { config: join(clone, "packages", "server", "wrangler.jsonc"), env: "" },
    { hideWarnings: true },
  );
  if (config.name !== WORKER || config.workers_dev !== false || config.preview_urls !== false) {
    throw new Refusal(
      `the tag's packages/server/wrangler.jsonc does not name the Worker ${WORKER} with workers_dev and preview_urls false`,
    );
  }
  if (config.route !== undefined || (config.routes?.length ?? 0) > 0) {
    throw new Refusal(
      `the tag's packages/server/wrangler.jsonc configures a route, which wrangler would publish beside the hostname: the deploy takes the hostname from ${TARGET_ENV} alone`,
    );
  }
  if (config.account_id !== undefined) {
    throw new Refusal(
      `the tag's packages/server/wrangler.jsonc sets an account_id, which wrangler would deploy to in place of ${TARGET_ENV}'s`,
    );
  }
  print(`configuration: the Worker ${WORKER}, with workers.dev and preview URLs off and no route`);
}

// The clone's pinned Node and pnpm as mise resolves them there, and a PATH with their directories first. The install,
// the build and the upload run them directly, not through mise, so mise's configuration (an [env], a MISE_ENV
// variant's file, a parent directory's) changes none of their environments.
type Tools = { node: string; pnpm: string; path: string };

async function pinnedTools(clone: string): Promise<Tools> {
  const which = async (tool: string): Promise<string> => {
    const name = `mise which ${tool}`;
    const outcome = await run(name, "mise", ["which", tool], {
      cwd: clone,
      env: stepEnv(),
      output: "keep",
      timeoutMs: stepMs,
    });
    if (!succeeded(outcome)) {
      throw new Refusal(
        outcome.timedOut
          ? `${name} did not finish within ${Math.round(stepMs / 1000)} s and was stopped`
          : `${name} failed (${exited(outcome)})`,
      );
    }
    const path = outcome.stdout.trim();
    if (!isAbsolute(path) || (await stat(path).catch(() => null))?.isFile() !== true) {
      throw new Refusal(`${name} named no file by its absolute path: the clone's ${tool} is not installed`);
    }
    return path;
  };
  const node = await which("node");
  const pnpm = await which("pnpm");
  const path = [dirname(node), dirname(pnpm), ...(process.env["PATH"] ?? "").split(delimiter)];
  return { node, pnpm, path: path.filter((each) => each !== "").join(delimiter) };
}

// The clone's own wrangler, as its frozen install put it, run by the clone's Node.
function cloneWrangler(clone: string, node: string): [string, string[]] {
  return wranglerArgv(node, () => {
    try {
      return createRequire(join(clone, "packages", "server", "package.json")).resolve("wrangler");
    } catch {
      // Without it, the run says wrangler could not start.
      return "";
    }
  });
}

// The read-back's verdict, recorded.
async function settle(
  record: Saved,
  state: "complete" | "incomplete",
  reason: string,
  extra: Partial<Pick<NonNullable<DeployRecord["readBack"]>, "provisioning" | "rounds">> = {},
): Promise<number> {
  record.data.readBack = {
    state,
    reason,
    at: now(),
    provisioning: extra.provisioning ?? record.data.readBack?.provisioning ?? null,
    rounds: extra.rounds ?? record.data.readBack?.rounds ?? [],
  };
  await record.save();
  print(`record: ${record.dir}`);
  print(`in the dashboard (${DASHBOARD}): workers.dev and Preview URLs disabled, ${record.data.host} a custom domain`);
  if (state === "complete") {
    print(`read-back complete: ${reason}`);
    // The team domain is not printed: the shell gives it, as the subdomain, which a release does not know.
    const cli = join(record.data.clone, "packages", "cli");
    print(
      "then, with PRQ_URL and the service token set, ACCESS_TEAM_DOMAIN to the Access team domain and WORKERS_SUBDOMAIN to the account's workers.dev subdomain, run:",
    );
    print(checkCommand(cli, 'edge --team-domain "$ACCESS_TEAM_DOMAIN"'));
    print(checkCommand(cli, 'endpoints "$WORKERS_SUBDOMAIN"'));
    return 0;
  }
  printError(`deploy: verification incomplete: ${reason}`);
  printError(`deploy: resume it with ${RESUME} ${record.dir}`);
  return 2;
}

// A deployed check (docs/operations.md, The deployed checks) as a command line of its own, the CLI package's path
// quoted for a POSIX shell.
function checkCommand(cli: string, args: string): string {
  return `  pnpm --dir '${cli.replaceAll("'", "'\\''")}' run check:deployed -- ${args}`;
}

// The instances as the read-back counts them: those of a Durable Object with no instance (inactive) apart, and of the
// rest, those at another version than the application's (an unknown version is not the application's) and those not
// settled.
function instanceCounts(rows: readonly Instance[], appVersion: number | null) {
  const active = rows.filter((each) => each.state !== "inactive");
  return {
    active: active.length,
    behind: active.filter((each) => appVersion === null || each.version !== appVersion).length,
    unsettled: active.filter((each) => ["provisioning", "failed", "unhealthy", "unknown"].includes(each.state)).length,
    inactive: rows.length - active.length,
  };
}

// Polls an application until its rollout is complete, for at most the rollout's time (a read under way then finishes
// first, within wrangler's wait): the image and version the rollout was found with (when known), no active rollout,
// and every active instance at that version, none starting or failed.
async function pollRollout(record: Saved, expected: Rollout): Promise<number> {
  const { accountId } = record.data;
  const { id } = expected;
  const rounds = record.data.readBack?.rounds ?? [];
  const deadline = Date.now() + rolloutMs;
  const late = () => Date.now() >= deadline;
  const notComplete = `the rollout was not complete within ${Math.round(rolloutMs / 1000)} s`;
  onInterrupt(async () => {
    process.exitCode = await settle(record, "incomplete", "the owner stopped the rollout's read-back", { rounds });
    process.exit();
  });
  try {
    for (;;) {
      let app: Application;
      let listed: Instance[];
      try {
        app = await applicationInfo(accountId, id);
        listed = await instances(accountId, id, late);
      } catch (error) {
        if (!(error instanceof Refusal)) {
          throw error;
        }
        const reason = late() ? notComplete : `the rollout could not be read: ${error.lines.join("; ")}`;
        return await settle(record, "incomplete", reason, { rounds });
      }
      const counts = instanceCounts(listed, expected.version ?? app.version);
      const instancesLine = `${counts.active} active (${counts.behind} at another version or none, ${counts.unsettled} not settled), ${counts.inactive} inactive`;
      rounds.push({ at: now(), application: app, instances: instancesLine });
      print(`rollout: ${applicationLine(app)}; instances: ${instancesLine}`);
      if (expected.image !== null && app.image !== expected.image) {
        return await settle(
          record,
          "incomplete",
          `the application's image is ${app.image ?? "unknown"}, not ${expected.image}`,
          { rounds },
        );
      }
      if (expected.version !== null && app.version !== expected.version) {
        return await settle(
          record,
          "incomplete",
          `the application's version is ${app.version ?? "unknown"}, not ${expected.version}`,
          { rounds },
        );
      }
      if (app.activeRollout === null && counts.behind === 0 && counts.unsettled === 0) {
        return await settle(
          record,
          "complete",
          `the application's rollout of version ${app.version ?? "unknown"} is complete`,
          { rounds },
        );
      }
      if (Date.now() + pollMs >= deadline) {
        return await settle(record, "incomplete", notComplete, { rounds });
      }
      await record.save();
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    onInterrupt(null);
  }
}

// A new application: the owner reads its provisioning in the dashboard, or it stays unverified.
async function provisioning(record: Saved): Promise<number> {
  onInterrupt(async () => {
    process.exitCode = await settle(record, "incomplete", "the owner stopped before the provisioning was read", {
      provisioning: "unverified",
    });
    process.exit();
  });
  try {
    print(
      `the container application ${APPLICATION} was created; Cloudflare provisions a new application over several minutes, during which its containers can fail to start`,
    );
    const observed = await answer(
      `Once the dashboard (Workers & Pages → Containers → ${APPLICATION}) shows it ready, answer y; n records it unverified [y/N] `,
      PROVISIONING_MS,
    );
    return observed
      ? await settle(record, "complete", "the new application's provisioning was observed in the dashboard", {
          provisioning: "observed",
        })
      : await settle(record, "incomplete", "the new application's provisioning was not observed", {
          provisioning: "unverified",
        });
  } finally {
    onInterrupt(null);
  }
}

// Pins the rollout every later read-back follows, given the application a read just found (app): called as the first
// thing after each read and once the application is classified, before anything returns or saves, and never replacing
// a pin. A rollout the read finds under way is pinned whatever else that read missed and before any classification:
// the application's as read, or the one it had before the upload when it still has that ID, version and image (an
// earlier deploy's, under way at a retry with the same image). A changed application's is this deploy's own, pinned
// as read right after the upload whether a read shows it or not.
function pin(record: Saved, app: Application | null): void {
  const { data } = record;
  if (data.rollout !== null || app === null) {
    return;
  }
  const before = data.before.application;
  const same = before?.id === app.id && before.version === app.version && before.image === app.image;
  const found =
    data.application === "changed"
      ? (data.after?.application ?? app)
      : [app, same ? before : null].find((each) => (each?.activeRollout ?? null) !== null);
  if (found !== undefined && found !== null) {
    data.rollout = { id: found.id, image: found.image, version: found.version };
  }
}

// The read-back after a successful upload: the deployed version live alone, then the application as it was left.
async function readBack(record: Saved): Promise<number> {
  const { after, upload, application } = record.data;
  const state = record.data.reread ?? after;
  pin(record, state?.application ?? null);
  const versionId = upload?.versionId ?? null;
  const live = state?.deployment?.versions ?? [];
  if (state !== null && state.unread.length > 0) {
    return settle(record, "incomplete", `what is live could not be read: ${state.unread.join("; ")}`);
  }
  if (versionId === null) {
    return settle(record, "incomplete", "wrangler's output file names no deployed version");
  }
  if (live.length !== 1 || live[0]?.versionId !== versionId || live[0].percentage !== 100) {
    return settle(
      record,
      "incomplete",
      `the live versions are ${versionsLine(state?.deployment?.versions)}, not ${versionId} alone`,
    );
  }
  const ingress = state?.endpoints ?? null;
  if (ingress === null || ingress.workersDev || ingress.previews) {
    return settle(record, "incomplete", `the Worker has ${endpointsLine(ingress)} after the deploy`);
  }
  const app = state?.application ?? null;
  switch (application) {
    case "created":
      return provisioning(record);
    case "changed":
    case "unchanged":
    case "kept": {
      if (app === null) {
        return settle(record, "incomplete", "the application could not be read");
      }
      if (record.data.rollout === null) {
        return settle(record, "complete", `version ${versionId} is live, and the application's image is unchanged`);
      }
      await record.save();
      return pollRollout(record, record.data.rollout);
    }
    default:
      return settle(record, "incomplete", `the container application ${APPLICATION} was not found after the upload`);
  }
}

function classify(
  before: Application | null,
  after: Application | null,
  keepImage: boolean,
): DeployRecord["application"] {
  if (after === null) {
    return "absent";
  }
  if (before === null) {
    return "created";
  }
  if (before.version === after.version && before.image === after.image) {
    return keepImage ? "kept" : "unchanged";
  }
  return "changed";
}

type Flags = { ignoreRunning: boolean; immediate: boolean; keepImage: boolean };

async function release(tag: string, flags: Flags): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Refusal(
      "the deploy runs in a terminal: wrangler asks there before it replaces a DNS record or another Worker's domain",
    );
  }
  const { accountId, host } = await target();
  const workerEnv = parseEnv(await readPrivate(WORKER_ENV));
  const teamDomain = workerEnv["ACCESS_TEAM_DOMAIN"] ?? "";
  const aud = workerEnv["ACCESS_AUD"] ?? "";
  hide([teamDomain, aud].filter((value) => value !== ""));
  const teamHost = URL.canParse(teamDomain) ? new URL(teamDomain).hostname : "";
  if (teamHost === "" || aud === "") {
    throw new Refusal(
      `${WORKER_ENV} does not set ACCESS_TEAM_DOMAIN and ACCESS_AUD (secrets check names what is missing)`,
    );
  }
  hide([teamHost]);
  const root = await records();
  const name = await accountName(accountId);

  const url = await gitOutput(process.cwd(), ["config", "--get", "--end-of-options", "remote.origin.url"]);
  const clone = await mkdtemp(join(tmpdir(), `prq-deploy-${tag}-`));
  print(`clone: ${clone} (kept)`);
  // No hook runs in the clone: neither the host's (core.hooksPath) nor a template's.
  await step(
    `git clone of ${tag}`,
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "advice.detachedHead=false",
      "clone",
      "--template=",
      "--branch",
      tag,
      "--",
      url,
      clone,
    ],
    process.cwd(),
  );
  await step("the release check", process.execPath, ["--no-warnings", RELEASE_CHECK, tag], clone);
  // The commit the release check checked.
  const sha = await gitOutput(clone, ["rev-parse", "--verify", "HEAD"]);
  await step("mise trust", "mise", ["trust"], clone);
  await step("mise install", "mise", ["install"], clone);
  const tools = await pinnedTools(clone);
  await step("pnpm install", tools.pnpm, ["install", "--frozen-lockfile"], clone, tools.path);
  await treeCheck(clone, sha, "before the build");
  await step("the web UI's build", tools.pnpm, ["--dir", "packages/server", "run", "build"], clone, tools.path);
  await publicationCheck(clone, {
    PRQ_HOST: host,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    ACCESS_TEAM_DOMAIN: teamHost,
    ACCESS_AUD: aud,
  });
  configCheck(clone);

  const dir = join(root, `${stamp()}-${tag}`);
  await mkdir(dir, { mode: 0o700 });
  const record = new Saved(dir, join(dir, "record.json"), {
    kind: "prq-deploy",
    tag,
    sha,
    accountId,
    worker: WORKER,
    host,
    clone,
    startedAt: now(),
    flags,
    before: { deployment: null, endpoints: null, application: null, unread: [] },
    outcome: "reading the state before",
    idle: null,
    upload: null,
    after: null,
    reread: null,
    application: null,
    rollout: null,
    readBack: null,
  });
  await record.save();
  const stop = async (outcome: string, ...lines: string[]): Promise<never> => {
    record.data.outcome = outcome;
    await record.save();
    throw new Refusal(...lines, `record: ${dir}`);
  };
  // A refusal recorded as the outcome.
  const refused = async (error: unknown): Promise<never> => {
    if (error instanceof Refusal) {
      await stop(`refused: ${error.lines.join("; ")}`, ...error.lines);
    }
    throw error;
  };

  const before = await readState(accountId);
  record.data.before = before;
  record.data.outcome = "read the state before";
  await record.save();
  if (before.unread.length > 0) {
    await stop("refused: the state before could not be read", ...before.unread);
  }
  const live = before.deployment?.versions ?? [];
  if (live.length === 0) {
    await stop(
      "refused: no live Worker",
      `the account has no live Worker ${WORKER}: run the deploy with --bootstrap first (docs/operations.md, First deploy)`,
    );
  }
  // A Worker that serves at workers.dev or a preview URL would serve the new version there too, from its upload until
  // wrangler turns them off, or for good if the deploy stops between.
  if (before.endpoints === null || before.endpoints.workersDev || before.endpoints.previews) {
    await stop(
      "refused: workers.dev or preview URLs not off",
      `the Worker ${WORKER} has ${endpointsLine(before.endpoints)}: finish the bootstrap (--bootstrap --resume, docs/operations.md, First deploy), or turn them off in the dashboard (${DASHBOARD})`,
    );
  }
  if (flags.keepImage && before.application === null) {
    await stop(
      "refused: --keep-image without an application",
      `--keep-image keeps the container application's image, and ${APPLICATION} does not exist yet: the first deploy creates it`,
    );
  }
  // The bootstrap's Worker, or a version secrets put made of it: no prq is served at the hostname yet.
  const bootstrapped = live.every((each) => each.inert);

  print(`account: ${accountId} (${name})`);
  print(`Worker: ${WORKER}, live: ${versionsLine(before.deployment?.versions)}`);
  print(`hostname: ${host}, attached as the Worker's custom domain; ${endpointsLine(before.endpoints)}`);
  print(`release: ${tag} at ${sha}`);
  print(
    `Access: the applications "prq" (${host}) and "prq webhook" (${host}/webhook) protect the hostname (docs/operations.md, Setup)`,
  );
  print(
    `container application ${APPLICATION}: ${before.application === null ? "none yet; this deploy creates it" : applicationLine(before.application)}`,
  );
  print(`container image: ${flags.keepImage ? "kept" : "built and pushed by wrangler"}`);
  print(
    `Durable Objects: ${flags.immediate ? "the new code at once" : "the new code within wrangler's deferred window"}`,
  );
  print(`record: ${dir}`);
  if (!(await answer(`Deploy ${tag} to ${host}? [y/N] `))) {
    await stop("declined", "nothing deployed");
  }

  // Immediately before the upload. Nothing is served at the hostname until the first release's deploy.
  record.data.idle = bootstrapped
    ? "skipped: the live Worker is the bootstrap's (no binding but secrets), which serves nothing at the hostname"
    : await idleCheck(host, flags.ignoreRunning).catch(refused);
  await treeCheck(clone, sha, "before the upload").catch(refused);
  record.data.outcome = "uploading";
  await record.save();

  const output = join(dir, "wrangler-output.jsonl");
  const [program, base] = cloneWrangler(clone, tools.node);
  onInterrupt(async (signal) => {
    record.data.upload = { exit: null, signal, timedOut: false, versionId: await deployedVersion(output) };
    record.data.outcome = `stopped by ${signal} during the upload; what is live is unread`;
    await record.save();
    printError(`deploy: stopped during the upload; read what is live with ${RESUME} ${dir}`);
  });
  const uploaded = await run(
    "wrangler deploy",
    program,
    [
      ...base,
      "deploy",
      `--config=${join(clone, "packages", "server", "wrangler.jsonc")}`,
      "--env",
      "",
      "--env-file",
      NO_ENV_FILE,
      `--domain=${host}`,
      `--tag=${tag}`,
      `--message=prq ${tag} ${sha}`,
      ...(flags.immediate ? ["--durable-objects-code-update-mode=immediate"] : []),
      ...(flags.keepImage ? ["--containers-rollout=none"] : []),
    ],
    {
      cwd: join(clone, "packages", "server"),
      env: { ...wranglerEnv(accountId), PATH: tools.path, WRANGLER_OUTPUT_FILE_PATH: output },
      output: "show",
      timeoutMs: uploadMs,
      foreground: true,
    },
  );
  onInterrupt(null);
  // Saved before what is live is read: a signal during that read leaves the upload's result recorded.
  record.data.upload = {
    exit: uploaded.code,
    signal: uploaded.signal,
    timedOut: uploaded.timedOut,
    versionId: await deployedVersion(output),
  };
  if (succeeded(uploaded)) {
    record.data.outcome = "deployed";
  } else {
    record.data.outcome = uploaded.timedOut
      ? `the upload did not finish within ${Math.round(uploadMs / 1000)} s and was stopped`
      : `the upload failed (exit ${uploaded.code ?? uploaded.signal ?? "unknown"})`;
  }
  await record.save();
  // The login read before the upload can have expired since (wrangler refreshes it when asked again).
  credentials = null;
  record.data.after = await readState(accountId, before.application?.id ?? null);
  pin(record, record.data.after.application);
  if (!succeeded(uploaded)) {
    await record.save();
    printError(`deploy: ${record.data.outcome}`);
    printError(`deploy: live now: ${versionsLine(record.data.after.deployment?.versions)}`);
    printError(`deploy: Worker: ${endpointsLine(record.data.after.endpoints)}`);
    printError(`deploy: container application: ${applicationLine(record.data.after.application)}`);
    printError(`deploy: record: ${dir} (docs/operations.md, Recovery)`);
    return uploaded.code !== null && uploaded.code !== 0 ? uploaded.code : 1;
  }
  record.data.application = classify(before.application, record.data.after.application, flags.keepImage);
  await record.save();
  return readBack(record);
}

// --read-back: the record's account and application read again, and the read-back it lacked. A record whose upload
// stopped is read back only when its version is live alone; otherwise what is live is recorded for the recovery. A
// record that reached the upload without its result (this process ended there with no chance to record it) takes the
// version from wrangler's output file, which wrangler writes once its deploy is done.
async function readBackAgain(path: string): Promise<number> {
  const info = await lstat(path).catch(() => null);
  const file = info?.isDirectory() === true ? join(path, "record.json") : path;
  const fileInfo = await lstat(file).catch(() => null);
  if (fileInfo?.isFile() !== true) {
    throw new Refusal(`${path} is not a deploy's record (a directory with record.json)`);
  }
  let json: unknown = null;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch {
    // Not JSON: refused below.
  }
  const parsed = v.safeParse(DeployRecord, json);
  if (!parsed.success) {
    throw new Refusal(`${file} is not a deploy's record`);
  }
  const record = new Saved(join(file, ".."), file, parsed.output);
  const { accountId, before, flags, tag } = record.data;
  await checkConfigAccount(accountId);
  if (record.data.upload === null && record.data.outcome === "uploading") {
    record.data.upload = {
      exit: null,
      signal: null,
      timedOut: false,
      versionId: await deployedVersion(join(record.dir, "wrangler-output.jsonl")),
    };
    record.data.outcome = "the deploy ended during the upload without recording its result";
  }
  const { upload } = record.data;
  if (upload === null) {
    throw new Refusal(`the record's deploy stopped before its upload (${record.data.outcome}): nothing to read back`);
  }
  const state = await readState(accountId, record.data.after?.application?.id ?? before.application?.id ?? null);
  record.data.reread = state;
  pin(record, state.application);
  print(`account: ${accountId}; live: ${versionsLine(state.deployment?.versions)}`);
  print(`container application ${APPLICATION}: ${applicationLine(state.application)}`);
  if (upload.exit !== 0) {
    const live = state.deployment?.versions ?? [];
    if (upload.versionId === null || live.length !== 1 || live[0]?.versionId !== upload.versionId) {
      await record.save();
      return settle(
        record,
        "incomplete",
        `the upload did not finish (${record.data.outcome}): deploy ${tag} again (docs/operations.md, Recovery)`,
      );
    }
    record.data.outcome = "deployed (read back after the upload stopped)";
  }
  if (record.data.application === null || record.data.application === "absent") {
    record.data.application = classify(before.application, state.application, flags.keepImage);
  }
  await record.save();
  return readBack(record);
}

// The bootstrap's Worker: every request answers 404, marked, with nothing else in it.
const INERT = `export default {
  fetch() {
    return new Response(null, { status: 404, headers: { "x-prq-bootstrap": "1" } });
  },
};
`;

async function bootstrap(resume: boolean): Promise<number> {
  const accountId = await account();
  await checkConfigAccount(accountId);
  const dir = await records("bootstrap");
  const name = await accountName(accountId);
  print(`account: ${accountId} (${name})`);
  print(`Worker: ${WORKER}`);
  const live = (await liveDeployment(accountId))?.versions ?? [];
  if (!resume && live.length > 0) {
    throw new Refusal(
      `the Worker ${WORKER} has a live version (${versionsLine(live)}): the bootstrap only creates it`,
      `after a bootstrap that stopped once its version was live: --bootstrap --resume`,
    );
  }
  if (resume) {
    if (live.length === 0) {
      throw new Refusal(`the Worker ${WORKER} has no live version to resume: run --bootstrap`);
    }
    const other = live.find((each) => each.tag !== BOOTSTRAP_TAG);
    if (other !== undefined) {
      throw new Refusal(
        `the live version ${other.versionId} is tagged ${other.tag ?? "nothing"}, not ${BOOTSTRAP_TAG}: --resume deploys only over the bootstrap's Worker`,
      );
    }
  }

  const work = await mkdtemp(join(tmpdir(), "prq-bootstrap-"));
  onInterrupt(() => removeOwn(work));
  let versionId: string | null;
  try {
    const config = {
      name: WORKER,
      main: "index.js",
      compatibility_date: COMPATIBILITY_DATE,
      workers_dev: false,
      preview_urls: false,
    };
    await writeFile(join(work, "wrangler.jsonc"), `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await writeFile(join(work, "index.js"), INERT, { flag: "wx", mode: 0o600 });
    const output = join(work, "wrangler-output.jsonl");
    print(`deploy: the bootstrap's inert Worker ${WORKER}, with workers.dev and preview URLs off`);
    const outcome = await wrangler(
      [
        "deploy",
        `--config=${join(work, "wrangler.jsonc")}`,
        "--env",
        "",
        "--env-file",
        NO_ENV_FILE,
        `--tag=${BOOTSTRAP_TAG}`,
        "--message=prq bootstrap: serves nothing",
      ],
      accountId,
      { output: "show", cwd: work, env: { WRANGLER_OUTPUT_FILE_PATH: output } },
    );
    if (!succeeded(outcome)) {
      throw failed("deploy", outcome);
    }
    versionId = await deployedVersion(output);
  } finally {
    onInterrupt(null);
    await removeOwn(work);
  }
  const after = (await liveDeployment(accountId))?.versions ?? [];
  if (versionId === null || after.length !== 1 || after[0]?.versionId !== versionId || after[0].tag !== BOOTSTRAP_TAG) {
    throw new Refusal(
      `the live versions are ${versionsLine(after)}, not the bootstrap's ${versionId ?? "(unnamed)"} alone`,
    );
  }
  print(`version: ${versionId} (${BOOTSTRAP_TAG})`);

  const given = (
    (await ask(
      "The account's workers.dev subdomain, as the dashboard shows it (Workers & Pages, the account's <subdomain>.workers.dev), or none: ",
    )) ?? ""
  )
    .trim()
    .toLowerCase()
    .replace(/\.workers\.dev$/, "");
  const subdomain = given === "none" || SUBDOMAIN.test(given) ? given : null;
  const file = join(dir, `${stamp()}.json`);
  const urls =
    subdomain === null || subdomain === "none"
      ? null
      : {
          production: `https://${WORKER}.${subdomain}.workers.dev/`,
          preview: `https://${versionId.slice(0, 8)}-${WORKER}.${subdomain}.workers.dev/`,
        };
  await writeFile(
    file,
    `${JSON.stringify({ kind: "prq-bootstrap", accountId, worker: WORKER, versionId, tag: BOOTSTRAP_TAG, subdomain, urls, at: now(), resumed: resume }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  print(`record: ${file}`);
  print(`in the dashboard (${DASHBOARD}): workers.dev and Preview URLs disabled, no custom domain`);
  if (urls !== null) {
    print(`serve nothing of prq: ${urls.production} and ${urls.preview}`);
    print("then run:");
    print(checkCommand(CLI_DIR, `endpoints ${subdomain} --version ${versionId}`));
  } else if (subdomain === "none") {
    print("then run:");
    print(checkCommand(CLI_DIR, "endpoints none"));
    print("with no subdomain, the dashboard's settings above are the evidence");
  }
  if (subdomain === null) {
    printError(
      "deploy: no workers.dev subdomain recorded (a subdomain, or none): run --bootstrap --resume to record it",
    );
    return 2;
  }
  return 0;
}

// wrangler takes an environment ci-info marks as CI as one with nobody to ask, and answers its own questions (whether to
// replace a DNS record or another Worker's domain) with their defaults: the deploy runs from the owner's terminal alone.
function notInCi(): void {
  if (!isCI) {
    return;
  }
  const vendor =
    ciName === null
      ? undefined
      : v.parse(Vendors, createRequire(import.meta.url)("ci-info/vendors.json")).find((each) => each.name === ciName);
  const marks = new Set([
    ...CI_VARIABLES.filter(isSet),
    ...(vendor === undefined ? [] : [vendor.env].flat().flatMap(vendorVariables).filter(isSet)),
  ]);
  throw new Refusal(
    `the environment marks this run as CI (${marks.size > 0 ? [...marks].join(", ") : `the variables of ${ciName ?? "a CI service"}`}), where wrangler answers its own questions: deploy from a terminal of your own`,
  );
}

async function main(args: readonly string[]): Promise<number> {
  refuseOverrides();
  const [first = "", ...rest] = args;
  if (first === "--bootstrap" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--resume"))) {
    notInCi();
    return bootstrap(rest.length === 1);
  }
  if (first === "--read-back" && rest.length === 1 && rest[0] !== undefined) {
    return readBackAgain(rest[0]);
  }
  const known = ["--ignore-running", "--immediate", "--keep-image"];
  if (TAG.test(first) && rest.every((arg) => known.includes(arg)) && new Set(rest).size === rest.length) {
    notInCi();
    return release(first, {
      ignoreRunning: rest.includes("--ignore-running"),
      immediate: rest.includes("--immediate"),
      keepImage: rest.includes("--keep-image"),
    });
  }
  throw new Refusal(USAGE);
}

// A "--" before the arguments (as some package managers pass it) is not an argument.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
await runCommand("deploy", async () => {
  process.exitCode = await main(args);
});
