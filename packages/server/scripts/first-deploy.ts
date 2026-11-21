// The first deploy (`pnpm run first-deploy` in packages/server): from a release tag to a summary and an answer on a
// test pull request, by the existing commands. Its steps, questions, record and exit codes are docs/operations.md's
// (First deploy).

import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";

import { fixture } from "./fixture.ts";
import {
  ACCESS_ENV,
  answer,
  answerOf,
  hide,
  notInCi,
  onInterrupt,
  print,
  printError,
  readEnvFile,
  readPrivate,
  readTarget,
  refuseOverrides,
  reveal,
  Refusal,
  run,
  runCommand,
  stateRoot,
  Unconfirmed,
  waitMs,
  WORKER_ENV,
} from "./operations.ts";
import { GITHUB, TAG } from "./release-check.ts";
import { appJwt, call, duration, gh, sleep } from "./setup-run.ts";
import { readState, recordState } from "./setup-state.ts";
import { KEY_FILE } from "./worker-secrets.ts";

const STEPS = [
  "preflight",
  "release-sha",
  "pre-tag",
  "tag",
  "release",
  "bootstrap",
  "secrets",
  "deploy",
  "served",
  "webhook",
  "pool",
  "summary",
  "ask",
  "report",
] as const;
type Step = (typeof STEPS)[number];
// The publisher's steps, which a run with --tag skips.
const CREATE_ONLY: readonly Step[] = ["pre-tag", "tag"];
const USAGE = `usage: first-deploy --tag <vX.Y.Z> | --create-tag --release-pr <number>; either with --from <${STEPS.join("|")}>`;
const CI_REASON = "where nobody answers the deploy's questions: run first-deploy from a terminal of your own";
const STATE_KEY = "firstDeploy";
const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));
const CHECKOUT_CLI = fileURLToPath(new URL("../../cli", import.meta.url));
const TARGETS = ["darwin-arm64", "linux-x64", "linux-arm64"];
const WORKFLOW = "release.yml";
const QUESTION = "What does this pull request change?";
const VERDICTS = ["pass", "fail", "unattributed", "unexercised"] as const;
const DASHBOARD = "Workers & Pages → prq → Settings → Domains & Routes";
// A delivery of the App's webhook, as GitHub lists it.
const Delivery = v.object({ id: v.number(), event: v.string(), status_code: v.number(), delivered_at: v.string() });
const GITHUB_WEB = fixture.githubWeb ?? "https://github.com";
const GITHUB_API = fixture.githubApi ?? "https://api.github.com";

// Only the tests' fixture sets the program run in place of the existing commands, Docker and pnpm, the state
// directory, and shorter bounds.
const commandsProgram = fixture.commands;
const stateDirectory = fixture.stateDir ?? join(stateRoot(), "prq");
const pollMs = fixture.pollMs ?? 15_000;
// The release workflow's run is followed this long; the ping is waited for this long.
const followMs = fixture.followMs ?? 60 * 60_000;
const pingMs = fixture.followMs ?? 5 * 60_000;
// A command the owner answers, or a check that waits for an analysis, runs this long.
const commandMs = fixture.stepMs ?? 3 * 60 * 60_000;
// The owner's time for what they do in a browser.
const browserMs = fixture.stepMs ?? 60 * 60_000;
// A tag push's run appears within this long.
const runAppearsMs = fixture.stepMs ?? 5 * 60_000;

// A deployed check whose verdicts were accepted: its saved run, and its verdicts' counts.
const Accepted = v.object({ step: v.string(), mode: v.string(), file: v.string(), verdicts: v.string() });
const Progress = v.object({
  mode: v.picklist(["tag", "create"]),
  releasePr: v.nullable(v.number()),
  repository: v.string(),
  tag: v.nullable(v.string()),
  sha: v.nullable(v.string()),
  done: v.record(v.string(), v.string()),
  // When secrets put exited 0: its acknowledged write is not sent again.
  secretsPut: v.nullable(v.string()),
  deployRecord: v.nullable(v.string()),
  testPr: v.nullable(v.object({ repository: v.string(), branch: v.string(), number: v.nullable(v.number()) })),
  webhook: v.nullable(v.picklist(["pass", "unexercised"])),
  // By `<step>:<mode>`: a check accepted is not run again until its step is run again with --from.
  accepted: v.record(v.string(), Accepted),
});
type Progress = v.InferOutput<typeof Progress>;

function isStep(value: string | undefined): value is Step {
  return STEPS.some((step) => step === value);
}

type Args = { mode: "tag"; tag: string; from: Step | null } | { mode: "create"; pr: number; from: Step | null };

function parseArgs(args: readonly string[]): Args {
  let tag: string | null = null;
  let pr: number | null = null;
  let create = false;
  let from: Step | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--tag" && value !== undefined && TAG.test(value) && tag === null) {
      tag = value;
      index++;
    } else if (arg === "--release-pr" && value !== undefined && /^[1-9][0-9]{0,8}$/.test(value) && pr === null) {
      pr = Number(value);
      index++;
    } else if (arg === "--create-tag" && !create) {
      create = true;
    } else if (arg === "--from" && from === null && isStep(value)) {
      from = value;
      index++;
    } else {
      throw new Refusal(USAGE);
    }
  }
  if (tag !== null && !create && pr === null) {
    return { mode: "tag", tag, from };
  }
  if (create && pr !== null && tag === null) {
    return { mode: "create", pr, from };
  }
  throw new Refusal(USAGE);
}

// --- Children ---

type Child = { program: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv };

// An existing command of this checkout, as its package script runs it.
function serverCommand(name: "setup" | "release-check" | "deploy" | "secrets", args: string[], cwd: string): Child {
  return commandsProgram === undefined
    ? { program: process.execPath, args: [join(SCRIPTS, `${name}.ts`), ...args], cwd }
    : { program: commandsProgram, args: [name, ...args], cwd };
}

// A deployed check of the checkout at cliDir (packages/cli), with env added to this process's.
function deployedCheck(cliDir: string, args: string[], env: NodeJS.ProcessEnv = {}): Child {
  const full = { ...process.env, ...env };
  return commandsProgram === undefined
    ? { program: "pnpm", args: ["--dir", cliDir, "run", "check:deployed", "--", ...args], cwd: cliDir, env: full }
    : { program: commandsProgram, args: ["check:deployed", ...args], cwd: cliDir, env: full };
}

// A child in the foreground, on the terminal, where it asks: its exit code; refused when it does not finish in time.
async function foreground(name: string, child: Child, timeoutMs = commandMs): Promise<number> {
  print(`first-deploy: running ${name}`);
  const outcome = await call(name, child.program, child.args, child.cwd, {
    output: "show",
    foreground: true,
    timeoutMs,
    ...(child.env === undefined ? {} : { env: child.env }),
  });
  return outcome.code ?? 1;
}

// A child's failure: its exit 2 (a write without an acknowledgement) passed on as such.
function childFailed(name: string, code: number, ...next: string[]): Refusal {
  const line = `${name} exited ${code}`;
  return code === 2 ? new Unconfirmed(line, ...next) : new Refusal(line, ...next);
}

async function git(cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
  const outcome = await call(`git ${args[0] ?? ""}`, "git", args, cwd);
  return { code: outcome.code ?? 1, stdout: outcome.stdout.trim() };
}

