// The deploy (deploy.ts) run through the tests' entry (test-entry.ts), whose fixture gives it the stand-ins and shorter
// bounds, from a host's clone whose origin is a GitHub URL that the
// fixture's git config rewrites to a bare repository, all in the OS temp directory: stand-ins for wrangler (its answers
// kept in a state file each call reads and changes), mise, pnpm and gh record every call, and a local server answers
// the ledger for the idle check and Cloudflare's API for the deploy's own reads. A release deploy needs a terminal:
// those runs get one from python3's pty module.
// Nothing reaches the network or an account.

import { type ChildProcess, execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

import { parseInvocation } from "../../cli/src/test/deployed-invocation.ts";
import { FixtureGit, type FixtureRepo, fixtureRoot } from "../../cli/src/test/git.ts";
import type { Fixture } from "./fixture.ts";
import { runInTerminal } from "./test-terminal.ts";

const SCRIPT = fileURLToPath(new URL("deploy.ts", import.meta.url));
const CLI_DIR = fileURLToPath(new URL("../../cli", import.meta.url));
const TEST_ENTRY = fileURLToPath(new URL("test-entry.ts", import.meta.url));
const CONFIG = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const REPOSITORY = "prq-test/prq";
const TAG = "v0.1.0";
const ACCOUNT = "5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e";
const OTHER_ACCOUNT = "feedfacefeedfacefeedfacefeedface";
const HOST = "prq.sentinel-zone.example";
const TEAM = "https://sentinel-team.cloudflareaccess.example";
const AUD = "sentinel-aud-5e3c0b9a7d1f4e2a";
const TOKEN = { id: "sentinel-client-id.access", secret: "sentinel-client-secret-77aa" };
// wrangler's credentials as the stand-in's `auth token --json` gives them: a token, or a global API key and its email.
const API_TOKEN = "sentinel-api-token-6b2f9e";
// The token once wrangler has refreshed its login, which an `auth token` behavior of "refreshed" gives.
const API_TOKEN_REFRESHED = "sentinel-api-token-refreshed-3a7c51";
const API_KEY = { key: "sentinel-api-key-0d4c81", email: "owner@sentinel-mail.example" };
// Whether a stand-in's environment holds any of them, as each stand-in records it.
const CREDENTIAL_IN_ENV = `Object.values(process.env).some((value) => [${JSON.stringify(API_TOKEN)}, ${JSON.stringify(API_TOKEN_REFRESHED)}, ${JSON.stringify(API_KEY.key)}].some((secret) => value?.includes(secret)))`;
// The names of the variables mise's [env] sets (FAKE_MISE_ENV) that a stand-in's environment holds as mise sets them.
const FROM_MISE = `Object.entries(JSON.parse(process.env.FAKE_MISE_ENV ?? "{}")).filter(([name, value]) => process.env[name] === value).map(([name]) => name)`;
const APPLICATION = "prq-workspace";
// The tag's Worker configuration: what the deploy checks of it.
const WORKER_CONFIG = '{ "name": "prq", "workers_dev": false, "preview_urls": false }\n';

// The stand-in for wrangler. Its state (FAKE_WRANGLER_STATE): the live versions, each version's tag, how a version's
// view lists its bindings (inventory), the Worker's workers.dev and preview URLs (subdomain, which a deploy sets from
// its configuration once it is done, or to subdomainAfterDeploy), the credentials `auth token` gives (auth; its
// behavior "refreshed" gives the refreshed token), the container applications, how many reads of a changed application still find its rollout active, whether a deploy changes the
// image, the pages of instances it lists (by default an instance at the application's version once its rollout is
// done, then an inactive Durable Object), a behavior per call ("fail", "hang", or for deploy "fail-after-upload" and
// "hang-after-upload"), and the behaviors a deploy sets once it has uploaded (afterDeploy). Each call appends its arguments,
// working directory, parent and environment (and a deploy its config file) to FAKE_WRANGLER_LOG; a hanging call writes
// its pid and its child's to FAKE_WRANGLER_PIDS.
const FAKE_WRANGLER = `#!${process.execPath}
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const call = ["auth", "containers", "deployments", "versions"].includes(args[0]) ? args[0] + " " + args[1] : args[0];
const flag = (name) => args.find((arg) => arg.startsWith("--" + name + "="))?.slice(name.length + 3) ?? null;
const config = call === "deploy" && flag("config") !== null ? readFileSync(flag("config"), "utf8") : null;
const env = {};
for (const name of ["CLOUDFLARE_ACCOUNT_ID", "WRANGLER_OUTPUT_FILE_PATH", "WRANGLER_LOG_SANITIZE", "PRQ_ACCESS_CLIENT_SECRET"]) {
  env[name] = process.env[name] ?? null;
}
const credentialInEnv = ${CREDENTIAL_IN_ENV};
const fromMise = ${FROM_MISE};
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ call, args, cwd: process.cwd(), ppid: process.ppid, env, names: Object.keys(process.env), fromMise, config, credentialInEnv }) + "\\n");
const statePath = process.env.FAKE_WRANGLER_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const behavior = state.behavior?.[call];
const json = (value) => console.log(JSON.stringify(value, null, 2));
const hang = () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.FAKE_WRANGLER_PIDS, JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
};
if (behavior === "hang") {
  hang();
} else if (behavior === "fail") {
  console.error("✘ [ERROR] A request to the Cloudflare API failed. [code: 10000]");
  process.exit(1);
} else if (call === "auth token") {
  json(state.auth === "api_key" ? { type: "api_key", ...${JSON.stringify(API_KEY)} } : { type: "oauth", token: behavior === "refreshed" ? ${JSON.stringify(API_TOKEN_REFRESHED)} : ${JSON.stringify(API_TOKEN)} });
} else if (call === "whoami") {
  json({ loggedIn: true, accounts: [{ id: process.env.CLOUDFLARE_ACCOUNT_ID, name: "Synthetic Account" }] });
} else if (call === "deployments status") {
  if (state.deployment === null) {
    console.error("✘ [ERROR] A request to the Cloudflare API (/accounts/x/workers/scripts/prq/deployments) failed.");
    console.error("  This Worker does not exist on your account. [code: 10007]");
    process.exit(1);
  }
  const percentage = 100 / state.deployment.length;
  json({ id: "deployment-" + state.uploads, versions: state.deployment.map((id) => ({ version_id: id, percentage })) });
} else if (call === "versions view") {
  // The bootstrap's Worker and a version secrets put made of it have no binding but secrets; a release has prq's.
  const tag = state.versions[args[2]] ?? undefined;
  const bindings = tag === undefined || tag === "prq-bootstrap" ? [{ type: "secret_text" }] : [{ type: "durable_object_namespace" }, { type: "assets" }];
  // "no resources" and "null bindings": a view that does not list them.
  const resources = state.inventory === "no resources" ? undefined : { bindings: state.inventory === "null bindings" ? null : bindings };
  json({ id: args[2], annotations: { "workers/tag": tag }, resources });
} else if (call === "containers list") {
  // As wrangler prints it: the first page alone.
  json(state.applications.slice(0, 25).map((app) => ({ id: app.id, name: app.name, state: "ready", version: app.version })));
} else if (call === "containers info") {
  const app = state.applications.find((each) => each.id === args[2]);
  const rolling = state.rolloutReads > 0;
  if (rolling) {
    state.rolloutReads -= 1;
    save();
  }
  json({ id: app.id, name: app.name, version: app.version, configuration: { image: app.image }, active_rollout_id: rolling ? "rollout-" + app.version : undefined });
} else if (call === "containers instances") {
  const app = state.applications.find((each) => each.id === args[2]);
  const pages = state.instancePages ?? [
    [{ id: "instance-1", name: "pr-1", state: "running", version: state.rolloutReads > 0 ? app.version - 1 : app.version }],
    [{ id: "durable-object-2", name: "pr-2", state: "inactive", version: null }],
  ];
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const page = Number(option("--page-token") ?? 0);
  if (option("--per-page") === undefined && option("--page-token") === undefined) {
    // wrangler's form without paging: the first page alone.
    json(pages[0]);
  } else {
    json({ instances: pages[page], result_info: { per_page: Number(option("--per-page")), page_token: option("--page-token") ?? null, next_page_token: page + 1 < pages.length ? String(page + 1) : null } });
  }
} else if (call === "deploy") {
  state.uploads += 1;
  const id = String(state.uploads).padStart(8, "0") + "-0000-4000-8000-000000000000";
  state.versions[id] = flag("tag");
  // "split": the new version shares the traffic with what was live, as after a gradual deployment.
  state.deployment = behavior === "split" ? [...(state.deployment ?? []), id] : [id];
  if (flag("tag") !== "prq-bootstrap" && !args.includes("--containers-rollout=none")) {
    const app = state.applications.find((each) => each.name === "prq-workspace");
    if (app === undefined) {
      state.applications.push({ id: "a1b2c3d4-0000-4000-8000-00000000000a", name: "prq-workspace", version: 1, image: "registry.example/prq-workspace:" + id.slice(0, 8) });
    } else if (state.imageChanges) {
      app.version += 1;
      app.image = "registry.example/prq-workspace:" + id.slice(0, 8);
      state.rolloutReads = state.rolloutAfterDeploy;
    }
  }
  state.behavior = { ...state.behavior, ...state.afterDeploy };
  save();
  console.log("Uploaded prq");
  if (behavior === "fail-after-upload") {
    console.error("✘ [ERROR] The container image could not be pushed.");
    process.exit(1);
  }
  const settings = JSON.parse(config ?? "{}");
  state.subdomain = state.subdomainAfterDeploy ?? { enabled: settings.workers_dev ?? true, previews_enabled: settings.preview_urls ?? true };
  save();
  appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({ type: "deploy", version: 1, worker_name: "prq", version_id: id }) + "\\n");
  console.log("Current Version ID: " + id);
  if (behavior === "hang-after-upload") {
    hang();
  }
}
`;

// mise: every call recorded. which prints a pinned tool's path: this Node, and the pnpm in pinned/ beside this file, or
// what FAKE_MISE_WHICH gives the tool in their place (null: it fails; "hang": it never ends). exec runs what follows --
// with this terminal, in the environment it was given with its [env] (FAKE_MISE_ENV: what it adds and what it
// replaces), and exits as it does.
const FAKE_MISE = `#!${process.execPath}
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const credentialInEnv = ${CREDENTIAL_IN_ENV};
appendFileSync(process.env.FAKE_TOOLS_LOG, JSON.stringify({ tool: "mise", args, cwd: process.cwd(), pid: process.pid, ppid: process.ppid, credentialInEnv }) + "\\n");
if (args[0] === "exec") {
  const rest = args.slice(args.indexOf("--") + 1);
  const child = spawn(rest[0], rest.slice(1), { stdio: "inherit", env: { ...process.env, ...JSON.parse(process.env.FAKE_MISE_ENV ?? "{}") } });
  child.on("exit", (code) => process.exit(code ?? 1));
} else if (args[0] === "which") {
  const paths = { node: process.execPath, pnpm: join(dirname(process.argv[1]), "pinned", "pnpm"), ...JSON.parse(process.env.FAKE_MISE_WHICH ?? "{}") };
  const path = paths[args[1]] ?? null;
  if (path === "hang") {
    setInterval(() => {}, 1000);
  } else if (path === null) {
    console.error("mise ERROR " + args[1] + " is not a mise bin");
    process.exit(1);
  } else {
    console.log(path);
  }
}
`;

// pnpm: recorded with its path, the build's overrides it was given and what of mise's [env] it holds; FAKE_PNPM_CHANGE
// names the command ("install" or "build") that changes a tracked file of the clone.
const FAKE_PNPM = `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const env = { PRQ_BUILD_VERSION: process.env.PRQ_BUILD_VERSION ?? null, PRQ_BUILD_PREFIX: process.env.PRQ_BUILD_PREFIX ?? null };
const credentialInEnv = ${CREDENTIAL_IN_ENV};
const fromMise = ${FROM_MISE};
appendFileSync(process.env.FAKE_TOOLS_LOG, JSON.stringify({ tool: "pnpm", path: process.argv[1], args, cwd: process.cwd(), env, fromMise, credentialInEnv }) + "\\n");
if (process.env.FAKE_PNPM_CHANGE === (args[0] === "install" ? "install" : "build")) {
  writeFileSync("packages/cli/package.json", JSON.stringify({ version: "0.1.0", changed: true }) + "\\n");
}
`;

const FAKE_GH = `#!${process.execPath}
import { appendFileSync } from "node:fs";

const credentialInEnv = ${CREDENTIAL_IN_ENV};
appendFileSync(process.env.FAKE_TOOLS_LOG, JSON.stringify({ tool: "gh", args: process.argv.slice(2), cwd: process.cwd(), credentialInEnv }) + "\\n");
process.stdout.write(process.env.FAKE_GH_ANSWER ?? "{}");
`;

const WranglerCall = v.object({
  call: v.string(),
  args: v.array(v.string()),
  cwd: v.string(),
  ppid: v.number(),
  env: v.record(v.string(), v.nullable(v.string())),
  names: v.array(v.string()),
  fromMise: v.array(v.string()),
  config: v.nullable(v.string()),
  credentialInEnv: v.boolean(),
});
type WranglerCall = v.InferOutput<typeof WranglerCall>;
const ToolCall = v.object({
  tool: v.string(),
  path: v.optional(v.string()),
  args: v.array(v.string()),
  cwd: v.string(),
  pid: v.optional(v.number()),
  ppid: v.optional(v.number()),
  env: v.optional(v.record(v.string(), v.nullable(v.string()))),
  fromMise: v.optional(v.array(v.string())),
  credentialInEnv: v.boolean(),
});
type ToolCall = v.InferOutput<typeof ToolCall>;

type State = {
  deployment: string[] | null;
  versions: Record<string, string | null>;
  inventory: "listed" | "no resources" | "null bindings";
  applications: { id: string; name: string; version: number; image: string }[];
  uploads: number;
  imageChanges: boolean;
  rolloutReads: number;
  rolloutAfterDeploy: number;
  behavior: Record<string, string>;
  afterDeploy: Record<string, string>;
  instancePages: { state: string; version: number | null }[][] | null;
  subdomain: { enabled: boolean; previews_enabled: boolean };
  subdomainAfterDeploy: { enabled: boolean; previews_enabled: boolean } | null;
  auth: "oauth" | "api_key";
};
type Result = { code: number | null; signal: NodeJS.Signals | null; output: string };

let bin: string;
let root: string;
let fixture: FixtureGit;
let origin: FixtureRepo;
let seed: FixtureRepo;
let host: FixtureRepo;
let commit: string;
let env: Record<string, string>;
// What the entry gives the deploy; the stand-ins' own settings (FAKE_*) are added to wrangler's environment.
let settings: v.InferOutput<typeof Fixture>;
let server: Server;
let port: number;
let ledger: { rows: unknown[]; nextCursor: string | null }[];
let ledgerRequests: { url: string; headers: IncomingHttpHeaders }[];
let apiRequests: { method: string; url: string; headers: IncomingHttpHeaders }[];

const LIVE = "00000009-0000-4000-8000-000000000000";
const APP = {
  id: "a1b2c3d4-0000-4000-8000-00000000000a",
  name: APPLICATION,
  version: 3,
  image: "registry.example/prq-workspace:00000009",
};

// The stand-in for Cloudflare's API, from the stand-in for wrangler's state: the Worker's settings (none without a
// live Worker) and every container application, to the credentials `auth token` gives now alone (others answer 401,
// as an expired login does). A behavior "api workers" or "api applications" of "fail" answers 500.
const ApiState = v.looseObject({
  auth: v.picklist(["oauth", "api_key"]),
  deployment: v.nullable(v.array(v.string())),
  applications: v.array(v.unknown()),
  subdomain: v.unknown(),
  behavior: v.record(v.string(), v.string()),
});

function cloudflare(url: string, headers: IncomingHttpHeaders): [number, unknown] {
  const state = v.parse(ApiState, JSON.parse(readFileSync(join(root, "wrangler-state.json"), "utf8")));
  const failed = (name: string) => state.behavior[name] === "fail";
  const token = state.behavior["auth token"] === "refreshed" ? API_TOKEN_REFRESHED : API_TOKEN;
  const signedIn =
    state.auth === "api_key"
      ? headers["x-auth-key"] === API_KEY.key && headers["x-auth-email"] === API_KEY.email
      : headers.authorization === `Bearer ${token}`;
  if (!signedIn) {
    return [401, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }];
  }
  const prefix = `/client/v4/accounts/${ACCOUNT}`;
  if (url === `${prefix}/workers/workers/prq`) {
    if (failed("api workers")) {
      return [500, { success: false, errors: [{ code: 10000, message: "Internal error" }] }];
    }
    return state.deployment === null
      ? [404, { success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }] }]
      : [200, { success: true, errors: [], result: { id: "prq", name: "prq", subdomain: state.subdomain } }];
  }
  if (url === `${prefix}/containers/applications`) {
    return failed("api applications")
      ? [500, { success: false, errors: [{ code: 1000, message: "Internal error" }] }]
      : [200, { success: true, errors: [], result: state.applications }];
  }
  return [404, { success: false, errors: [{ code: 7003, message: "No route for that URI" }] }];
}

