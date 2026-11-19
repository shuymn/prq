// The deploy (`pnpm run deploy` in packages/server; docs/operations.md, First deploy, Each release and Recovery): the
// Worker prq on the account target.env names (CLOUDFLARE_ACCOUNT_ID), served at the hostname it names (PRQ_HOST).
//
//   --bootstrap [--resume]  once, before prq's first upload: an inert Worker named prq (every request answers 404 with
//                           an x-prq-bootstrap header; no assets, Durable Objects or container) with workers.dev and
//                           preview URLs off, tagged prq-bootstrap; refused while a Worker prq has a live version. Its
//                           version ID and the account's workers.dev subdomain (the owner's answer) are recorded.
//                           --resume deploys it again over a live version tagged prq-bootstrap alone, so that its
//                           settings apply after a bootstrap that stopped part-way.
//   <tag>                   a release: in a terminal (wrangler asks there before it replaces a DNS record or another
//                           Worker's domain), a clone of the tag from origin, kept and named; the release check
//                           (release-check.ts) there; the clone's pinned tools (mise), its frozen lockfile and its
//                           build; none of the four deployment values in its tracked files; the state before; the
//                           owner's confirmation; no cloud work waiting or running (the idle check, from the ledger
//                           with the service token prq uses, skipped while the live Worker is the bootstrap's); then the
//                           clone's wrangler deploys it with the hostname as its custom domain, and the state after
//                           is read back. --ignore-running turns a busy or failed idle check into a warning,
//                           --immediate has Durable Objects take the new code at once, --keep-image deploys without
//                           building or rolling out the container's image (once its application exists).
//   --read-back <record>    the read-back of a deploy's record again, on the same account and application.
//
// Every run keeps a record in ~/.local/state/prq/deploys ($XDG_STATE_HOME/prq/deploys when that is set): the tag and
// SHA, the live versions and the container application (its image, version and rollout) before and after, wrangler's
// output file, the idle check and the read-back, written as each is known, a failed upload's included. The read-back:
// the deployed version live alone, and the Workspace's container application created (its provisioning is what the
// owner sees in the dashboard: observed, or unverified), unchanged, or changed: then its image the one this deploy set,
// no active rollout, and every instance at the application's version. The exit code is wrangler's when the upload
// failed, 0 once the read-back is complete, and 2 while it is not (the record then says why, and --read-back resumes
// it).

import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { LedgerPage } from "@prq/protocol";
import * as v from "valibot";
import { unstable_readConfig } from "wrangler";