async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
  const outcome = await git(cwd, args);
  if (outcome.code !== 0) {
    throw new Refusal(`git ${args[0] ?? ""} failed (exit ${outcome.code})`);
  }
  return outcome.stdout;
}

// gh's JSON answer, read with a schema; refused when gh fails.
async function ghJson<S extends v.GenericSchema>(args: string[], cwd: string, schema: S): Promise<v.InferOutput<S>> {
  const outcome = await gh(args, cwd);
  if (outcome.code !== 0) {
    throw new Refusal(`gh ${args.slice(0, 2).join(" ")} failed (exit ${outcome.code ?? "by a signal"})`);
  }
  return answerOf(`gh ${args.slice(0, 2).join(" ")}`, schema, outcome.stdout);
}

// --- Saved check runs ---

const SavedRun = v.object({
  observations: v.array(v.object({ id: v.string(), what: v.string(), verdict: v.string() })),
  notes: v.array(v.string()),
});
type SavedRun = v.InferOutput<typeof SavedRun>;

// A check's saved run, null when it saved none or one in another shape.
async function readSaved(file: string): Promise<SavedRun | null> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) {
    return null;
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = v.safeParse(SavedRun, json);
  return parsed.success ? parsed.output : null;
}

// A saved run's verdicts' counts, with passes what its validator checked besides.
function verdictsLine(saved: SavedRun, passes = 0): string {
  return VERDICTS.map(
    (verdict) =>
      `${saved.observations.filter((each) => each.verdict === verdict).length + (verdict === "pass" ? passes : 0)} ${verdict}`,
  ).join(", ");
}

// A check's verdicts, accepted only on evidence: a fail stops; an unattributed denial passes once the owner found it in
// Access's logs; an unexercised workers.dev address once the dashboard shows it off; anything else unexercised stops,
// for the step to run again.
async function judge(mode: string, saved: SavedRun): Promise<void> {
  const of = (verdict: string) => saved.observations.filter((each) => each.verdict === verdict);
  const named = (list: SavedRun["observations"]) => list.map((each) => `${each.id} (${each.what})`).join(", ");
  const failed = of("fail");
  if (failed.length > 0) {
    throw new Refusal(`${named(failed)} failed`);
  }
  const unexercised = of("unexercised");
  if (unexercised.length > 0) {
    if (mode !== "endpoints") {
      throw new Refusal(`${named(unexercised)} unexercised: run the step again once its event can happen`);
    }
    if (
      !(await answer(`In the dashboard (${DASHBOARD}), are workers.dev and Preview URLs disabled? [y/N] `, browserMs))
    ) {
      throw new Refusal(`${named(unexercised)} unexercised, and the dashboard does not show both off`);
    }
  }
  const unattributed = of("unattributed");
  if (unattributed.length > 0) {
    const question = `Do Zero Trust's Access logs show ${unattributed.map((each) => each.id).join(", ")} refused by Access, at the time and cf-ray its lines give? [y/N] `;
    if (!(await answer(question, browserMs))) {
      throw new Refusal(`${named(unattributed)} unattributed: not found in Access's logs`);
    }
  }
}

// --- The state ---

async function readProgress(): Promise<Progress | null> {
  const found = (await readState())[STATE_KEY];
  if (found === undefined) {
    return null;
  }
  const parsed = v.safeParse(Progress, found);
  if (!parsed.success) {
    throw new Refusal(
      `the state file's ${STATE_KEY} is not in the shape this command reads: --from preflight starts over`,
    );
  }
  return parsed.output;
}

// The progress, saved whole each time it changes.
class Run {
  readonly root: string;
  readonly args: Args;
  data: Progress;

  constructor(root: string, args: Args, data: Progress) {
    this.root = root;
    this.args = args;
    this.data = data;
  }

  async save(): Promise<void> {
    await recordState(STATE_KEY, this.data);
  }

  get tag(): string {
    if (this.data.tag === null) {
      throw new Refusal("no release tag is recorded: run first-deploy --from release-sha");
    }
    return this.data.tag;
  }

  get sha(): string {
    if (this.data.sha === null) {
      throw new Refusal("no release commit is recorded: run first-deploy --from release-sha");
    }
    return this.data.sha;
  }

  // A new file for a check's saved run, in a directory of the state directory the owner alone reads.
  async checkFile(step: Step, mode: string): Promise<string> {
    const dir = join(stateDirectory, "first-deploy", this.tag);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const each of [stateDirectory, join(stateDirectory, "first-deploy"), dir]) {
      const info = await lstat(each);
      if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
        throw new Refusal(`${each} is not a directory of its owner's alone: chmod 700 it`);
      }
    }
    return join(dir, `${new Date().toISOString().replaceAll(":", "-")}-${step}-${mode}.json`);
  }

  // A deployed check with --json, unless one of the step was accepted: onRun gets this run's file before anything
  // is judged, and accept then judges it. Its saved run.
  async check(
    step: Step,
    cliDir: string,
    mode: string,
    args: string[],
    env: NodeJS.ProcessEnv = {},
    onRun?: (file: string) => Promise<void>,
  ): Promise<SavedRun> {
    const earlier = this.data.accepted[`${step}:${mode}`];
    const kept = earlier === undefined ? null : await readSaved(earlier.file);
    if (kept !== null) {
      print(`first-deploy: check:deployed ${mode}: accepted earlier (${earlier?.verdicts ?? ""})`);
      return kept;
    }
    const file = await this.checkFile(step, mode);
    const code = await foreground(
      `check:deployed ${mode}`,
      deployedCheck(cliDir, [mode, ...args, "--json", file], env),
    );
    await onRun?.(file);
    return this.accept(step, mode, file, code);
  }

  // A check's run accepted (its verdicts judged, then what valid adds, which returns how many checks of its own
  // passed), and recorded so; refused otherwise.
  async accept(
    step: Step,
    mode: string,
    file: string,
    code: number,
    valid?: (saved: SavedRun) => number,
  ): Promise<SavedRun> {
    const name = `check:deployed ${mode}`;
    const saved = await readSaved(file);
    if (saved === null) {
      throw childFailed(name, code === 0 ? 1 : code, "it saved no run");
    }
    let passes = 0;
    try {
      await judge(mode, saved);
      if (code !== 0) {
        throw childFailed(name, code);
      }
      passes = valid?.(saved) ?? 0;
    } catch (error) {
      throw error instanceof Refusal ? new Refusal(...error.lines, `its saved run: ${file}`) : error;
    }
    this.data.accepted[`${step}:${mode}`] = { step, mode, file, verdicts: verdictsLine(saved, passes) };
    await this.save();
    return saved;
  }
}

// --- What the steps read ---

// The repository's root and origin's repository on GitHub.
async function checkout(): Promise<{ root: string; repository: string }> {
  const root = await gitOk(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const url = await gitOk(root, ["config", "--get", "remote.origin.url"]);
  const match = GITHUB.exec(url);
  if (match === null) {
    throw new Refusal("origin is not a GitHub repository");
  }
  return { root, repository: `${match[1]}/${match[2]}` };
}

// origin's tag: its object and the commit it peels to (an annotated tag has both lines), each null when absent.
async function remoteTag(root: string, tag: string): Promise<{ object: string | null; peeled: string | null }> {
  const ref = `refs/tags/${tag}`;
  const outcome = await git(root, ["ls-remote", "--end-of-options", "origin", ref, `${ref}^{}`]);
  if (outcome.code !== 0) {
    throw new Unconfirmed(`git ls-remote failed (exit ${outcome.code}): origin's tags could not be read`);
  }
  const lines = new Map(
    outcome.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line): [string, string] => {
        const [sha = "", name = ""] = line.split("\t");
        return [name, sha];
      }),
  );
  return { object: lines.get(ref) ?? null, peeled: lines.get(`${ref}^{}`) ?? null };
}