// A ledger row of a pull request, its owner and its jobs.
function ledgerRow(number: number, owner: string, waiting: number, running: number) {
  return {
    pr: { owner: "prq-test", repo: "app", number },
    details: null,
    owner,
    latestEvent: null,
    problem: null,
    jobs: { waiting, running, failed: 0 },
    claims: [],
  };
}

function checkRuns(sha: string): string {
  return JSON.stringify({
    total_count: 1,
    check_runs: [
      { name: "Check", head_sha: sha, status: "completed", conclusion: "success", app: { slug: "github-actions" } },
    ],
  });
}

// One stand-in each, run once here: macOS checks a new executable on its first run, which can take seconds.
beforeAll(async () => {
  bin = await fixtureRoot("prq-deploy-bin-");
  await mkdir(join(bin, "pinned"));
  // pnpm on PATH as well as the pinned one, as a machine with another pnpm has it.
  for (const [name, text] of [
    ["wrangler", FAKE_WRANGLER],
    ["mise", FAKE_MISE],
    ["pnpm", FAKE_PNPM],
    ["pinned/pnpm", FAKE_PNPM],
    ["gh", FAKE_GH],
  ] as const) {
    await writeFile(join(bin, name), text, { mode: 0o700 });
    await new Promise<void>((resolve) => {
      execFile(join(bin, name), ["warm"], { env: { FAKE_TOOLS_LOG: join(bin, "warm.jsonl") }, timeout: 60_000 }, () =>
        resolve(),
      );
    });
  }
  server = createServer((request, response) => {
    if (request.url?.startsWith("/client/v4/") === true) {
      apiRequests.push({ method: request.method ?? "", url: request.url, headers: request.headers });
      const [status, body] = cloudflare(request.url, request.headers);
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      return;
    }
    ledgerRequests.push({ url: request.url ?? "", headers: request.headers });
    const cursor = new URL(request.url ?? "/", "http://localhost").searchParams.get("cursor");
    const page = ledger[cursor === null ? 0 : Number(cursor)] ?? { rows: [], nextCursor: null };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(page));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
}, 120_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(bin, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await fixtureRoot("prq-deploy-");
  fixture = await FixtureGit.create(root, { [`https://github.com/${REPOSITORY}.git`]: "origin.git" });
  origin = await fixture.init("origin.git", { bare: true });
  seed = await fixture.init("seed");
  for (const path of ["packages/server", "packages/cli"]) {
    await mkdir(join(seed.path, path), { recursive: true });
    await writeFile(join(seed.path, path, "package.json"), `${JSON.stringify({ version: "0.1.0" })}\n`);
  }
  await writeFile(join(seed.path, "packages/server/wrangler.jsonc"), WORKER_CONFIG);
  await seed.add("packages");
  await seed.commit("chore(release): v0.1.0");
  commit = await seed.headCommit();
  await seed.push(origin, "HEAD:refs/heads/main");
  await seed.tagAnnotated(TAG, commit, `prq ${TAG}`);
  await seed.push(origin, `refs/tags/${TAG}`);
  host = await fixture.clone(origin, "host");

  const directory = join(root, "deploy");
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(join(directory, "target.env"), `PRQ_HOST=${HOST}\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`, {
    mode: 0o600,
  });
  await writeFile(join(directory, "worker.env"), `ACCESS_TEAM_DOMAIN=${TEAM}\nACCESS_AUD=${AUD}\n`, { mode: 0o600 });
  await mkdir(join(root, "tmp"));
  await saveState({});
  ledger = [{ rows: [], nextCursor: null }];
  ledgerRequests = [];
  apiRequests = [];
  env = {
    ...fixture.env,
    PATH: `${bin}:${fixture.env["PATH"] ?? ""}`,
    TMPDIR: join(root, "tmp"),
    PRQ_ACCESS_CLIENT_ID: TOKEN.id,
    PRQ_ACCESS_CLIENT_SECRET: TOKEN.secret,
    FAKE_WRANGLER_STATE: join(root, "wrangler-state.json"),
    FAKE_WRANGLER_LOG: join(root, "wrangler.jsonl"),
    FAKE_WRANGLER_PIDS: join(root, "wrangler-pids.json"),
    FAKE_TOOLS_LOG: join(root, "tools.jsonl"),
    FAKE_GH_ANSWER: checkRuns(commit),
  };
  settings = {
    directory,
    wrangler: join(bin, "wrangler"),
    waitMs: 15_000,
    pollMs: 50,
    rolloutMs: 20_000,
    origin: `http://127.0.0.1:${port}`,
    api: `http://127.0.0.1:${port}/client/v4`,
  };
});

// The processes a test started, and those the stand-in recorded: a test that failed leaves none running.
const started: ChildProcess[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const pid of await hangingPids(false)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It has ended.
    }
  }
  await rm(root, { recursive: true, force: true });
});