import {
  account,
  accountName,
  answer,
  answerOf,
  ask,
  checkConfigAccount,
  CONFIG,
  failed,
  hide,
  onInterrupt,
  print,
  printError,
  readPrivate,
  Refusal,
  run,
  runCommand,
  succeeded,
  TARGET_ENV,
  waitMs,
  WORKER,
  WORKER_ENV,
  wrangler,
  wranglerEnv,
  wranglerProgram,
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
// The repository's wrangler configuration at its top level, whatever CLOUDFLARE_ENV says, for every read on the account
// (as the secrets command's calls).
const TOP_LEVEL = ["--config", CONFIG, "--env", ""];
// The rollout is read every poll interval, at most this many times (30 minutes at 10 s).
const POLL_ROUNDS = 180;
// How long the owner has to look at a new container application in the dashboard.
const PROVISIONING_MS = 30 * 60_000;
// The most ledger pages the idle check reads.
const LEDGER_PAGES = 1_000;
const LEDGER_REQUEST_MS = 30_000;

function setting(name: string, fallback: number): number {
  const text = process.env[name] ?? "";
  return /^[1-9][0-9]*$/.test(text) ? Number(text) : fallback;
}

// Only for tests: shorter bounds for the clone's steps and the upload, a shorter poll interval, and the Worker's origin
// for the idle check.
const stepMs = setting("PRQ_DEPLOY_STEP_MS", 60 * 60_000);
const uploadMs = setting("PRQ_DEPLOY_STEP_MS", 2 * 60 * 60_000);
const pollMs = setting("PRQ_DEPLOY_POLL_MS", 10_000);
const originOverride = process.env["PRQ_DEPLOY_ORIGIN"];

// What wrangler answers: `deployments status --json`, `versions view --json`, `containers list --json`,
// `containers info --json` and `containers instances --json`.
const DeploymentAnswer = v.object({
  id: v.nullish(v.string()),
  versions: v.array(v.object({ version_id: v.string(), percentage: v.number() })),
});
const VersionAnswer = v.object({
  annotations: v.nullish(v.record(v.string(), v.string())),
  resources: v.nullish(v.object({ bindings: v.nullish(v.array(v.object({ type: v.string() }))) })),
});
const ApplicationsAnswer = v.array(v.object({ id: v.string(), name: v.string() }));
const ApplicationAnswer = v.object({
  id: v.string(),
  version: v.nullish(v.number()),
  configuration: v.nullish(v.object({ image: v.nullish(v.string()) })),
  active_rollout_id: v.nullish(v.string()),
});
const InstancesAnswer = v.array(v.object({ state: v.string(), version: v.nullish(v.number()) }));

const Deployment = v.object({
  id: v.nullable(v.string()),
  // inert: a version with no binding but secrets, as the bootstrap's Worker and the versions secrets put makes of it.
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
// What a read found: a value, or null when there is none, with what could not be read.
const State = v.object({
  deployment: v.nullable(Deployment),
  application: v.nullable(Application),
  unread: v.array(v.string()),
});
type State = v.InferOutput<typeof State>;

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
class Saved<T> {
  readonly dir: string;
  readonly file: string;
  data: T;
  #saving: Promise<void> = Promise.resolve();

  constructor(dir: string, file: string, data: T) {
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
      const entry: unknown = JSON.parse(line);
      const parsed = v.safeParse(v.object({ type: v.literal("deploy"), version_id: v.string() }), entry);
      if (parsed.success) {
        found = parsed.output.version_id;
      }
    } catch {
      // Not an entry.
    }
  }
  return found;
}

// A version's tag, and whether it has no binding but secrets.
async function version(accountId: string, versionId: string): Promise<{ tag: string | null; inert: boolean }> {
  const outcome = await wrangler(["versions", "view", versionId, "--json", "--name", WORKER, ...TOP_LEVEL], accountId);
  if (!succeeded(outcome)) {
    throw failed("versions view", outcome);
  }
  const viewed = answerOf("versions view", VersionAnswer, outcome.stdout);
  return {
    tag: viewed.annotations?.["workers/tag"] ?? null,
    inert: (viewed.resources?.bindings ?? []).every((binding) => binding.type === "secret_text"),
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

async function applicationId(accountId: string): Promise<string | null> {
  const outcome = await wrangler(["containers", "list", "--json", ...TOP_LEVEL], accountId);
  if (!succeeded(outcome)) {
    throw failed("containers list", outcome);
  }
  return (
    answerOf("containers list", ApplicationsAnswer, outcome.stdout).find((app) => app.name === APPLICATION)?.id ?? null
  );
}

async function applicationInfo(accountId: string, id: string): Promise<Application> {
  const outcome = await wrangler(["containers", "info", id, "--json", ...TOP_LEVEL], accountId);
  if (!succeeded(outcome)) {
    throw failed("containers info", outcome);
  }
  const app = answerOf("containers info", ApplicationAnswer, outcome.stdout);
  return {
    id: app.id,
    version: app.version ?? null,
    image: app.configuration?.image ?? null,
    activeRollout: app.active_rollout_id ?? null,
  };
}

async function instances(accountId: string, id: string): Promise<v.InferOutput<typeof InstancesAnswer>> {
  const outcome = await wrangler(["containers", "instances", id, "--json", ...TOP_LEVEL], accountId);
  if (!succeeded(outcome)) {
    throw failed("containers instances", outcome);
  }
  return answerOf("containers instances", InstancesAnswer, outcome.stdout);
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
  const id = knownId ?? (await attempt("the container applications", () => applicationId(accountId)));
  const application =
    id === null ? null : await attempt("the container application", () => applicationInfo(accountId, id));
  return { deployment, application, unread };
}

function versionsLine(deployment: Deployment | null): string {
  if (deployment === null || deployment.versions.length === 0) {
    return "none";
  }
  return deployment.versions
    .map((each) => `${each.versionId} (${each.tag ?? "untagged"}, ${each.percentage} %)`)
    .join(", ");
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

// A step in the clone, its output shown, refused when it fails.
async function step(name: string, command: string, args: readonly string[], cwd: string): Promise<void> {
  print(`deploy: ${name}`);
  const outcome = await run(name, command, args, { cwd, env: process.env, output: "show", timeoutMs: stepMs });
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
// Worker prq, with workers.dev and preview URLs off, which wrangler sets on every deploy, and no account_id, which
// wrangler would deploy to in place of target.env's.
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
  if (config.account_id !== undefined) {
    throw new Refusal(
      `the tag's packages/server/wrangler.jsonc sets an account_id, which wrangler would deploy to in place of ${TARGET_ENV}'s`,
    );
  }
  print(`configuration: the Worker ${WORKER}, with workers.dev and preview URLs off`);
}

// The clone's own wrangler, as its frozen install put it.
function cloneWrangler(clone: string): [string, string[]] {
  let cli = "";
  try {
    cli = createRequire(join(clone, "packages", "server", "package.json")).resolve("wrangler");
  } catch {
    // The override needs none; without it, the run says wrangler could not start.
  }
  return wranglerProgram(cli);
}

// The read-back's verdict, recorded.
async function settle(
  record: Saved<DeployRecord>,
  state: "complete" | "incomplete",
  reason: string,
  extra: Partial<NonNullable<DeployRecord["readBack"]>> = {},
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
    return 0;
  }
  printError(`deploy: verification incomplete: ${reason}`);
  printError(`deploy: resume it with ${RESUME} ${record.dir}`);
  return 2;
}

// Polls a changed application until its rollout is complete: the image this deploy set, no active rollout, and every
// instance at the application's version, none starting or failed.
async function pollRollout(record: Saved<DeployRecord>, expectedImage: string | null, id: string): Promise<number> {
  const { accountId } = record.data;
  const rounds = record.data.readBack?.rounds ?? [];
  onInterrupt(async () => {
    process.exitCode = await settle(record, "incomplete", "the owner stopped the rollout's read-back", { rounds });
    process.exit();
  });
  try {
    for (let round = 0; round < POLL_ROUNDS; round++) {
      let app: Application;
      let listed: v.InferOutput<typeof InstancesAnswer>;
      try {
        app = await applicationInfo(accountId, id);
        listed = await instances(accountId, id);
      } catch (error) {
        if (!(error instanceof Refusal)) {
          throw error;
        }
        return await settle(record, "incomplete", `the rollout could not be read: ${error.lines.join("; ")}`, {
          rounds,
        });
      }
      const behind = listed.filter(
        (each) => each.version !== null && each.version !== undefined && each.version !== app.version,
      );
      const unsettled = listed.filter((each) =>
        ["provisioning", "failed", "unhealthy", "unknown"].includes(each.state),
      );
      const instancesLine = `${listed.length} listed, ${behind.length} at another version, ${unsettled.length} not settled`;
      rounds.push({ at: now(), application: app, instances: instancesLine });
      print(`rollout: ${applicationLine(app)}; instances: ${instancesLine}`);
      if (expectedImage !== null && app.image !== expectedImage) {
        return await settle(
          record,
          "incomplete",
          `the application's image is ${app.image ?? "unknown"}, not ${expectedImage}`,
          { rounds },
        );
      }
      if (app.activeRollout === null && behind.length === 0 && unsettled.length === 0) {
        return await settle(
          record,
          "complete",
          `the application's rollout of version ${app.version ?? "unknown"} is complete`,
          { rounds },
        );
      }
      await record.save();
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return await settle(record, "incomplete", `the rollout was not complete after ${POLL_ROUNDS} reads`, { rounds });
  } finally {
    onInterrupt(null);
  }
}

// A new application: the owner reads its provisioning in the dashboard, or it stays unverified.
async function provisioning(record: Saved<DeployRecord>): Promise<number> {
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

// The read-back after a successful upload: the deployed version live alone, then the application as it was left.
async function readBack(record: Saved<DeployRecord>): Promise<number> {
  const { after, upload, application } = record.data;
  const state = record.data.reread ?? after;
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
      `the live versions are ${versionsLine(state?.deployment ?? null)}, not ${versionId} alone`,
    );
  }
  const app = state?.application ?? null;
  switch (application) {
    case "created":
      return provisioning(record);
    case "changed":
      // The image read right after the upload is the one this deploy set.
      return app === null
        ? settle(record, "incomplete", "the application could not be read")
        : pollRollout(record, after?.application?.image ?? app.image, app.id);
    case "unchanged":
    case "kept":
      return settle(record, "complete", `version ${versionId} is live, and the application's image is unchanged`);
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
  await step(
    `git clone of ${tag}`,
    "git",
    ["-c", "advice.detachedHead=false", "clone", "--branch", tag, "--", url, clone],
    process.cwd(),
  );
  await step("the release check", process.execPath, ["--no-warnings", RELEASE_CHECK, tag], clone);
  await step("mise trust", "mise", ["trust"], clone);
  await step("mise install", "mise", ["install"], clone);
  await step("pnpm install", "mise", ["exec", "--", "pnpm", "install", "--frozen-lockfile"], clone);
  await step("the web UI's build", "mise", ["exec", "--", "pnpm", "--dir", "packages/server", "run", "build"], clone);
  await publicationCheck(clone, {
    PRQ_HOST: host,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    ACCESS_TEAM_DOMAIN: teamHost,
    ACCESS_AUD: aud,
  });
  configCheck(clone);
  const sha = await gitOutput(clone, ["rev-parse", "--verify", "HEAD"]);

  const dir = join(root, `${stamp()}-${tag}`);
  await mkdir(dir, { mode: 0o700 });
  const record = new Saved<DeployRecord>(dir, join(dir, "record.json"), {
    kind: "prq-deploy",
    tag,
    sha,
    accountId,
    worker: WORKER,
    host,
    clone,
    startedAt: now(),
    flags,
    before: { deployment: null, application: null, unread: [] },
    outcome: "reading the state before",
    idle: null,
    upload: null,
    after: null,
    reread: null,
    application: null,
    readBack: null,
  });
  await record.save();
  const stop = async (outcome: string, ...lines: string[]): Promise<never> => {
    record.data.outcome = outcome;
    await record.save();
    throw new Refusal(...lines, `record: ${dir}`);
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
  if (flags.keepImage && before.application === null) {
    await stop(
      "refused: --keep-image without an application",
      `--keep-image keeps the container application's image, and ${APPLICATION} does not exist yet: the first deploy creates it`,
    );
  }
  // The bootstrap's Worker, or a version secrets put made of it: no prq is served at the hostname yet.
  const bootstrapped = live.every((each) => each.inert);

  print(`account: ${accountId} (${name})`);
  print(`Worker: ${WORKER}, live: ${versionsLine(before.deployment)}`);
  print(`hostname: ${host}, attached as the Worker's custom domain`);
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
    : await idleCheck(host, flags.ignoreRunning).catch(async (error: unknown) => {
        if (error instanceof Refusal) {
          await stop(`refused: ${error.lines.join("; ")}`, ...error.lines);
        }
        throw error;
      });
  record.data.outcome = "uploading";
  await record.save();

  const output = join(dir, "wrangler-output.jsonl");
  const [program, base] = cloneWrangler(clone);
  onInterrupt(async (signal) => {
    record.data.upload = { exit: null, signal, timedOut: false, versionId: await deployedVersion(output) };
    record.data.outcome = `stopped by ${signal} during the upload; what is live is unread`;
    await record.save();
    printError(`deploy: stopped during the upload; read what is live with ${RESUME} ${dir}`);
  });
  const uploaded = await run(
    "wrangler deploy",
    "mise",
    [
      "exec",
      "--",
      program,
      ...base,
      "deploy",
      `--config=${join(clone, "packages", "server", "wrangler.jsonc")}`,
      "--env",
      "",
      `--domain=${host}`,
      `--tag=${tag}`,
      `--message=prq ${tag} ${sha}`,
      ...(flags.immediate ? ["--durable-objects-code-update-mode=immediate"] : []),
      ...(flags.keepImage ? ["--containers-rollout=none"] : []),
    ],
    {
      cwd: join(clone, "packages", "server"),
      env: { ...wranglerEnv(accountId), WRANGLER_OUTPUT_FILE_PATH: output },
      output: "show",
      timeoutMs: uploadMs,
      foreground: true,
    },
  );
  onInterrupt(null);
  record.data.upload = {
    exit: uploaded.code,
    signal: uploaded.signal,
    timedOut: uploaded.timedOut,
    versionId: await deployedVersion(output),
  };
  record.data.after = await readState(accountId, before.application?.id ?? null);
  if (!succeeded(uploaded)) {
    record.data.outcome = uploaded.timedOut
      ? `the upload did not finish within ${Math.round(uploadMs / 1000)} s and was stopped`
      : `the upload failed (exit ${uploaded.code ?? uploaded.signal ?? "unknown"})`;
    await record.save();
    printError(`deploy: ${record.data.outcome}`);
    printError(`deploy: live now: ${versionsLine(record.data.after.deployment)}`);
    printError(`deploy: container application: ${applicationLine(record.data.after.application)}`);
    printError(`deploy: record: ${dir} (docs/operations.md, Recovery)`);
    return uploaded.code !== null && uploaded.code !== 0 ? uploaded.code : 1;
  }
  record.data.outcome = "deployed";
  record.data.application = classify(before.application, record.data.after.application, flags.keepImage);
  await record.save();
  return readBack(record);
}

// --read-back: the record's account and application read again, and the read-back it lacked. A record whose upload
// stopped is read back only when its version is live alone; otherwise what is live is recorded for the recovery.
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
  const { upload, accountId, before, flags, tag } = record.data;
  await checkConfigAccount(accountId);
  if (upload === null) {
    throw new Refusal(`the record's deploy stopped before its upload (${record.data.outcome}): nothing to read back`);
  }
  const state = await readState(accountId, record.data.after?.application?.id ?? before.application?.id ?? null);
  record.data.reread = state;
  print(`account: ${accountId}; live: ${versionsLine(state.deployment)}`);
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
      `the Worker ${WORKER} has a live version (${versionsLine({ id: null, versions: live })}): the bootstrap only creates it`,
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
      `the live versions are ${versionsLine({ id: null, versions: after })}, not the bootstrap's ${versionId ?? "(unnamed)"} alone`,
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
  }
  if (subdomain === null) {
    printError(
      "deploy: no workers.dev subdomain recorded (a subdomain, or none): run --bootstrap --resume to record it",
    );
    return 2;
  }
  return 0;
}

async function main(args: readonly string[]): Promise<number> {
  const [first = "", ...rest] = args;
  if (first === "--bootstrap" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--resume"))) {
    return bootstrap(rest.length === 1);
  }
  if (first === "--read-back" && rest.length === 1 && rest[0] !== undefined) {
    return readBackAgain(rest[0]);
  }
  const known = ["--ignore-running", "--immediate", "--keep-image"];
  if (TAG.test(first) && rest.every((arg) => known.includes(arg)) && new Set(rest).size === rest.length) {
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