const BootstrapRecord = v.object({
  kind: v.literal("prq-bootstrap"),
  accountId: v.string(),
  versionId: v.string(),
  subdomain: v.nullable(v.string()),
});
type BootstrapRecord = v.InferOutput<typeof BootstrapRecord>;

const deploys = (): string => join(stateRoot(), "prq", "deploys");

// The newest bootstrap record of the account, null when none.
async function bootstrapRecord(accountId: string): Promise<BootstrapRecord | null> {
  const dir = join(deploys(), "bootstrap");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).toSorted();
  for (const name of names.toReversed()) {
    const parsed = v.safeParse(
      BootstrapRecord,
      JSON.parse(await readFile(join(dir, name), "utf8").catch(() => "null")),
    );
    if (parsed.success && parsed.output.accountId === accountId) {
      return parsed.output;
    }
  }
  return null;
}

// The endpoints check's arguments for what the bootstrap recorded: the subdomain (with the version after the
// bootstrap), or none.
function endpointsArgs(record: BootstrapRecord, withVersion: boolean): string[] {
  if (record.subdomain === null) {
    throw new Refusal("the bootstrap recorded no workers.dev subdomain: run first-deploy --from bootstrap");
  }
  if (record.subdomain === "none") {
    return ["none"];
  }
  return withVersion ? [record.subdomain, "--version", record.versionId] : [record.subdomain];
}

const DeployRecord = v.looseObject({
  kind: v.literal("prq-deploy"),
  tag: v.string(),
  sha: v.string(),
  accountId: v.string(),
  host: v.string(),
  clone: v.string(),
  outcome: v.string(),
  upload: v.nullable(v.looseObject({ exit: v.nullable(v.number()) })),
  readBack: v.nullable(v.looseObject({ state: v.string(), reason: v.string(), at: v.string() })),
});
type DeployRecord = v.InferOutput<typeof DeployRecord> & { dir: string };

// The newest release record of this deploy (`<time>-<tag>/record.json`): the tag at the recorded commit, to the
// account and hostname target.env names. Null when none.
async function releaseRecord(record: Run): Promise<DeployRecord | null> {
  const { accountId, host } = await readTarget();
  const names = (await readdir(deploys()).catch(() => [] as string[])).filter((name) =>
    name.endsWith(`-${record.tag}`),
  );
  for (const name of names.toSorted().toReversed()) {
    const dir = join(deploys(), name);
    const parsed = v.safeParse(
      DeployRecord,
      JSON.parse(await readFile(join(dir, "record.json"), "utf8").catch(() => "null")),
    );
    const found = parsed.success ? parsed.output : null;
    if (found?.tag === record.tag && found.sha === record.sha && found.accountId === accountId && found.host === host) {
      return { ...found, dir };
    }
  }
  return null;
}

// worker.env's values a step needs.
async function workerValues(...names: string[]): Promise<Map<string, string>> {
  const entries = (await readEnvFile(WORKER_ENV)) ?? new Map<string, string>();
  const missing = names.filter((name) => (entries.get(name) ?? "") === "");
  if (missing.length > 0) {
    throw new Refusal(`${WORKER_ENV} does not set ${missing.join(", ")} (setup check names what is missing)`);
  }
  return entries;
}

// The service token and PRQ_URL from access.env, for the deployed checks' environment.
async function accessEnv(): Promise<NodeJS.ProcessEnv> {
  const entries = (await readEnvFile(ACCESS_ENV)) ?? new Map<string, string>();
  const names = ["PRQ_URL", "PRQ_ACCESS_CLIENT_ID", "PRQ_ACCESS_CLIENT_SECRET"];
  const missing = names.filter((name) => (entries.get(name) ?? "") === "");
  if (missing.length > 0) {
    throw new Refusal(`${ACCESS_ENV} does not set ${missing.join(", ")}: run setup cloudflare`);
  }
  // The hostname is the owner's to see here (not the secret).
  reveal([entries.get("PRQ_URL") ?? ""]);
  return Object.fromEntries(names.map((name) => [name, entries.get(name)]));
}

// The deploy's clone the record names, where the tag's checks run. A clone that is gone is made again by hand at the
// same path; no upload is needed for it.
async function cloneCli(record: Run, step: Step): Promise<string> {
  const found = await releaseRecord(record);
  if (found === null || found.dir !== record.data.deployRecord) {
    throw new Refusal(
      "no complete deploy of this tag to this account and hostname is recorded: first-deploy --from deploy",
    );
  }
  const cli = join(found.clone, "packages", "cli");
  if ((await lstat(cli).catch(() => null))?.isDirectory() !== true) {
    const origin = await gitOk(record.root, ["config", "--get", "remote.origin.url"]);
    throw new Refusal(
      `the deploy's clone ${found.clone} is gone: make it again at that path, then first-deploy --from ${step}:`,
      `  git clone --branch ${record.tag} ${origin} ${found.clone}`,
      `  then in it: mise trust, mise install, pnpm install --frozen-lockfile, pnpm --dir packages/server run build`,
    );
  }
  return cli;
}

// --- The steps ---

async function preflight(record: Run): Promise<void> {
  const setupCheck = await foreground("setup check", serverCommand("setup", ["check"], record.root));
  if (setupCheck !== 0) {
    throw childFailed("setup check", setupCheck, "fix what it names, then run first-deploy again");
  }
  const docker = await run(
    "docker info",
    commandsProgram ?? "docker",
    commandsProgram === undefined ? ["info"] : ["docker", "info"],
    {
      cwd: record.root,
      env: { ...process.env, ...fixture.childEnv },
      output: "keep",
      timeoutMs: waitMs,
    },
  );
  if (docker.code !== 0 || docker.timedOut) {
    throw new Refusal("docker info failed: start Docker, which the deploy builds the workspace's image with");
  }
  if ((await gh(["auth", "status"], record.root)).code !== 0) {
    throw new Refusal("gh is not logged in: gh auth login");
  }
  // The test pull request starts from a commit of the test repository's default branch.
  const repository = await testRepository();
  const repo = await ghJson(["api", `repos/${repository}`], record.root, v.object({ default_branch: v.string() }));
  if ((await gh(["api", `repos/${repository}/git/ref/heads/${repo.default_branch}`], record.root)).code !== 0) {
    throw new Refusal(
      `the test repository ${repository} has no commit on its default branch ${repo.default_branch}: push one (a README will do), then run first-deploy again`,
    );
  }
  if (record.args.mode === "create") {
    const code = await foreground("setup repository", serverCommand("setup", ["repository"], record.root));
    if (code !== 0) {
      throw childFailed("setup repository", code, "the release tags' settings must read back before a tag is made");
    }
  }
  print("first-deploy: preflight: pass");
}