async function saveState(state: Partial<State>): Promise<void> {
  const full: State = {
    deployment: null,
    versions: {},
    inventory: "listed",
    applications: [],
    uploads: 9,
    imageChanges: false,
    rolloutReads: 0,
    rolloutAfterDeploy: 2,
    behavior: {},
    afterDeploy: {},
    instancePages: null,
    subdomain: { enabled: false, previews_enabled: false },
    subdomainAfterDeploy: null,
    auth: "oauth",
    ...state,
  };
  await writeFile(join(root, "wrangler-state.json"), JSON.stringify(full));
}

// The stand-in's state as it is now, changed.
async function changeState(change: Partial<State>): Promise<void> {
  const path = join(root, "wrangler-state.json");
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), ...change }));
}

// A release live, with its container application, as after an earlier deploy.
async function released(state: Partial<State> = {}): Promise<void> {
  await saveState({ deployment: [LIVE], versions: { [LIVE]: "v0.0.9" }, applications: [{ ...APP }], ...state });
}

// The bootstrap's Worker live, before the first release.
async function bootstrapped(state: Partial<State> = {}): Promise<void> {
  await saveState({ deployment: [LIVE], versions: { [LIVE]: "prq-bootstrap" }, ...state });
}

// The deploy with these arguments, in a terminal unless told otherwise, answering each question it asks in turn,
// through the tests' entry with the settings, or (production) as `pnpm run deploy` runs it, with none. Its output never
// holds a value it must not print.
function start(args: string[], { terminal = true, answers = [] as string[], production = false } = {}) {
  const file = join(root, "fixture.json");
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("FAKE_")));
  writeFileSync(file, JSON.stringify({ ...settings, childEnv }));
  const command = production
    ? [process.execPath, SCRIPT, ...args]
    : [process.execPath, TEST_ENTRY, file, "deploy", ...args];
  const { child, result: finished } = runInTerminal(command, {
    cwd: host.path,
    env,
    terminal,
    answers,
    prompt: /\[y\/N\] |, or none: /,
  });
  started.push(child);
  const result = finished.then((outcome) => {
    for (const secret of [
      TEAM,
      "sentinel-team",
      AUD,
      TOKEN.secret,
      API_TOKEN,
      API_TOKEN_REFRESHED,
      API_KEY.key,
      API_KEY.email,
    ]) {
      expect(outcome.output).not.toContain(secret);
    }
    return outcome;
  });
  return { child, result };
}

function deploy(
  args: string[],
  options: { terminal?: boolean; answers?: string[]; production?: boolean } = {},
): Promise<Result> {
  return start(args, options).result;
}

async function lines<T extends v.GenericSchema>(file: string, schema: T): Promise<v.InferOutput<T>[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => v.parse(schema, JSON.parse(line)));
}

function wranglerCalls(): Promise<WranglerCall[]> {
  return lines(join(root, "wrangler.jsonl"), WranglerCall);
}

function toolCalls(): Promise<ToolCall[]> {
  return lines(join(root, "tools.jsonl"), ToolCall);
}

async function deployCalls(): Promise<WranglerCall[]> {
  return (await wranglerCalls()).filter((call) => call.call === "deploy");
}

// The records the deploys kept, oldest first.
async function recordDirs(): Promise<string[]> {
  const dir = join(root, ".local", "state", "prq", "deploys");
  const names = (await readdir(dir).catch(() => [])).filter((name) => name !== "bootstrap").toSorted();
  return names.map((name) => join(dir, name));
}

const RecordJson = v.looseObject({
  tag: v.string(),
  sha: v.string(),
  clone: v.string(),
  outcome: v.string(),
  idle: v.nullable(v.string()),
  application: v.nullable(v.string()),
  upload: v.nullable(v.looseObject({ exit: v.nullable(v.number()), versionId: v.nullable(v.string()) })),
  after: v.nullable(
    v.looseObject({
      deployment: v.nullable(v.looseObject({ versions: v.array(v.looseObject({ versionId: v.string() })) })),
    }),
  ),
  readBack: v.nullable(
    v.looseObject({
      state: v.string(),
      reason: v.string(),
      provisioning: v.nullable(v.string()),
      rounds: v.array(v.unknown()),
    }),
  ),
});

async function record(dir: string): Promise<v.InferOutput<typeof RecordJson>> {
  return v.parse(RecordJson, JSON.parse(await readFile(join(dir, "record.json"), "utf8")));
}

async function onlyRecord(): Promise<{ dir: string; data: v.InferOutput<typeof RecordJson> }> {
  const dirs = await recordDirs();
  expect(dirs).toHaveLength(1);
  const dir = dirs[0] ?? "";
  return { dir, data: await record(dir) };
}

// The files under dir (symbolic links not followed) that hold text.
async function filesHolding(dir: string, text: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await filesHolding(path, text)));
    } else if (entry.isFile() && (await readFile(path)).includes(text)) {
      found.push(path);
    }
  }
  return found;
}

// What is left in the deploy's temp directory besides its clones.
// The deployed checks the output prints, one command a line, as a POSIX shell reads each with the variables given:
// the CLI package each runs in, and its arguments as the check's parser takes them.
function printedChecks(output: string, variables: Record<string, string> = {}) {
  return output
    .split("\n")
    .filter((line) => line.trimStart().startsWith("pnpm --dir "))
    .map((line) => {
      const words = execFileSync("/bin/sh", ["-c", `set -- ${line}; printf '%s\\0' "$@"`], {
        env: { PATH: process.env["PATH"] ?? "", ...variables },
        encoding: "utf8",
      })
        .split("\0")
        .slice(0, -1);
      expect(words.slice(0, 1)).toEqual(["pnpm"]);
      expect(words.slice(3, 6)).toEqual(["run", "check:deployed", "--"]);
      return { dir: words[2], invocation: parseInvocation(words.slice(6)) };
    });
}

async function leftInTmp(): Promise<string[]> {
  return (await readdir(join(root, "tmp"))).filter((name) => !/^prq-deploy-v[0-9]/.test(name));
}