async function testRepository(): Promise<string> {
  const app = v.safeParse(v.looseObject({ testRepository: v.string() }), (await readState())["githubApp"]);
  if (!app.success) {
    throw new Refusal("no private test repository is recorded: run setup github-app");
  }
  return app.output.testRepository;
}

const PrView = v.object({
  state: v.string(),
  title: v.string(),
  baseRefName: v.string(),
  mergeCommit: v.nullable(v.object({ oid: v.string() })),
});

async function releaseSha(record: Run): Promise<void> {
  const { root } = record;
  const repository = record.data.repository;
  let tag: string;
  let sha: string;
  if (record.args.mode === "create") {
    const pr = record.args.pr;
    const view = await ghJson(
      ["pr", "view", String(pr), "--repo", repository, "--json", "state,title,baseRefName,mergeCommit"],
      root,
      PrView,
    );
    const titled = /^chore\(release\): (v\S+)$/.exec(view.title)?.[1];
    if (view.state !== "MERGED" || view.baseRefName !== "main" || view.mergeCommit === null) {
      throw new Refusal(`pull request #${pr} is not merged into main`);
    }
    if (titled === undefined || !TAG.test(titled)) {
      throw new Refusal(`pull request #${pr} is not titled chore(release): vX.Y.Z`);
    }
    tag = titled;
    sha = view.mergeCommit.oid;
  } else {
    tag = record.args.tag;
    const found = await remoteTag(root, tag);
    if (found.object === null) {
      throw new Refusal(`origin has no tag ${tag}`);
    }
    if (found.peeled === null) {
      throw new Refusal(`origin's ${tag} is a lightweight tag: a release tag is annotated`);
    }
    sha = found.peeled;
  }
  if ((record.data.tag !== null && record.data.tag !== tag) || (record.data.sha !== null && record.data.sha !== sha)) {
    throw new Refusal(
      `the state records ${record.data.tag ?? "no tag"} at ${record.data.sha ?? "no commit"}, not ${tag} at ${sha}: first-deploy --from preflight starts over`,
    );
  }
  // Recorded before anything else is made of them.
  record.data.tag = tag;
  record.data.sha = sha;
  await record.save();
  print(`first-deploy: release ${tag} at ${sha} of ${repository}`);
}

const RehearsalState = v.object({ outcome: v.string(), sha: v.string(), repository: v.string() });

async function preTag(record: Run): Promise<void> {
  const { root } = record;
  if ((await foreground("git fetch", { program: "git", args: ["fetch", "origin"], cwd: root }, waitMs)) !== 0) {
    throw new Refusal("git fetch origin failed");
  }
  const rehearsal = v.safeParse(RehearsalState, (await readState())["rehearsal"]);
  if (
    !rehearsal.success ||
    rehearsal.output.outcome !== "passed" ||
    rehearsal.output.repository !== record.data.repository
  ) {
    throw new Refusal(`no passed rehearsal of ${record.data.repository} is recorded: run setup rehearsal`);
  }
  const workflow = ".github/workflows/release.yml";
  const blob = (commit: string) => gitOk(root, ["rev-parse", "--verify", `${commit}:${workflow}`]);
  if ((await blob(rehearsal.output.sha)) !== (await blob(record.sha))) {
    throw new Refusal(
      `${workflow} at ${record.sha} is not the one rehearsed at ${rehearsal.output.sha}: run setup rehearsal on the current main`,
    );
  }
  const code = await foreground(
    "release-check",
    serverCommand("release-check", [record.tag, "--pre-tag", record.sha], root),
  );
  if (code !== 0) {
    throw childFailed("release-check", code);
  }
  const immutable = await gh(["api", `repos/${record.data.repository}/immutable-releases`, "--jq", ".enabled"], root);
  if (immutable.code !== 0 || immutable.stdout.trim() !== "true") {
    throw new Refusal(
      "immutable releases are not enabled: run setup repository, since GitHub fixes only the releases published while they are on",
    );
  }
  print("first-deploy: pre-tag: pass");
}

async function tagStep(record: Run): Promise<void> {
  const { root } = record;
  const { tag, sha } = record;
  const ref = `refs/tags/${tag}`;
  const local = async () => {
    const object = await git(root, ["rev-parse", "-q", "--verify", "--end-of-options", ref]);
    if (object.code !== 0) {
      return null;
    }
    const type = await gitOk(root, ["cat-file", "-t", "--end-of-options", ref]);
    const peeled = await gitOk(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    return { object: object.stdout, type, peeled };
  };
  const remote = await remoteTag(root, tag);
  const here = await local();
  if (remote.object !== null) {
    if (remote.peeled !== sha) {
      throw new Refusal(
        `origin's ${tag} ${remote.peeled === null ? "is a lightweight tag" : `tags ${remote.peeled}`}, not ${sha}`,
      );
    }
    if (here !== null && here.object !== remote.object) {
      throw new Refusal(`the local ${tag} is the tag object ${here.object}, not origin's ${remote.object}`);
    }
    print(`first-deploy: origin's ${tag} is annotated on ${sha}: adopted`);
    return;
  }
  if (here !== null) {
    if (here.type !== "tag" || here.peeled !== sha) {
      throw new Refusal(
        `the local ${tag} is ${here.type === "tag" ? `on ${here.peeled}` : "a lightweight tag"}, not annotated on ${sha}: delete it (git tag -d ${tag})`,
      );
    }
    if (!(await answer(`Push the tag ${tag} on ${sha} to origin? A pushed tag is permanent. [y/N] `))) {
      throw new Refusal(`nothing pushed; ${tag} stays local`);
    }
  } else {
    if (!(await answer(`Tag ${sha} as ${tag} and push it? A pushed tag is permanent. [y/N] `))) {
      throw new Refusal("nothing tagged");
    }
    await gitOk(root, ["tag", "-a", "-m", tag, "--end-of-options", tag, sha]);
  }
  const object = await gitOk(root, ["rev-parse", "--verify", "--end-of-options", ref]);
  const pushed = await foreground("git push", { program: "git", args: ["push", "origin", ref], cwd: root }, waitMs);
  const after = await remoteTag(root, tag);
  if (after.object === object && after.peeled === sha) {
    print(`first-deploy: pushed ${tag} (${object}) on ${sha}`);
    return;
  }
  throw new Refusal(
    `git push exited ${pushed}, and origin ${after.object === null ? "has no" : "has another"} ${tag}: run first-deploy --from tag`,
  );
}

const Release = v.object({
  draft: v.boolean(),
  immutable: v.optional(v.boolean()),
  assets: v.array(v.object({ name: v.string(), state: v.string() })),
});
const RunRow = v.object({ databaseId: v.number(), headSha: v.string(), headBranch: v.nullish(v.string()) });
const RunView = v.object({
  status: v.string(),
  conclusion: v.nullish(v.string()),
  jobs: v.array(v.object({ name: v.string(), status: v.string(), conclusion: v.nullish(v.string()) })),
});

// Whether the tag's release is published, immutable, with its three archives uploaded and nothing besides.
async function published(record: Run): Promise<boolean> {
  const outcome = await gh(["api", `repos/${record.data.repository}/releases/tags/${record.tag}`], record.root);
  if (outcome.code !== 0) {
    if (/HTTP 404/.test(outcome.stderr)) {
      return false;
    }
    throw new Refusal(`gh api of the release ${record.tag} failed (exit ${outcome.code ?? "by a signal"})`);
  }
  const release = answerOf("gh api of the release", Release, outcome.stdout);
  const names = release.assets
    .filter((each) => each.state === "uploaded")
    .map((each) => each.name)
    .toSorted();
  const expected = TARGETS.map((target) => `prq-${record.tag}-${target}.tar.gz`).toSorted();
  return !release.draft && release.immutable === true && names.join() === expected.join();
}

// The release: origin's tag still on the recorded commit, the release workflow's push run of that tag at that commit
// followed to its success (which publishes only what it built from it), and the release then published.
async function releaseStep(record: Run): Promise<void> {
  const { root } = record;
  const repository = record.data.repository;
  const tagged = await remoteTag(root, record.tag);
  if (tagged.peeled !== record.sha) {
    throw new Refusal(`origin's ${record.tag} is not annotated on the recorded ${record.sha}`);
  }
  const appears = Date.now() + runAppearsMs;
  let id: number | null = null;
  while (id === null) {
    const rows = await ghJson(
      [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        WORKFLOW,
        "--event",
        "push",
        "--branch",
        record.tag,
        "--json",
        "databaseId,headSha,headBranch",
      ],
      root,
      v.array(RunRow),
    );
    id = rows.find((row) => row.headBranch === record.tag && row.headSha === record.sha)?.databaseId ?? null;
    if (id === null) {
      if (Date.now() >= appears) {
        throw new Refusal(
          `no run of ${WORKFLOW} for the push of ${record.tag} at ${record.sha} within ${duration(runAppearsMs)}`,
        );
      }
      await sleep(pollMs);
    }
  }
  print(`first-deploy: following the release workflow's run ${id}`);
  const deadline = Date.now() + followMs;
  const reported = new Set<string>();
  for (;;) {
    const view = await ghJson(
      ["run", "view", String(id), "--repo", repository, "--json", "status,conclusion,jobs"],
      root,
      RunView,
    );
    for (const job of view.jobs) {
      if (job.status === "completed" && !reported.has(job.name)) {
        reported.add(job.name);
        print(`first-deploy: ${job.name}: ${job.conclusion ?? "no conclusion"}`);
      }
    }
    if (view.status === "completed") {
      if (view.conclusion !== "success") {
        throw new Refusal(
          `the release workflow's run ${id} concluded ${view.conclusion ?? "without a conclusion"}: re-run its failed jobs (docs/operations.md, Releases), then first-deploy --from release`,
        );
      }
      break;
    }
    if (Date.now() + pollMs >= deadline) {
      throw new Refusal(
        `the release workflow's run ${id} did not finish within ${duration(followMs)}: first-deploy --from release follows it again`,
      );
    }
    await sleep(pollMs);
  }
  if (!(await published(record))) {
    throw new Refusal(
      `the run succeeded, but ${record.tag} is not published, immutable, with its three archives and nothing besides`,
    );
  }
  print(`first-deploy: ${record.tag} is published with its three archives`);
}

async function bootstrapStep(record: Run): Promise<void> {
  if (record.data.secretsPut !== null) {
    print(
      "first-deploy: bootstrap: skipped (the secrets are on the Worker, whose versions are no longer the bootstrap's)",
    );
    return;
  }
  const { accountId } = await readTarget();
  let found = await bootstrapRecord(accountId);
  if (found !== null && found.subdomain !== null) {
    print(`first-deploy: the bootstrap's record of ${found.versionId}: checking its addresses`);
  } else {
    // No record: the bootstrap, and when it fails (its version live, or no subdomain recorded), its --resume, which
    // accepts only a live version tagged prq-bootstrap. A record without a subdomain: --resume alone.
    const first =
      found === null
        ? await foreground("deploy --bootstrap", serverCommand("deploy", ["--bootstrap"], record.root))
        : 1;
    if (first !== 0) {
      print("first-deploy: the bootstrap did not finish: resuming it over a live bootstrap version");
      const resumed = await foreground(
        "deploy --bootstrap --resume",
        serverCommand("deploy", ["--bootstrap", "--resume"], record.root),
      );
      if (resumed !== 0) {
        throw childFailed(
          "deploy --bootstrap --resume",
          resumed,
          "fix what it names, then first-deploy --from bootstrap",
        );
      }
    }
    found = await bootstrapRecord(accountId);
    if (found === null) {
      throw new Refusal("the bootstrap left no record of the account");
    }
  }
  await record.check("bootstrap", CHECKOUT_CLI, "endpoints", endpointsArgs(found, true));
}

const STATUS_LINES = ["missing: none", "not expected: none"];

async function secretsStep(record: Run): Promise<void> {
  if (record.data.secretsPut === null) {
    for (let attempt = 1; ; attempt++) {
      const code = await foreground("secrets put", serverCommand("secrets", ["put"], record.root));
      if (code === 0) {
        break;
      }
      if (code !== 2 || attempt >= 3) {
        throw childFailed(
          "secrets put",
          code,
          code === 2
            ? "the Worker's secrets are unconfirmed: first-deploy --from secrets puts the intended set again"
            : "fix what it names, then first-deploy --from secrets",
        );
      }
      printError("first-deploy: the secrets' write was not acknowledged: putting the intended set again");
    }
    record.data.secretsPut = new Date().toISOString();
    await record.save();
  } else {
    print(`first-deploy: secrets put was acknowledged at ${record.data.secretsPut}: reading the Worker's secrets`);
  }
  const child = serverCommand("secrets", ["status"], record.root);
  const status = await call("secrets status", child.program, child.args, child.cwd);
  for (const line of status.stdout.split("\n").filter((each) => each !== "")) {
    print(line);
  }
  if (status.code !== 0) {
    throw new Refusal(
      `secrets status exited ${status.code ?? "by a signal"}: first-deploy --from secrets reads it again`,
    );
  }
  const lines = status.stdout.split("\n").map((line) => line.replace(/^secrets: /, "").trim());
  if (!STATUS_LINES.every((line) => lines.includes(line))) {
    // The set the put sent is not what the Worker holds: the next run puts it again.
    record.data.secretsPut = null;
    await record.save();
    throw new Refusal(
      "secrets status does not list all ten required and nothing besides: first-deploy --from secrets puts them again",
    );
  }
}

// The step after a read-back or a deploy that did not complete: the deploy's own read-back.
const readBackNext = (dir: string): string =>
  `the next step is the deploy's read-back, pnpm --dir packages/server run deploy -- --read-back ${dir}, which first-deploy --from deploy runs; it says when to deploy again`;

// Whether a deploy's upload began, which only a read-back of its record then settles.
const uploadStarted = (found: DeployRecord): boolean => found.upload !== null || found.outcome === "uploading";

async function deployStep(record: Run): Promise<void> {
  const tag = record.tag;
  const adopt = async (found: DeployRecord) => {
    record.data.deployRecord = found.dir;
    await record.save();
    print(`first-deploy: the deploy's record: ${found.dir}`);
  };
  let found = await releaseRecord(record);
  if (found !== null && found.readBack?.state !== "complete" && uploadStarted(found)) {
    await adopt(found);
    const started = Date.now();
    const code = await foreground(
      "deploy --read-back",
      serverCommand("deploy", ["--read-back", found.dir], record.root),
    );
    const dir = found.dir;
    found = await releaseRecord(record);
    if (found?.dir !== dir) {
      throw new Refusal(`the deploy's record ${dir} is gone`);
    }
    // Only this read-back's own verdict, written after it started, decides: complete with exit 0, or another upload
    // with exit 2 when it says the upload did not finish (it says so only once it read what is live).
    const verdict = found.readBack !== null && Date.parse(found.readBack.at) >= started ? found.readBack : null;
    const complete = code === 0 && verdict?.state === "complete";
    const again = code === 2 && verdict?.reason.startsWith("the upload did not finish") === true;
    if (!complete && !again) {
      throw verdict === null
        ? new Refusal(`deploy --read-back exited ${code} without recording its verdict`, readBackNext(dir))
        : childFailed("deploy --read-back", code === 0 ? 1 : code, readBackNext(dir));
    }
  }
  if (found === null || found.readBack?.state !== "complete") {
    const before = found?.dir ?? null;
    const code = await foreground(`deploy ${tag}`, serverCommand("deploy", [tag], record.root));
    found = await releaseRecord(record);
    if (code !== 0) {
      const made = found !== null && found.dir !== before ? found : null;
      if (made !== null && uploadStarted(made)) {
        await adopt(made);
        throw childFailed(`deploy ${tag}`, code, readBackNext(made.dir));
      }
      // Stopped before the upload (declined, or a check refused): nothing to read back.
      throw childFailed(
        `deploy ${tag}`,
        code,
        `${made === null ? "it recorded nothing" : `it stopped before the upload: ${made.outcome}`}; once what it names is resolved, first-deploy --from deploy runs the deploy again`,
      );
    }
    if (found === null || found.readBack?.state !== "complete") {
      throw new Refusal(`the deploy of ${tag} exited 0, but its record's read-back is not complete`);
    }
  }
  await adopt(found);
}

async function servedStep(record: Run): Promise<void> {
  const { host, accountId } = await readTarget();
  const cli = await cloneCli(record, "served");
  const teamDomain = (await workerValues("ACCESS_TEAM_DOMAIN")).get("ACCESS_TEAM_DOMAIN") ?? "";
  if (record.data.accepted["served:edge"] === undefined) {
    print(
      `first-deploy: sign in at https://${host} with the one-time PIN: the web UI shows ${record.tag}, and the browser's developer tools (Network, WS) show the Hub's WebSocket open with its prq:version message naming ${record.tag}`,
    );
    if (
      !(await answer(`Signed in, and saw ${record.tag} in the page and in the Hub's prq:version? [y/N] `, browserMs))
    ) {
      throw new Refusal("the browser's way through Access is not confirmed: first-deploy --from served asks again");
    }
  }
  await record.check("served", cli, "edge", ["--team-domain", teamDomain], await accessEnv(), confirmToken);
  const bootstrap = await bootstrapRecord(accountId);
  if (bootstrap === null) {
    throw new Refusal("no bootstrap record of the account: first-deploy --from bootstrap");
  }
  await record.check("served", cli, "endpoints", endpointsArgs(bootstrap, false));
}

// A rotated service token's secret, which setup cloudflare records unconfirmed, confirmed once this edge run's ledger
// read (E4) passed with it, whatever else it found. A run that saved nothing confirms nothing.
async function confirmToken(edge: string): Promise<void> {
  const token = v.safeParse(v.looseObject({ confirmed: v.boolean() }), (await readState())["serviceToken"]);
  if (!token.success || token.output.confirmed) {
    return;
  }
  const e4 = ((await readSaved(edge))?.observations ?? []).filter((each) => each.id === "E4");
  if (e4.length > 0 && e4.every((each) => each.verdict === "pass")) {
    await recordState("serviceToken", { ...token.output, confirmed: true, confirmedAt: new Date().toISOString() });
    print("first-deploy: the service token's rotated secret is confirmed by the edge check's E4");
  }
}

// GitHub's REST API as the App: its status and JSON.
async function asApp(
  token: string,
  path: string,
  { method = "GET", body }: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
  let response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "prq-first-deploy",
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(waitMs),
    });
  } catch {
    const what = `${method} ${path.split("?")[0] ?? ""}`;
    throw method === "GET"
      ? new Refusal(`GitHub did not answer ${what}`)
      : new Unconfirmed(
          `GitHub did not answer ${what}: its effect is not known; first-deploy --from webhook sends it again`,
        );
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    // None.
  }
  return { status: response.status, json };
}