async function hangingPids(wait = true): Promise<number[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const text = await readFile(join(root, "wrangler-pids.json"), "utf8").catch(() => "");
    if (text !== "" || !wait) {
      return text === "" ? [] : v.parse(v.array(v.number()), JSON.parse(text));
    }
    if (Date.now() > deadline) {
      throw new Error("the stand-in for wrangler did not hang");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function ended(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("not reached in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("the Worker's configuration", () => {
  it("keeps workers.dev and preview URLs off for every deploy, and names the application the deploy reads", () => {
    const config = unstable_readConfig({ config: CONFIG });

    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.containers?.map((container: { name?: string }) => container.name)).toEqual([APPLICATION]);
  });
});

describe("deploy --bootstrap", () => {
  it("deploys an inert Worker with workers.dev and preview URLs off, then records its version and the subdomain", async () => {
    const result = await deploy(["--bootstrap"], { terminal: false, answers: ["synthetic-sub"] });

    expect(result.code).toBe(0);
    const [call] = await deployCalls();
    expect(call?.args).toEqual([
      "deploy",
      `--config=${join(call?.cwd ?? "", "wrangler.jsonc")}`,
      "--env",
      "",
      "--env-file",
      "/dev/null",
      "--tag=prq-bootstrap",
      "--message=prq bootstrap: serves nothing",
    ]);
    expect(call?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, WRANGLER_LOG_SANITIZE: "true" });
    expect(JSON.parse(call?.config ?? "")).toEqual({
      name: "prq",
      main: "index.js",
      compatibility_date: "2026-11-10",
      workers_dev: false,
      preview_urls: false,
    });
    const version = "00000010-0000-4000-8000-000000000000";
    expect(result.output).toContain(`version: ${version} (prq-bootstrap)`);
    expect(result.output).toContain(
      "in the dashboard (Workers & Pages → prq → Settings → Domains & Routes): workers.dev and Preview URLs disabled, no custom domain",
    );
    expect(printedChecks(result.output)).toEqual([
      {
        dir: CLI_DIR,
        invocation: { mode: "endpoints", subdomain: "synthetic-sub", version, json: undefined },
      },
    ]);
    const dir = join(root, ".local", "state", "prq", "deploys", "bootstrap");
    const [file] = await readdir(dir);
    expect(JSON.parse(await readFile(join(dir, file ?? ""), "utf8"))).toMatchObject({
      accountId: ACCOUNT,
      versionId: version,
      tag: "prq-bootstrap",
      subdomain: "synthetic-sub",
      urls: {
        production: "https://prq.synthetic-sub.workers.dev/",
        preview: "https://00000010-prq.synthetic-sub.workers.dev/",
      },
    });
    expect(await leftInTmp()).toEqual([]);
  });

  it("refuses while a Worker prq has a live version, and deploys nothing", async () => {
    await released();

    const result = await deploy(["--bootstrap"], { terminal: false });

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `deploy: the Worker prq has a live version (${LIVE} (v0.0.9, 100 %)): the bootstrap only creates it`,
    );
    expect(await deployCalls()).toEqual([]);
  });

  it("resumes only over a live version tagged prq-bootstrap", async () => {
    const none = await deploy(["--bootstrap", "--resume"], { terminal: false });
    expect(none.code).toBe(1);
    expect(none.output).toContain("deploy: the Worker prq has no live version to resume: run --bootstrap");
    expect(await deployCalls()).toEqual([]);

    await released();
    const refused = await deploy(["--bootstrap", "--resume"], { terminal: false });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain(`deploy: the live version ${LIVE} is tagged v0.0.9, not prq-bootstrap`);
    expect(await deployCalls()).toEqual([]);

    await bootstrapped();
    const resumed = await deploy(["--bootstrap", "--resume"], { terminal: false, answers: ["none"] });
    expect(resumed.code).toBe(0);
    expect(await deployCalls()).toHaveLength(1);
    expect(printedChecks(resumed.output)).toEqual([
      { dir: CLI_DIR, invocation: { mode: "endpoints", subdomain: null, version: undefined, json: undefined } },
    ]);
    expect(resumed.output).toContain(
      "in the dashboard (Workers & Pages → prq → Settings → Domains & Routes): workers.dev and Preview URLs disabled, no custom domain",
    );
  });

  it("records no subdomain it cannot read, and says the bootstrap is not complete", async () => {
    const result = await deploy(["--bootstrap"], { terminal: false, answers: ["https://not a subdomain"] });

    expect(result.code).toBe(2);
    expect(result.output).toContain("deploy: no workers.dev subdomain recorded");
  });

  it("removes its Worker's directory when the upload fails", async () => {
    await saveState({ behavior: { deploy: "fail" } });

    const result = await deploy(["--bootstrap"], { terminal: false });

    expect(result.code).toBe(1);
    expect(result.output).toContain("deploy: wrangler deploy failed (exit 1)");
    expect(await leftInTmp()).toEqual([]);
  });
});

// v0.1.1 published as each release is: both versions bumped, committed with the files the test wrote at paths, pushed
// to main, tagged, and its Check passed.
async function publishRelease(...paths: string[]): Promise<void> {
  for (const path of ["packages/server", "packages/cli"]) {
    await writeFile(join(seed.path, path, "package.json"), `${JSON.stringify({ version: "0.1.1" })}\n`);
  }
  await seed.add(...paths, "packages");
  await seed.commit("chore(release): v0.1.1");
  const release = await seed.headCommit();
  await seed.push(origin, "HEAD:refs/heads/main");
  await seed.tagAnnotated("v0.1.1", release, "prq v0.1.1");
  await seed.push(origin, "refs/tags/v0.1.1");
  env["FAKE_GH_ANSWER"] = checkRuns(release);
}

// The repository's wrangler configuration naming another account, which wrangler would use in place of target.env's.
async function otherAccount(): Promise<void> {
  const other = join(root, "other-account.jsonc");
  await writeFile(other, `${JSON.stringify({ name: "prq", account_id: OTHER_ACCOUNT })}\n`);
  settings.wranglerConfig = other;
}