const AppAnswer = v.object({ slug: v.string(), events: v.array(v.string()) });
const HookAnswer = v.object({
  url: v.nullish(v.string()),
  content_type: v.nullish(v.string()),
  insecure_ssl: v.nullish(v.string()),
});

async function webhookStep(record: Run): Promise<void> {
  const { host } = await readTarget();
  const values = await workerValues("GITHUB_APP_ID", "WEBHOOK_SECRET");
  const secret = values.get("WEBHOOK_SECRET") ?? "";
  const key = await readPrivate(KEY_FILE);
  hide([secret, key]);
  const token = await appJwt({ appId: values.get("GITHUB_APP_ID") ?? "", key });
  hide([token]);
  const deliveries = async () => {
    const listed = await asApp(token, "/app/hook/deliveries?per_page=100");
    const parsed = v.safeParse(v.array(Delivery), listed.json);
    if (listed.status !== 200 || !parsed.success) {
      throw new Refusal(`GitHub answered GET /app/hook/deliveries with HTTP ${listed.status}`);
    }
    return parsed.output;
  };
  const url = `https://${host}/webhook`;
  const patched = await asApp(token, "/app/hook/config", {
    method: "PATCH",
    body: { url, secret, content_type: "json", insecure_ssl: "0" },
  });
  if (patched.status !== 200) {
    throw new Refusal(`GitHub answered PATCH /app/hook/config with HTTP ${patched.status}`);
  }
  const hook = await asApp(token, "/app/hook/config");
  const config = v.safeParse(HookAnswer, hook.json);
  if (hook.status !== 200 || !config.success) {
    throw new Refusal(`GitHub answered GET /app/hook/config with HTTP ${hook.status}`);
  }
  for (const [field, want] of [
    ["url", url],
    ["content_type", "json"],
    ["insecure_ssl", "0"],
  ] as const) {
    if (config.output[field] !== want) {
      throw new Refusal(`the App's webhook ${field} reads back as another value than was set`);
    }
  }
  print(`first-deploy: the App's webhook: ${url}, its secret from ${WORKER_ENV}, JSON, SSL verification on`);
  // What was delivered before the update read back proves nothing of it: those listed now, and any delivered earlier.
  const updated = Date.now();
  const before = new Set((await deliveries()).map((each) => each.id));
  const app = async () => {
    const read = await asApp(token, "/app");
    const parsed = v.safeParse(AppAnswer, read.json);
    if (read.status !== 200 || !parsed.success) {
      throw new Refusal(`GitHub answered GET /app with HTTP ${read.status}`);
    }
    return parsed.output;
  };
  const { slug } = await app();
  print(`first-deploy: in ${GITHUB_WEB}/settings/apps/${slug}, tick Active under Webhook and click Save changes`);
  if (!(await answer("Saved with Active ticked? [y/N] ", browserMs))) {
    throw new Refusal("the webhook is not active: first-deploy --from webhook asks again");
  }
  for (let round = 0; !(await app()).events.includes("pull_request"); round++) {
    if (round >= 2) {
      throw new Refusal("the App does not subscribe to the Pull request event");
    }
    print(
      `first-deploy: the App does not subscribe to the Pull request event: in ${GITHUB_WEB}/settings/apps/${slug}/permissions, tick Pull request under Subscribe to events and save`,
    );
    if (!(await answer("Saved with Pull request ticked? [y/N] ", browserMs))) {
      throw new Refusal("the App does not subscribe to the Pull request event");
    }
  }
  print("first-deploy: the App subscribes to the Pull request event");
  // GitHub's ping when the hook turns active: answered 200 only when the URL, Access's bypass and the secret are right.
  const deadline = Date.now() + pingMs;
  for (;;) {
    const ping = (await deliveries()).find(
      (each) => each.event === "ping" && !before.has(each.id) && Date.parse(each.delivered_at) >= updated,
    );
    if (ping !== undefined) {
      if (ping.status_code !== 200) {
        throw new Refusal(
          `GitHub's ping got HTTP ${ping.status_code}${ping.status_code === 401 ? " (the secret differs from the Worker's WEBHOOK_SECRET)" : ""}: see the App's Recent deliveries`,
        );
      }
      record.data.webhook = "pass";
      print("first-deploy: GitHub's ping was answered 200");
      break;
    }
    if (Date.now() + pollMs >= deadline) {
      record.data.webhook = "unexercised";
      print(`first-deploy: no ping within ${duration(pingMs)}: unexercised; the summary's pull request decides`);
      break;
    }
    await sleep(pollMs);
  }
  await record.save();
}

async function poolStep(record: Run): Promise<void> {
  print(
    "first-deploy: stop every prq wait first: the cloud agent owns a new pull request only while the pool is empty",
  );
  await record.check("pool", await cloneCli(record, "pool"), "pool", [], await accessEnv());
}

const PrRow = v.object({
  number: v.number(),
  headRefOid: v.string(),
  state: v.string(),
  author: v.object({ login: v.string() }),
});

// A check that runs while this process asks: its output shown line by line, its stdin none, onLine called with each.
async function streamed(name: string, child: Child, onLine: (line: string) => Promise<void>): Promise<number> {
  print(`first-deploy: running ${name}`);
  const proc = spawn(child.program, child.args, {
    cwd: child.cwd,
    env: child.env,
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
  });
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (proc.pid !== undefined) {
        process.kill(-proc.pid, signal);
      }
    } catch {
      // It has ended.
    }
  };
  const onExit = () => kill("SIGKILL");
  process.once("exit", onExit);
  onInterrupt(async (signal) => {
    kill(signal);
  });
  const timer = setTimeout(() => kill("SIGTERM"), commandMs);
  let pending = "";
  let handling = Promise.resolve();
  proc.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      print(line);
      handling = handling.then(() => onLine(line)).catch(() => kill("SIGTERM"));
    }
  });
  try {
    const code = await new Promise<number>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (exit) => resolve(exit ?? 1));
    });
    await handling;
    return code;
  } catch {
    throw new Refusal(`${name} could not start`);
  } finally {
    clearTimeout(timer);
    onInterrupt(null);
    process.off("exit", onExit);
  }
}

// The test pull request's branch with a one-line file, and the pull request, each made only when missing.
async function openTestPr(record: Run, repository: string, branch: string): Promise<number> {
  const root = record.root;
  const repo = await ghJson(["api", `repos/${repository}`], root, v.object({ default_branch: v.string() }));
  const base = repo.default_branch;
  const head = await ghJson(
    ["api", `repos/${repository}/git/ref/heads/${base}`],
    root,
    v.object({ object: v.object({ sha: v.string() }) }),
  );
  const branchRef = await gh(
    [
      "api",
      "--method",
      "POST",
      `repos/${repository}/git/refs`,
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${head.object.sha}`,
    ],
    root,
  );
  if (branchRef.code !== 0 && !/Reference already exists|HTTP 422/.test(branchRef.stderr)) {
    throw new Refusal(`gh could not make the branch ${branch} (exit ${branchRef.code ?? "by a signal"})`);
  }
  const path = `${branch}.md`;
  const content = Buffer.from(`The first deploy of prq ${record.tag} summarizes this pull request.\n`).toString(
    "base64",
  );
  const file = await gh(
    [
      "api",
      "--method",
      "PUT",
      `repos/${repository}/contents/${path}`,
      "-f",
      `message=test: the first deploy's pull request for ${record.tag}`,
      "-f",
      `content=${content}`,
      "-f",
      `branch=${branch}`,
    ],
    root,
  );
  if (file.code !== 0 && !/HTTP 422/.test(file.stderr)) {
    throw new Refusal(`gh could not add ${path} to ${branch} (exit ${file.code ?? "by a signal"})`);
  }
  const created = await gh(
    [
      "pr",
      "create",
      "--repo",
      repository,
      "--head",
      branch,
      "--base",
      base,
      "--title",
      `prq first deploy ${record.tag}`,
      "--body",
      "The pull request the first deploy's summary check takes.",
    ],
    root,
  );
  const number = /\/pull\/([1-9][0-9]*)\s*$/.exec(created.stdout.trim())?.[1];
  if (created.code !== 0 || number === undefined) {
    throw new Refusal(
      `gh pr create failed (exit ${created.code ?? "by a signal"}): first-deploy --from summary finds the branch's pull request`,
    );
  }
  return Number(number);
}

// The next branch for a test pull request once the one before was closed: -2, -3, and on.
function nextBranch(branch: string, base: string): string {
  const n = branch === base ? 1 : Number(branch.slice(base.length + 1));
  return `${base}-${n + 1}`;
}