describe("an environment marked as CI", () => {
  it.each([
    ["the bootstrap", ["--bootstrap"], { CI: "true" }, "CI"],
    ["its resume", ["--bootstrap", "--resume"], { BUILD_NUMBER: "17" }, "BUILD_NUMBER"],
    ["a release", [TAG], { GITHUB_ACTIONS: "true" }, "GITHUB_ACTIONS"],
  ])("refuses %s before any call", async (_what, args, marks, named) => {
    await bootstrapped();
    Object.assign(env, marks);

    const result = await deploy(args, { answers: ["y", "none"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `deploy: the environment marks this run as CI (${named}), where wrangler answers its own questions: deploy from a terminal of your own`,
    );
    expect(await wranglerCalls()).toEqual([]);
    expect(await toolCalls()).toEqual([]);
  });
});

describe("the account", () => {
  const REFUSAL =
    "deploy: the wrangler configuration's account_id names another account than target.env's, and wrangler would use it";

  it.each([
    ["the bootstrap", ["--bootstrap"], false],
    ["a release", [TAG], true],
  ])(
    "is refused for %s when wrangler's configuration names another, before any call",
    async (_what, args, terminal) => {
      await bootstrapped();
      await otherAccount();

      const result = await deploy(args, { terminal, answers: ["y"] });

      expect(result.code).toBe(1);
      expect(result.output).toContain(REFUSAL);
      expect(await wranglerCalls()).toEqual([]);
      expect(await toolCalls()).toEqual([]);
    },
  );

  it("is refused for a read-back when wrangler's configuration names another, before any call", async () => {
    await bootstrapped();
    expect((await deploy([TAG], { answers: ["y", "n"] })).code).toBe(2);
    const { dir } = await onlyRecord();
    const calls = (await wranglerCalls()).length;
    await otherAccount();

    const result = await deploy(["--read-back", dir], { terminal: false });

    expect(result.code).toBe(1);
    expect(result.output).toContain(REFUSAL);
    expect(await wranglerCalls()).toHaveLength(calls);
  });
});

describe("the production entry", () => {
  // deploy.ts as `pnpm run deploy` runs it, with no fixture. Were an override taken, each run would still stop before
  // any call: HOME holds no deploy directory, the release runs out of a terminal, and the record is no path.
  const MODES = [[TAG], ["--bootstrap"], ["--read-back", "no-record"]];

  it.each([
    // Round 2's scene and its stand-in for wrangler with a local API, and round 3's ledger origin.
    [
      "the tests' own settings",
      { PRQ_DEPLOY_WRANGLER: "/sentinel/wrangler", PRQ_DEPLOY_API: "http://127.0.0.1:9/client/v4" },
    ],
    ["the idle check's origin", { PRQ_DEPLOY_ORIGIN: "http://127.0.0.1:9" }],
    // Round 3's Worker name, and the configuration's environment.
    ["the Worker's name", { WRANGLER_CI_OVERRIDE_NAME: "sentinel-other-worker", WRANGLER_CI_MATCH_TAG: "sentinel" }],
    ["the configuration's environment", { CLOUDFLARE_ENV: "sentinel-env" }],
    ["the account", { CLOUDFLARE_ACCOUNT_ID: OTHER_ACCOUNT, CF_ACCOUNT_ID: OTHER_ACCOUNT }],
    [
      "other credentials",
      {
        CLOUDFLARE_API_TOKEN: "sentinel-other-token",
        CLOUDFLARE_API_KEY: "sentinel-other-key",
        CLOUDFLARE_AUTH_PROFILE: "sentinel",
      },
    ],
    [
      "the API",
      {
        CLOUDFLARE_API_BASE_URL: "https://api.sentinel.example/client/v4",
        CF_API_BASE_URL: "https://api.sentinel.example/client/v4",
        CLOUDFLARE_COMPLIANCE_REGION: "fedramp_high",
        CLOUDFLARE_API_HEADERS: "x-sentinel: 1",
        CLOUDFLARE_CONTAINER_REGISTRY: "registry.sentinel.example",
      },
    ],
    // Round 3's OAuth endpoint and auth domain.
    [
      "the OAuth login",
      {
        WRANGLER_TOKEN_URL: "https://login.sentinel.example/oauth2/token",
        WRANGLER_AUTH_URL: "https://login.sentinel.example/oauth2/auth",
        WRANGLER_AUTH_DOMAIN: "login.sentinel.example",
        WRANGLER_API_ENVIRONMENT: "staging",
      },
    ],
  ] as const)("refuses a terminal that sets %s, in every mode, before any call", async (_what, set) => {
    await released();
    Object.assign(env, set);
    const names = Object.keys(set).toSorted();

    for (const args of MODES) {
      const result = await deploy(args, { terminal: false, production: true });

      expect(result).toMatchObject({
        code: 1,
        output: `deploy: the environment sets ${names.join(", ")}, which would send this command elsewhere than target.env's account and the Worker prq, or with other credentials than wrangler's login: unset ${names.length === 1 ? "it" : "them"} (docs/operations.md, The deploy command)\n`,
      });
      for (const value of Object.values(set)) {
        expect(result.output).not.toContain(value);
      }
    }
    expect(await wranglerCalls()).toEqual([]);
    expect(await toolCalls()).toEqual([]);
    expect(apiRequests).toEqual([]);
    expect(ledgerRequests).toEqual([]);
  });
});

describe("deploy <tag>", () => {
  it("refuses without a terminal, before it clones or calls anything", async () => {
    await bootstrapped();

    const result = await deploy([TAG], { terminal: false });

    expect(result.code).toBe(1);
    expect(result.output).toBe(
      "deploy: the deploy runs in a terminal: wrangler asks there before it replaces a DNS record or another Worker's domain\n",
    );
    expect(await wranglerCalls()).toEqual([]);
    expect(await toolCalls()).toEqual([]);
  });

  it("deploys a clean clone of the tag with its pinned tools, to exactly the hostname, once the owner confirms", async () => {
    // The first release after secrets put made a version of the bootstrap's Worker: untagged, with no binding but
    // secrets. The idle check is skipped, however busy the ledger.
    const secrets = "0000000a-0000-4000-8000-000000000000";
    await saveState({ deployment: [secrets], versions: { [LIVE]: "prq-bootstrap", [secrets]: null } });
    ledger = [{ rows: [ledgerRow(3, "cloud", 1, 0)], nextCursor: null }];
    // The host's checkout hooks (core.hooksPath and a template's), and the browser check's build overrides.
    const hook = `#!/bin/sh\necho ran >> ${join(root, "hook-ran")}\n`;
    await mkdir(join(root, "host-hooks"));
    await mkdir(join(root, "host-template", "hooks"), { recursive: true });
    await writeFile(join(root, "host-hooks", "post-checkout"), hook, { mode: 0o700 });
    await writeFile(join(root, "host-template", "hooks", "post-checkout"), hook, { mode: 0o700 });
    Object.assign(env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: join(root, "host-hooks"),
      GIT_TEMPLATE_DIR: join(root, "host-template"),
      PRQ_BUILD_VERSION: "v9.9.9",
      PRQ_BUILD_PREFIX: "old-",
    });

    const result = await deploy([TAG], { answers: ["y", "y"] });

    expect(result.code).toBe(0);
    const clone = /clone: (\S+) \(kept\)/.exec(result.output)?.[1] ?? "";
    expect(clone.startsWith(join(root, "tmp", `prq-deploy-${TAG}-`))).toBe(true);
    // The install and the build by the pinned pnpm mise names, run directly; the upload by the clone's wrangler (the
    // stand-in here), from its server package, not through mise either.
    const tools = (await toolCalls()).map(({ tool, path, args, cwd }) => ({ tool, path, args, cwd }));
    const pnpm = join(bin, "pinned", "pnpm");
    expect(tools).toEqual([
      {
        tool: "gh",
        path: undefined,
        args: ["api", `repos/${REPOSITORY}/commits/${commit}/check-runs?check_name=Check`],
        cwd: clone,
      },
      { tool: "mise", path: undefined, args: ["trust"], cwd: clone },
      { tool: "mise", path: undefined, args: ["install"], cwd: clone },
      { tool: "mise", path: undefined, args: ["which", "node"], cwd: clone },
      { tool: "mise", path: undefined, args: ["which", "pnpm"], cwd: clone },
      { tool: "pnpm", path: pnpm, args: ["install", "--frozen-lockfile"], cwd: clone },
      { tool: "pnpm", path: pnpm, args: ["--dir", "packages/server", "run", "build"], cwd: clone },
    ]);
    expect(await readFile(join(root, "hook-ran"), "utf8").catch(() => null)).toBeNull();
    expect((await toolCalls()).find((each) => each.args.includes("build") && each.tool === "pnpm")?.env).toEqual({
      PRQ_BUILD_VERSION: null,
      PRQ_BUILD_PREFIX: null,
    });
    const [call] = await deployCalls();
    const { dir, data } = await onlyRecord();
    expect(call?.args).toEqual([
      "deploy",
      `--config=${join(clone, "packages", "server", "wrangler.jsonc")}`,
      "--env",
      "",
      "--env-file",
      "/dev/null",
      `--domain=${HOST}`,
      `--tag=${TAG}`,
      `--message=prq ${TAG} ${commit}`,
    ]);
    expect(call?.cwd).toBe(join(clone, "packages", "server"));
    // Every read on the account: the repository's configuration at its top level.
    for (const read of (await wranglerCalls()).filter((each) => each.call !== "deploy")) {
      expect(read.args.slice(-6)).toEqual(["--config", CONFIG, "--env", "", "--env-file", "/dev/null"]);
    }
    expect(call?.env).toMatchObject({
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      WRANGLER_LOG_SANITIZE: "true",
      WRANGLER_OUTPUT_FILE_PATH: join(dir, "wrangler-output.jsonl"),
    });
    expect(result.output.indexOf(`Deploy ${TAG} to ${HOST}? [y/N]`)).toBeLessThan(
      result.output.indexOf("Uploaded prq"),
    );
    expect(data).toMatchObject({
      tag: TAG,
      sha: commit,
      outcome: "deployed",
      idle: "skipped: the live Worker is the bootstrap's (no binding but secrets), which serves nothing at the hostname",
      application: "created",
      upload: { exit: 0, versionId: "00000010-0000-4000-8000-000000000000" },
      readBack: { state: "complete", provisioning: "observed" },
    });
    expect(ledgerRequests).toEqual([]);
    expect(await leftInTmp()).toEqual([]);
    // wrangler's credentials went to Cloudflare's API alone, in a header of each read: in no argument, no other
    // process's environment and no file.
    expect(apiRequests.map(({ method, url }) => `${method} ${url}`)).toEqual(
      expect.arrayContaining([
        `GET /client/v4/accounts/${ACCOUNT}/workers/workers/prq`,
        `GET /client/v4/accounts/${ACCOUNT}/containers/applications`,
      ]),
    );
    for (const request of apiRequests) {
      expect(request).toMatchObject({ method: "GET", headers: { authorization: `Bearer ${API_TOKEN}` } });
    }
    const calls = [...(await wranglerCalls()), ...(await toolCalls())];
    expect(calls.filter((each) => each.credentialInEnv || each.args.some((arg) => arg.includes(API_TOKEN)))).toEqual(
      [],
    );
    expect(await filesHolding(root, API_TOKEN)).toEqual([]);
  });

  it.each([
    ["workers.dev", { enabled: true, previews_enabled: false }, "oauth", "workers.dev on, preview URLs off"],
    ["preview URLs", { enabled: false, previews_enabled: true }, "api_key", "workers.dev off, preview URLs on"],
  ] as const)("refuses to upload while the live Worker has %s on", async (_what, subdomain, auth, line) => {
    await bootstrapped({ subdomain, auth });

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `deploy: the Worker prq has ${line}: finish the bootstrap (--bootstrap --resume, docs/operations.md, First deploy), or turn them off in the dashboard (Workers & Pages → prq → Settings → Domains & Routes)`,
    );
    expect(await deployCalls()).toEqual([]);
    expect((await onlyRecord()).data.outcome).toBe("refused: workers.dev or preview URLs not off");
    expect(apiRequests[0]?.headers).toMatchObject(
      auth === "api_key"
        ? { "x-auth-key": API_KEY.key, "x-auth-email": API_KEY.email }
        : { authorization: `Bearer ${API_TOKEN}` },
    );
  });

  it.each([
    [
      "Cloudflare's API fails",
      { "api workers": "fail" },
      "the Worker's workers.dev and preview URLs: Cloudflare's API answered HTTP 500 for the Worker's settings",
    ],
    [
      "wrangler has no login",
      { "auth token": "fail" },
      "the Worker's workers.dev and preview URLs: wrangler auth token failed (exit 1): log wrangler in (docs/operations.md, Cloudflare account)",
    ],
  ])("refuses to upload when the Worker's addresses cannot be read: %s", async (_what, behavior, line) => {
    await bootstrapped({ behavior });

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(`deploy: ${line}\n`);
    expect(await deployCalls()).toEqual([]);
    expect((await onlyRecord()).data.outcome).toBe("refused: the state before could not be read");
  });

  it("reads what is live after the upload with wrangler's login asked again, as wrangler refreshed it", async () => {
    // The token read before the upload has expired by its end: the API takes the refreshed one alone.
    await released({ afterDeploy: { "auth token": "refreshed" } });

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(0);
    expect(apiRequests.map(({ url, headers }) => `${url} ${headers.authorization}`)).toEqual([
      `/client/v4/accounts/${ACCOUNT}/workers/workers/prq Bearer ${API_TOKEN}`,
      `/client/v4/accounts/${ACCOUNT}/containers/applications Bearer ${API_TOKEN}`,
      `/client/v4/accounts/${ACCOUNT}/workers/workers/prq Bearer ${API_TOKEN_REFRESHED}`,
    ]);
    expect((await onlyRecord()).data.readBack).toMatchObject({ state: "complete" });
  });

  it("gives wrangler an environment built for it, whatever else the terminal holds", async () => {
    await released();
    // Kept: the locale, Docker's settings, where wrangler keeps its login. Left out: everything else, a variable that
    // would redirect wrangler and that the refused list misses among it.
    const kept = {
      LANG: "en_US.UTF-8",
      DOCKER_HOST: "unix:///sentinel/docker.sock",
      XDG_CACHE_HOME: join(root, "cache"),
    };
    const left = {
      NODE_OPTIONS: "--max-old-space-size=2048",
      HTTPS_PROXY: "http://127.0.0.1:9",
      WRANGLER_SEND_METRICS: "true",
      WRANGLER_SENTINEL_FUTURE_OVERRIDE: "https://elsewhere.sentinel.example",
    };
    Object.assign(env, kept, left);

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(0);
    const calls = await wranglerCalls();
    expect(calls.map((call) => call.call)).toContain("deploy");
    for (const call of calls) {
      expect(call.names).toEqual(expect.arrayContaining(Object.keys(kept)));
      expect(call.names.filter((name) => name in left || name.startsWith("PRQ_"))).toEqual([]);
    }
  });

  it("runs the install, the build and the upload with the clone's pinned tools, out of mise's configuration", async () => {
    await released();
    // mise's [env], as a global or a project's configuration would set it over the environment mise is given: each
    // step would gain a variable (a build input, another Worker's name) and have one replaced (the locale the terminal
    // gives, the account the deploy gives wrangler).
    env["LANG"] = "en_US.UTF-8";
    env["FAKE_MISE_ENV"] = JSON.stringify({
      PRQ_BUILD_VERSION: "v9.9.9",
      WRANGLER_CI_OVERRIDE_NAME: "sentinel-other-worker",
      LANG: "sentinel-mise-locale",
      CLOUDFLARE_ACCOUNT_ID: OTHER_ACCOUNT,
    });

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(0);
    const steps = (await toolCalls()).filter((call) => call.tool === "pnpm");
    expect(steps.map((call) => call.args[0])).toEqual(["install", "--dir"]);
    const [upload] = await deployCalls();
    for (const call of [...steps, upload]) {
      expect(call?.fromMise).toEqual([]);
    }
    expect(upload?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  });

  it.each([
    ["fails", { pnpm: null }, "mise which pnpm failed (exit 1)"],
    [
      "names no installed file",
      { node: "node" },
      "mise which node named no file by its absolute path: the clone's node is not installed",
    ],
  ])("refuses the release, before the install, when mise %s for a pinned tool", async (_what, which, line) => {
    await released();
    env["FAKE_MISE_WHICH"] = JSON.stringify(which);

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(`deploy: ${line}\n`);
    expect((await toolCalls()).filter((call) => call.tool === "pnpm")).toEqual([]);
    expect(await deployCalls()).toEqual([]);
  });

  it("stops mise which at the end of its bound, and refuses the release", async () => {
    await released();
    env["FAKE_MISE_WHICH"] = JSON.stringify({ node: "hang" });
    settings.stepMs = 8000;

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain("deploy: mise which node did not finish within 8 s and was stopped\n");
    const which = (await toolCalls()).find((call) => call.args[0] === "which");
    expect(await ended(which?.pid ?? 0)).toBe(true);
    expect(await deployCalls()).toEqual([]);
  });

  it("deploys nothing when the owner does not confirm", async () => {
    await bootstrapped();

    const result = await deploy([TAG], { answers: ["n"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain("deploy: nothing deployed");
    expect(await deployCalls()).toEqual([]);
    expect((await onlyRecord()).data.outcome).toBe("declined");
  });

  it("deploys nothing when the release check refuses the tag", async () => {
    await bootstrapped();
    env["FAKE_GH_ANSWER"] = JSON.stringify({ total_count: 0, check_runs: [] });

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `release-check: GitHub reports no successful Check run of GitHub Actions for ${commit}`,
    );
    expect(result.output).toContain("deploy: the release check failed (exit 1)");
    expect(await deployCalls()).toEqual([]);
    expect((await toolCalls()).filter((call) => call.tool !== "gh")).toEqual([]);
  });

  it("refuses a tag whose files hold a deployment value, naming the variable and the path alone", async () => {
    await bootstrapped();
    await writeFile(join(seed.path, "notes.md"), `served at ${HOST.toUpperCase()}\naudience ${AUD}\n`);
    await publishRelease("notes.md");

    const result = await deploy(["v0.1.1"], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain("deploy: PRQ_HOST is in notes.md\n");
    expect(result.output).toContain("deploy: ACCESS_AUD is in notes.md\n");
    expect(result.output).not.toContain(HOST.toUpperCase());
    expect(await deployCalls()).toEqual([]);
    expect(await leftInTmp()).toEqual([]);
  });

  it.each([
    [
      "would put it on workers.dev or a preview URL",
      { name: "prq", preview_urls: false },
      "deploy: the tag's packages/server/wrangler.jsonc does not name the Worker prq with workers_dev and preview_urls false",
    ],
    [
      "configures a route besides the hostname",
      {
        name: "prq",
        workers_dev: false,
        preview_urls: false,
        routes: [{ pattern: "extra.sentinel-zone.example", custom_domain: true }],
      },
      "deploy: the tag's packages/server/wrangler.jsonc configures a route, which wrangler would publish beside the hostname: the deploy takes the hostname from target.env alone",
    ],
    [
      "configures a route of a zone",
      { name: "prq", workers_dev: false, preview_urls: false, route: "sentinel-zone.example/*" },
      "deploy: the tag's packages/server/wrangler.jsonc configures a route, which wrangler would publish beside the hostname",
    ],
    [
      "names an account",
      { name: "prq", workers_dev: false, preview_urls: false, account_id: OTHER_ACCOUNT },
      "deploy: the tag's packages/server/wrangler.jsonc sets an account_id, which wrangler would deploy to in place of target.env's",
    ],
  ])("refuses a tag whose Worker configuration %s", async (_what, config, refusal) => {
    await bootstrapped();
    await writeFile(join(seed.path, "packages/server/wrangler.jsonc"), `${JSON.stringify(config)}\n`);
    await publishRelease();

    const result = await deploy(["v0.1.1"], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(refusal);
    expect(await deployCalls()).toEqual([]);
  });

  it.each([
    ["the install", "install", "before the build"],
    ["the build", "build", "before the upload"],
  ])("refuses a clone whose tracked files %s changed, %s", async (_what, change, when) => {
    await bootstrapped();
    env["FAKE_PNPM_CHANGE"] = change;

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `deploy: the clone's tracked files are no longer ${commit}'s ${when}: something in the clone changed them`,
    );
    expect(await deployCalls()).toEqual([]);
    const builds = (await toolCalls()).filter((each) => each.tool === "pnpm" && each.args.includes("build"));
    expect(builds).toHaveLength(change === "install" ? 0 : 1);
  });

  it("refuses while cloud work waits or runs, reading every ledger page with the service token", async () => {
    await released();
    ledger = [
      { rows: [ledgerRow(1, "local", 1, 1), ledgerRow(2, "cloud", 0, 0)], nextCursor: "1" },
      { rows: [ledgerRow(3, "cloud", 0, 1), ledgerRow(4, "cloud", 2, 0)], nextCursor: null },
    ];

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "deploy: cloud work is waiting or running: prq-test/app#3 (waiting 0, running 1), prq-test/app#4 (waiting 2, running 0)",
    );
    expect(ledgerRequests.map((request) => request.url)).toEqual([
      "/api/ledger?state=all",
      "/api/ledger?state=all&cursor=1",
    ]);
    expect(ledgerRequests[0]?.headers).toMatchObject({
      "cf-access-client-id": TOKEN.id,
      "cf-access-client-secret": TOKEN.secret,
    });
    expect(await deployCalls()).toEqual([]);
    expect((await onlyRecord()).data.outcome).toMatch(/^refused: cloud work is waiting or running/);
  });

  it.each([
    ["no resources", "no resources"],
    ["its bindings as null", "null bindings"],
  ] as const)(
    "reads the ledger, and refuses while cloud work runs, when the live version's view lists %s",
    async (_what, inventory) => {
      await released({ inventory });
      ledger = [{ rows: [ledgerRow(3, "cloud", 0, 1)], nextCursor: null }];

      const result = await deploy([TAG], { answers: ["y"] });

      expect(result.code).toBe(1);
      expect(result.output).toContain(
        "deploy: cloud work is waiting or running: prq-test/app#3 (waiting 0, running 1)",
      );
      expect(ledgerRequests.map((request) => request.url)).toEqual(["/api/ledger?state=all"]);
      expect(await deployCalls()).toEqual([]);
    },
  );

  it("refuses without the service token to read the ledger with", async () => {
    await released();
    delete env["PRQ_ACCESS_CLIENT_ID"];

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "deploy: the idle check reads the ledger with the service token: set PRQ_ACCESS_CLIENT_ID and PRQ_ACCESS_CLIENT_SECRET as for prq, or run setup cloudflare, which writes them to access.env",
    );
    expect(ledgerRequests).toEqual([]);
    expect(await deployCalls()).toEqual([]);
  });

  it("reads the service token from access.env when the environment lacks it", async () => {
    await released();
    delete env["PRQ_ACCESS_CLIENT_ID"];
    delete env["PRQ_ACCESS_CLIENT_SECRET"];
    await writeFile(
      join(settings.directory ?? "", "access.env"),
      `PRQ_URL=https://${HOST}\nPRQ_ACCESS_CLIENT_ID=${TOKEN.id}\nPRQ_ACCESS_CLIENT_SECRET=${TOKEN.secret}\n`,
      { mode: 0o600 },
    );
    ledger = [{ rows: [ledgerRow(3, "cloud", 1, 0)], nextCursor: null }];

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain("deploy: cloud work is waiting or running: prq-test/app#3");
    expect(ledgerRequests[0]?.headers).toMatchObject({
      "cf-access-client-id": TOKEN.id,
      "cf-access-client-secret": TOKEN.secret,
    });
  });

  it("deploys with a warning past busy cloud work under --ignore-running", async () => {
    await released();
    ledger = [{ rows: [ledgerRow(3, "cloud", 1, 0)], nextCursor: null }];

    const result = await deploy([TAG, "--ignore-running"], { answers: ["y"] });

    expect(result.code).toBe(0);
    expect(result.output).toContain("deploy: warning (--ignore-running): cloud work is waiting or running");
    expect(await deployCalls()).toHaveLength(1);
    expect((await onlyRecord()).data.idle).toMatch(/^ignored: cloud work is waiting or running/);
  });

  it("reads a changed application's rollout until it is complete, and passes --immediate on", async () => {
    await released({ imageChanges: true, rolloutAfterDeploy: 2 });
    // A temp directory whose path holds a space, as the clone's then does.
    env["TMPDIR"] = join(root, "tmp with space");
    await mkdir(env["TMPDIR"]);

    const result = await deploy([TAG, "--immediate"], { answers: ["y"] });

    expect(result.code).toBe(0);
    expect((await deployCalls())[0]?.args).toContain("--durable-objects-code-update-mode=immediate");
    const { data } = await onlyRecord();
    expect(data).toMatchObject({ application: "changed", readBack: { state: "complete" } });
    expect(data.readBack?.rounds).toHaveLength(2);
    expect(result.output).toContain("read-back complete: the application's rollout of version 4 is complete");
    const cli = join(data.clone, "packages", "cli");
    expect(cli).toContain("tmp with space");
    const team = "https://synthetic.cloudflareaccess.com";
    expect(printedChecks(result.output, { ACCESS_TEAM_DOMAIN: team, WORKERS_SUBDOMAIN: "synthetic-sub" })).toEqual([
      { dir: cli, invocation: { mode: "edge", teamDomain: team, pr: undefined, json: undefined } },
      { dir: cli, invocation: { mode: "endpoints", subdomain: "synthetic-sub", version: undefined, json: undefined } },
    ]);
    // Every page of the instances, the inactive Durable Object apart.
    expect(result.output).toContain("instances: 1 active (0 at another version or none, 0 not settled), 1 inactive");
  });

  it("follows a rollout still under way when the application is unchanged, until it is complete", async () => {
    await released({ rolloutReads: 10, imageChanges: false });

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(0);
    const { data } = await onlyRecord();
    expect(data).toMatchObject({
      application: "unchanged",
      readBack: { state: "complete", reason: "the application's rollout of version 3 is complete" },
    });
    // The reads before and after the upload found it active, and so did each round's but the last.
    expect(data.readBack?.rounds).toHaveLength(9);
  });

  it.each([
    [
      "an instance at an older version on a later page",
      [
        [
          { state: "running", version: 4 },
          { state: "inactive", version: null },
        ],
        [{ state: "running", version: 3 }],
      ],
      "2 active (1 at another version or none, 0 not settled), 1 inactive",
    ],
    [
      "a running instance with no version",
      [[{ state: "running", version: null }]],
      "1 active (1 at another version or none, 0 not settled), 0 inactive",
    ],
  ])("leaves a rollout incomplete at the end of its time with %s", async (_what, instancePages, line) => {
    await released({ imageChanges: true, rolloutAfterDeploy: 0, instancePages });
    settings.rolloutMs = 5000;

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(2);
    expect(result.output).toContain(`instances: ${line}`);
    expect((await onlyRecord()).data.readBack).toMatchObject({
      state: "incomplete",
      reason: "the rollout was not complete within 5 s",
    });
  });

  it.each([
    [
      "cannot be read",
      { afterDeploy: { "api workers": "fail" } },
      "what is live could not be read: the Worker's workers.dev and preview URLs: Cloudflare's API answered HTTP 500 for the Worker's settings",
    ],
    [
      "are not off",
      { subdomainAfterDeploy: { enabled: true, previews_enabled: false } },
      "the Worker has workers.dev on, preview URLs off after the deploy",
    ],
  ])(
    "leaves the read-back incomplete when the Worker's addresses %s after the upload",
    async (_what, state, reason) => {
      await released(state);

      const result = await deploy([TAG], { answers: ["y"] });

      expect(result.code).toBe(2);
      expect((await onlyRecord()).data.readBack).toMatchObject({ state: "incomplete", reason });
    },
  );

  it("leaves the read-back incomplete while the deployed version is not live alone", async () => {
    await released({ behavior: { deploy: "split" } });

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(2);
    const version = "00000010-0000-4000-8000-000000000000";
    expect((await onlyRecord()).data.readBack).toMatchObject({
      state: "incomplete",
      reason: `the live versions are ${LIVE} (v0.0.9, 50 %), ${version} (${TAG}, 50 %), not ${version} alone`,
    });
  });

  it("completes at once for an unchanged application, found among every application the account has", async () => {
    // More applications before it than wrangler's containers list prints.
    const others = Array.from({ length: 30 }, (_, index) => ({
      id: `0e000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `other-${index}`,
      version: 1,
      image: "registry.example/other:1",
    }));
    await released({ applications: [...others, { ...APP }] });

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(0);
    expect((await onlyRecord()).data).toMatchObject({ application: "unchanged", readBack: { state: "complete" } });
  });

  it("keeps the image under --keep-image, and refuses it before the application exists", async () => {
    await bootstrapped();
    const refused = await deploy([TAG, "--keep-image"], { answers: ["y"] });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain(
      "deploy: --keep-image keeps the container application's image, and prq-workspace does not exist yet",
    );
    expect(await deployCalls()).toEqual([]);

    await released({ imageChanges: true });
    const kept = await deploy([TAG, "--keep-image"], { answers: ["y"] });
    expect(kept.code).toBe(0);
    expect((await deployCalls())[0]?.args).toContain("--containers-rollout=none");
    expect((await record((await recordDirs())[1] ?? "")).application).toBe("kept");
  });

  it("records what is live when the upload fails after the version went live, and exits as wrangler did", async () => {
    await released({ behavior: { deploy: "fail-after-upload" } });

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(1);
    const { dir, data } = await onlyRecord();
    expect(data).toMatchObject({
      outcome: "the upload failed (exit 1)",
      upload: { exit: 1, versionId: null },
      after: { deployment: { versions: [{ versionId: "00000010-0000-4000-8000-000000000000" }] } },
      readBack: null,
    });
    expect(result.output).toContain(`deploy: record: ${dir} (docs/operations.md, Recovery)`);

    const again = await deploy(["--read-back", dir], { terminal: false });
    expect(again.code).toBe(2);
    expect(again.output).toContain(
      `deploy: verification incomplete: the upload did not finish (the upload failed (exit 1)): deploy ${TAG} again`,
    );
  });

  it("records a new application's provisioning as unverified unless the owner saw it, and --read-back resumes it", async () => {
    await bootstrapped();

    const result = await deploy([TAG], { answers: ["y", "n"] });

    expect(result.code).toBe(2);
    const { dir, data } = await onlyRecord();
    expect(data).toMatchObject({
      idle: "skipped: the live Worker is the bootstrap's (no binding but secrets), which serves nothing at the hostname",
      application: "created",
      readBack: { state: "incomplete", provisioning: "unverified" },
    });
    expect(ledgerRequests).toEqual([]);
    expect(result.output).toContain(
      `deploy: resume it with pnpm --dir packages/server run deploy -- --read-back ${dir}`,
    );

    const again = await deploy(["--read-back", dir], { terminal: false, answers: ["y"] });
    expect(again.code).toBe(0);
    expect((await record(dir)).readBack).toMatchObject({ state: "complete", provisioning: "observed" });
  });

  it("exits 2 with the read-back incomplete when the owner stops the rollout's poll, and --read-back finishes it", async () => {
    await released({ imageChanges: true, rolloutAfterDeploy: 1_000_000 });
    const { result } = start([TAG], { answers: ["y"] });

    const deployPid = await until(async () => {
      const reads = (await wranglerCalls()).filter((call) => call.call === "containers info");
      return reads.length >= 3 ? reads.at(-1)?.ppid : undefined;
    });
    process.kill(deployPid, "SIGINT");

    const stopped = await result;
    expect(stopped.code).toBe(2);
    const { dir, data } = await onlyRecord();
    expect(data.readBack).toMatchObject({ state: "incomplete", reason: "the owner stopped the rollout's read-back" });

    await changeState({ rolloutReads: 1 });
    const again = await deploy(["--read-back", dir], { terminal: false });
    expect(again.code).toBe(0);
    expect((await record(dir)).readBack).toMatchObject({ state: "complete" });
  });

  it("reads an unchanged application's instances on --read-back once a rollout it found has cleared", async () => {
    // A retry whose image was the same, while the earlier deploy's rollout is under way; the owner stops its poll.
    await released({ rolloutReads: 1_000_000 });
    const { result } = start([TAG], { answers: ["y"] });
    const deployPid = await until(async () => {
      const reads = (await wranglerCalls()).filter((call) => call.call === "containers info");
      return reads.length >= 3 ? reads.at(-1)?.ppid : undefined;
    });
    process.kill(deployPid, "SIGINT");
    expect((await result).code).toBe(2);
    const { dir, data } = await onlyRecord();
    expect(data).toMatchObject({ application: "unchanged", readBack: { state: "incomplete" } });

    // The rollout has cleared, and an active instance still reports the application's earlier version.
    await changeState({ rolloutReads: 0, instancePages: [[{ state: "running", version: APP.version - 1 }]] });
    settings.rolloutMs = 3000;
    const behind = await deploy(["--read-back", dir], { terminal: false });
    expect(behind.code).toBe(2);
    expect(behind.output).toContain("instances: 1 active (1 at another version or none, 0 not settled), 0 inactive");
    expect((await record(dir)).readBack).toMatchObject({
      state: "incomplete",
      reason: "the rollout was not complete within 3 s",
    });

    // The application has moved to another version since the upload, its instances with it.
    await changeState({ applications: [{ ...APP, version: APP.version + 1 }], instancePages: null });
    const moved = await deploy(["--read-back", dir], { terminal: false });
    expect(moved.code).toBe(2);
    expect((await record(dir)).readBack).toMatchObject({
      state: "incomplete",
      reason: `the application's version is ${APP.version + 1}, not ${APP.version}`,
    });

    await changeState({ applications: [{ ...APP }] });
    const done = await deploy(["--read-back", dir], { terminal: false });
    expect(done.code).toBe(0);
    expect((await record(dir)).readBack).toMatchObject({
      state: "complete",
      reason: `the application's rollout of version ${APP.version} is complete`,
    });
  });

  it("follows a rollout found before the upload of an unchanged application that the read after it finds cleared", async () => {
    // A retry whose image was the same: the earlier rollout is under way when the deploy first reads the application,
    // cleared by its read after the upload, with an active instance still at the earlier version.
    await released({ rolloutReads: 1, instancePages: [[{ state: "running", version: APP.version - 1 }]] });
    settings.rolloutMs = 3000;

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(2);
    const { dir, data } = await onlyRecord();
    expect(data).toMatchObject({
      application: "unchanged",
      rollout: { id: APP.id, image: APP.image, version: APP.version },
      readBack: { state: "incomplete", reason: "the rollout was not complete within 3 s" },
    });

    await changeState({ instancePages: null });
    expect((await deploy(["--read-back", dir], { terminal: false })).code).toBe(0);
  });

  it("keeps the rollout a --read-back found for the next one, when its instances could not be read", async () => {
    // The deploy ends while it reads what is live after the upload, with no rollout under way yet.
    await released({ afterDeploy: { "deployments status": "hang" } });
    const { result } = start([TAG], { answers: ["y"] });
    await hangingPids();
    const read = (await wranglerCalls()).findLast((call) => call.call === "deployments status");
    process.kill(read?.ppid ?? 0, "SIGTERM");
    await result;
    const { dir } = await onlyRecord();

    // The first --read-back finds a rollout under way, then cannot read the instances.
    await changeState({ behavior: { "containers instances": "fail" }, rolloutReads: 1 });
    const first = await deploy(["--read-back", dir], { terminal: false });
    expect(first.code).toBe(2);
    expect(await record(dir)).toMatchObject({
      application: "unchanged",
      rollout: { id: APP.id, image: APP.image, version: APP.version },
      readBack: {
        state: "incomplete",
        reason: "the rollout could not be read: wrangler containers instances failed (exit 1)",
      },
    });

    // The second finds it cleared, with an active instance still at the earlier version.
    await changeState({ behavior: {}, instancePages: [[{ state: "running", version: APP.version - 1 }]] });
    settings.rolloutMs = 3000;
    const second = await deploy(["--read-back", dir], { terminal: false });
    expect(second.code).toBe(2);
    expect((await record(dir)).readBack).toMatchObject({
      state: "incomplete",
      reason: "the rollout was not complete within 3 s",
    });
  });

  it("keeps the rollout a --read-back found while it could not read the Worker's settings, for the next one", async () => {
    // The deploy ends while it reads what is live after the upload, with no rollout under way yet.
    await released({ afterDeploy: { "deployments status": "hang" } });
    const { result } = start([TAG], { answers: ["y"] });
    await hangingPids();
    const read = (await wranglerCalls()).findLast((call) => call.call === "deployments status");
    process.kill(read?.ppid ?? 0, "SIGTERM");
    await result;
    const { dir } = await onlyRecord();

    // The first --read-back cannot read the Worker's settings, and finds a rollout under way.
    await changeState({ behavior: { "api workers": "fail" }, rolloutReads: 1 });
    const first = await deploy(["--read-back", dir], { terminal: false });
    expect(first.code).toBe(2);
    expect(await record(dir)).toMatchObject({
      application: "unchanged",
      rollout: { id: APP.id, image: APP.image, version: APP.version },
      readBack: {
        state: "incomplete",
        reason:
          "what is live could not be read: the Worker's workers.dev and preview URLs: Cloudflare's API answered HTTP 500 for the Worker's settings",
      },
    });

    // The second reads them, and finds the rollout cleared with an active instance still at the earlier version.
    await changeState({ behavior: {}, instancePages: [[{ state: "running", version: APP.version - 1 }]] });
    settings.rolloutMs = 3000;
    const second = await deploy(["--read-back", dir], { terminal: false });
    expect(second.code).toBe(2);
    expect((await record(dir)).readBack).toMatchObject({
      state: "incomplete",
      reason: "the rollout was not complete within 3 s",
    });
  });

  it("stops the upload with all it started at the end of its bound, and records it", async () => {
    await released({ behavior: { deploy: "hang" } });
    settings.stepMs = 8000;

    const result = await deploy([TAG], { answers: ["y"] });

    expect(result.code).toBe(1);
    for (const pid of await hangingPids()) {
      expect(await ended(pid)).toBe(true);
    }
    expect((await onlyRecord()).data.outcome).toBe("the upload did not finish within 8 s and was stopped");
  });

  it("stops the upload with all it started when the deploy gets SIGTERM, and records it", async () => {
    await released({ behavior: { deploy: "hang" } });
    const { result } = start([TAG], { answers: ["y"] });

    const pids = await hangingPids();
    const [upload] = await deployCalls();
    process.kill(upload?.ppid ?? 0, "SIGTERM");

    await result;
    for (const pid of pids) {
      expect(await ended(pid)).toBe(true);
    }
    expect((await onlyRecord()).data.outcome).toBe("stopped by SIGTERM during the upload; what is live is unread");
  });

  it("records the upload's result before it reads what is live, which --read-back reads after a signal there", async () => {
    await released({ afterDeploy: { "deployments status": "hang" } });
    const { result } = start([TAG], { answers: ["y"] });

    await hangingPids();
    const read = (await wranglerCalls()).findLast((call) => call.call === "deployments status");
    process.kill(read?.ppid ?? 0, "SIGTERM");
    await result;
    const { dir, data } = await onlyRecord();
    expect(data).toMatchObject({
      outcome: "deployed",
      upload: { exit: 0, versionId: "00000010-0000-4000-8000-000000000000" },
      after: null,
    });

    await changeState({ behavior: {} });
    const again = await deploy(["--read-back", dir], { terminal: false });
    expect(again.code).toBe(0);
    expect(await record(dir)).toMatchObject({ application: "unchanged", readBack: { state: "complete" } });
  });

  it("reads back a record that ended during the upload without its result, from wrangler's output file", async () => {
    await released({ behavior: { deploy: "hang-after-upload" } });
    const { result } = start([TAG], { answers: ["y"] });

    const pids = await hangingPids();
    const [upload] = await deployCalls();
    process.kill(upload?.ppid ?? 0, "SIGKILL");
    for (const pid of pids) {
      process.kill(pid, "SIGKILL");
    }
    await result;
    const { dir, data } = await onlyRecord();
    expect(data).toMatchObject({ outcome: "uploading", upload: null });

    await changeState({ behavior: {} });
    const again = await deploy(["--read-back", dir], { terminal: false });
    expect(again.code).toBe(0);
    expect(await record(dir)).toMatchObject({
      outcome: "deployed (read back after the upload stopped)",
      upload: { exit: null, versionId: "00000010-0000-4000-8000-000000000000" },
      readBack: { state: "complete" },
    });
  });

  it("keeps the rollout a --read-back found while it could not read the live versions of an upload that ended without its result", async () => {
    // A retry whose image was the same ends during its upload, once wrangler has written the version, without its
    // result recorded.
    await released({ behavior: { deploy: "hang-after-upload" } });
    const { result } = start([TAG], { answers: ["y"] });
    const pids = await hangingPids();
    const [upload] = await deployCalls();
    process.kill(upload?.ppid ?? 0, "SIGKILL");
    for (const pid of pids) {
      process.kill(pid, "SIGKILL");
    }
    await result;
    const { dir } = await onlyRecord();

    // The first --read-back cannot read the live versions, and finds a rollout under way.
    await changeState({ behavior: { "deployments status": "fail" }, rolloutReads: 1 });
    const first = await deploy(["--read-back", dir], { terminal: false });
    expect(first.code).toBe(2);
    expect(await record(dir)).toMatchObject({
      application: null,
      rollout: { id: APP.id, image: APP.image, version: APP.version },
      readBack: {
        state: "incomplete",
        reason: `the upload did not finish (the deploy ended during the upload without recording its result): deploy ${TAG} again (docs/operations.md, Recovery)`,
      },
    });

    // The second reads them, and finds the rollout cleared with an active instance still at the earlier version.
    await changeState({ behavior: {}, instancePages: [[{ state: "running", version: APP.version - 1 }]] });
    settings.rolloutMs = 3000;
    const second = await deploy(["--read-back", dir], { terminal: false });
    expect(second.code).toBe(2);
    expect(await record(dir)).toMatchObject({
      application: "unchanged",
      readBack: { state: "incomplete", reason: "the rollout was not complete within 3 s" },
    });
  });

  it("prints its usage for anything else", async () => {
    for (const args of [[], ["0.1.0"], [TAG, "--force"], [TAG, "--immediate", "--immediate"], ["--bootstrap", TAG]]) {
      expect(await deploy(args, { terminal: false })).toMatchObject({
        code: 1,
        output:
          "deploy: usage: deploy --bootstrap [--resume] | <tag> [--ignore-running] [--immediate] [--keep-image] | --read-back <record>\n",
      });
    }
    expect(await wranglerCalls()).toEqual([]);
  });
});