async function summaryStep(record: Run): Promise<void> {
  const root = record.root;
  const cli = await cloneCli(record, "summary");
  const env = await accessEnv();
  const repository = await testRepository();
  const base = `prq-first-deploy-${record.tag}`;
  // The pull request's identity, recorded before anything is made.
  if (record.data.testPr === null || record.data.testPr.repository !== repository) {
    record.data.testPr = { repository, branch: base, number: null };
    await record.save();
  }
  const testPr = record.data.testPr;
  const hostId = (await workerValues("HOST_GITHUB_ID")).get("HOST_GITHUB_ID");
  const user = await ghJson(["api", "user"], root, v.object({ id: v.number(), login: v.string() }));
  if (String(user.id) !== hostId) {
    throw new Refusal(
      `gh is logged in as another account than HOST_GITHUB_ID's, whose pull requests alone the Worker takes`,
    );
  }
  // The open pull request of the recorded branch; a branch whose pull requests are all closed gives way to the next.
  let open: v.InferOutput<typeof PrRow> | undefined;
  for (;;) {
    const rows = await ghJson(
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--head",
        testPr.branch,
        "--state",
        "all",
        "--json",
        "number,headRefOid,state,author",
      ],
      root,
      v.array(PrRow),
    );
    open = rows.find((row) => row.state === "OPEN");
    if (open !== undefined || rows.length === 0) {
      if (rows.length === 0 && testPr.number !== null) {
        testPr.number = null;
        await record.save();
      }
      break;
    }
    testPr.branch = nextBranch(testPr.branch, base);
    testPr.number = null;
    await record.save();
    print(`first-deploy: the test pull request was closed: the next is opened on ${testPr.branch}`);
  }
  if (open !== undefined) {
    const pr = open;
    const name = `${repository}#${pr.number}`;
    if (pr.author.login !== user.login) {
      throw new Refusal(
        `${name} on ${testPr.branch} was opened by another account than HOST_GITHUB_ID's: close it, then first-deploy --from summary opens another`,
      );
    }
    testPr.number = pr.number;
    await record.save();
    print(`first-deploy: the test pull request ${name} exists: reading its jobs`);
    const file = await record.checkFile("summary", "jobs");
    const code = await foreground("check:deployed jobs", deployedCheck(cli, ["jobs", name, "--json", file], env));
    await record.accept("summary", "jobs", file, code, ({ notes }) => {
      if (!notes.some((note) => note.startsWith(`${name}: owner cloud,`))) {
        throw new Refusal(
          `the cloud agent does not own ${name}: once the pool is empty, close it, then first-deploy --from summary opens another`,
        );
      }
      if (!notes.some((note) => note.includes(` analysis of ${pr.headRefOid}: done,`))) {
        throw new Refusal(
          `the analysis of ${name} at ${pr.headRefOid} is not done: follow it with check:deployed jobs (retry a failed one), then first-deploy --from summary`,
        );
      }
      // The cloud agent's ownership and the analysis of the head.
      return 2;
    });
    print(`first-deploy: the analysis of ${name} at its head is done`);
    return;
  }
  const file = await record.checkFile("summary", "summary");
  let declined = false;
  const code = await streamed(
    "check:deployed summary",
    deployedCheck(cli, ["summary", repository, "--json", file], env),
    async (line) => {
      if (!line.includes(`open a new pull request in ${repository}`) || testPr.number !== null || declined) {
        return;
      }
      if (!(await answer(`Open the test pull request (${testPr.branch}) in ${repository}? [y/N] `, browserMs))) {
        declined = true;
        throw new Refusal("declined");
      }
      testPr.number = await openTestPr(record, repository, testPr.branch);
      await record.save();
      print(`first-deploy: opened ${repository}#${testPr.number}`);
    },
  );
  if (declined) {
    throw new Refusal("no test pull request was opened");
  }
  const name = `${repository}#${testPr.number ?? "?"}`;
  await record.accept("summary", "summary", file, code, ({ observations }) => {
    if (!observations.some((each) => each.what === `the owner of ${name}` && each.verdict === "pass")) {
      throw new Refusal(`check:deployed summary took another pull request than the test pull request ${name}`);
    }
    return 0;
  });
}

async function askStep(record: Run): Promise<void> {
  const testPr = record.data.testPr;
  if (testPr === null || testPr.number === null) {
    throw new Refusal("no test pull request is recorded: first-deploy --from summary");
  }
  const name = `${testPr.repository}#${testPr.number}`;
  const cli = await cloneCli(record, "ask");
  const env = await accessEnv();
  const teamDomain = (await workerValues("ACCESS_TEAM_DOMAIN")).get("ACCESS_TEAM_DOMAIN") ?? "";
  await record.check("ask", cli, "ask", [name, QUESTION], env);
  await record.check("ask", cli, "edge", ["--team-domain", teamDomain, "--pr", name], env);
}

// The saved runs' paths for the owner, then the accepted verdicts and the ping's, which hold no deployment value,
// version or path: what can be copied to the first deploy's issue and docs/spikes.md.
async function reportStep(record: Run): Promise<void> {
  const accepted = Object.values(record.data.accepted);
  print("first-deploy: the accepted checks' saved runs (yours alone):");
  for (const each of accepted) {
    print(`  ${each.step} ${each.mode}: ${each.file}`);
  }
  print("first-deploy: report");
  for (const each of accepted) {
    print(`  ${each.step}: check:deployed ${each.mode}: ${each.verdicts}`);
  }
  print(`  webhook: the ping ${record.data.webhook ?? "not read"}`);
}

const RUNS: Readonly<Record<Step, (record: Run) => Promise<void>>> = {
  preflight,
  "release-sha": releaseSha,
  "pre-tag": preTag,
  tag: tagStep,
  release: releaseStep,
  bootstrap: bootstrapStep,
  secrets: secretsStep,
  deploy: deployStep,
  served: servedStep,
  webhook: webhookStep,
  pool: poolStep,
  summary: summaryStep,
  ask: askStep,
  report: reportStep,
};

function fresh(args: Args, repository: string): Progress {
  return {
    mode: args.mode,
    releasePr: args.mode === "create" ? args.pr : null,
    repository,
    tag: args.mode === "tag" ? args.tag : null,
    sha: null,
    done: {},
    secretsPut: null,
    deployRecord: null,
    testPr: null,
    webhook: null,
    accepted: {},
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  refuseOverrides();
  notInCi(CI_REASON);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Refusal("first-deploy runs in a terminal, where the deploy and its other commands ask");
  }
  const { root, repository } = await checkout();
  const found = await readProgress();
  const same =
    found !== null &&
    found.mode === args.mode &&
    found.repository === repository &&
    (args.mode === "tag" ? found.tag === args.tag : found.releasePr === args.pr);
  if (found !== null && !same && args.from !== "preflight") {
    throw new Refusal(
      `the state records the first deploy of ${found.tag ?? `pull request #${found.releasePr ?? "?"}`} (${found.repository}): first-deploy --from preflight starts this one over`,
    );
  }
  const record = new Run(root, args, same && args.from !== "preflight" ? found : fresh(args, repository));
  if (same && args.from === "preflight") {
    // Starting over keeps the acknowledged write the bootstrap and the secrets depend on.
    record.data.secretsPut = found.secretsPut;
  }
  const start =
    args.from === null ? STEPS.findIndex((step) => record.data.done[step] === undefined) : STEPS.indexOf(args.from);
  const rerun = STEPS.slice(start === -1 ? STEPS.length : start);
  for (const step of rerun) {
    delete record.data.done[step];
  }
  if (args.from !== null) {
    // A step run again runs its checks again.
    for (const [key, each] of Object.entries(record.data.accepted)) {
      if (isStep(each.step) && rerun.includes(each.step)) {
        delete record.data.accepted[key];
      }
    }
  }
  await record.save();
  for (const [index, step] of STEPS.entries()) {
    if (record.data.done[step] !== undefined) {
      print(`${step}: done (recorded)`);
      continue;
    }
    if (args.mode === "tag" && CREATE_ONLY.includes(step)) {
      print(`${step}: skipped (--tag: the tag exists)`);
    } else {
      print(`${step}: ${index + 1}/${STEPS.length}`);
      try {
        await RUNS[step](record);
      } catch (error) {
        if (error instanceof Refusal) {
          throw new (error instanceof Unconfirmed ? Unconfirmed : Refusal)(
            `${step}: ${error.lines[0] ?? "stopped"}`,
            ...error.lines.slice(1),
            `once fixed, first-deploy ${args.mode === "tag" ? `--tag ${args.tag}` : `--create-tag --release-pr ${args.pr}`} resumes at ${step}`,
          );
        }
        throw error;
      }
    }
    record.data.done[step] = new Date().toISOString();
    await record.save();
  }
  print("first-deploy: done");
}

// A "--" before the arguments (as some package managers pass it) is not an argument.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
await runCommand("first-deploy", () => main(args));
