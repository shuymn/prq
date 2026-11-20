// The setup (`pnpm run setup [<step>]` in packages/server). Without a step it runs the host's steps in order
// (setup-host.ts); the publisher's steps, `repository` and `rehearsal`, run only when named. What each checks, asks and
// records, and its exit codes, are docs/operations.md's (Setup, and First deploy, step 1). Every program runs as
// operations.ts runs it, with a bound on its time; the publisher's gh-infra in the foreground, where it asks.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";

import { fixture } from "./fixture.ts";
import {
  answer,
  answerOf,
  exited,
  mode,
  notInCi,
  type Outcome,
  print,
  printError,
  refuseOverrides,
  Refusal,
  run,
  runCommand,
  stateRoot,
  Unconfirmed,
  waitMs,
} from "./operations.ts";
import { GITHUB } from "./release-check.ts";
import { HOST_STEPS, type HostStep, hostStep, NEEDS as HOST_NEEDS } from "./setup-host.ts";

const PUBLISHER_STEPS = ["repository", "rehearsal"] as const;
const STEPS = [...PUBLISHER_STEPS, ...HOST_STEPS] as const;
type Step = (typeof STEPS)[number];
type PublisherStep = (typeof PUBLISHER_STEPS)[number];
const USAGE = `usage: setup [${STEPS.join(" | ")}]`;
const CI_REASON =
  "where nobody answers gh-infra's confirmation or this command's: run setup from a terminal of your own";

const INFRA = ".github/infra.yaml";
const WORKFLOW = "release.yml";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW}`;
// The release workflow's jobs a rehearsal requires, each concluding success (.github/workflows/release.yml).
const SMOKE_TARGETS = ["darwin-arm64", "linux-x64", "linux-arm64"];
const READ_PROBE = "Read probe";
const REQUIRED_JOBS = [...SMOKE_TARGETS.map((target) => `Smoke (${target})`), READ_PROBE, "Discard the rehearsal"];
// GitHub's repository role ID of the admin role, as a ruleset's bypass_actors names it.
const ADMIN_ROLE = 5;
// The release tag rulesets as .github/infra.yaml declares them.
const TAG_RULESETS = [
  { name: "release-tag-creation", rules: ["creation"], bypass: [`RepositoryRole ${ADMIN_ROLE} always`] },
  { name: "release-tag-immutability", rules: ["deletion", "update"], bypass: [] },
] as const;
const ATTEST = "actions/attest@*";
// What gh's login takes for each step besides the admin role, and for each call that can be denied.
const ADMINISTRATION_READ = "Administration: read";
const ADMINISTRATION_WRITE = "Administration: write";
const ACTIONS_WRITE = "Actions: write";
const CHECKS_READ = "Checks: read";
const CONTENTS_WRITE = "Contents: write";
// gh-infra creates and updates the labels .github/infra.yaml declares, which takes Issues or Pull requests write.
const LABELS_WRITE = "Issues: write (or Pull requests: write, for the labels)";
const NEEDS: Record<PublisherStep, string> = {
  repository: `${ADMINISTRATION_WRITE} and ${LABELS_WRITE}`,
  rehearsal: `${ADMINISTRATION_READ}, ${ACTIONS_WRITE}, ${CHECKS_READ} and ${CONTENTS_WRITE}`,
};
// How many reads of the run in a row may fail before the follow stops.
const VIEW_FAILURES = 3;
// A run of a dispatch whose ID was lost is looked for from this long before the dispatch was recorded (the clocks of
// this machine and GitHub's differ).
const CLOCK_SKEW_MS = 60_000;
const STATE_FILE = "setup.json";

// Only the tests' fixture sets the programs run in gh's and gh-infra's place, the state directory, or shorter bounds.
const ghProgram = fixture.gh ?? "gh";
const ghInfraCommand: [string, string[]] =
  fixture.ghInfra === undefined ? ["mise", ["exec", "--", "gh-infra"]] : [fixture.ghInfra, []];
// gh-infra's apply waits for the owner to read its plan and confirm it.
const applyMs = fixture.stepMs ?? 30 * 60_000;
const pollMs = fixture.pollMs ?? 15_000;
// The rehearsal's run is followed this long.
const followMs = fixture.followMs ?? 60 * 60_000;
const stateDirectory = fixture.stateDir ?? join(stateRoot(), "prq");

function duration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A program's environment: this process's, which holds gh's login, and (in the tests) what their stand-ins read.
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...fixture.childEnv };
}

type CallOptions = { output?: "keep" | "show"; foreground?: boolean; timeoutMs?: number };

// A program in cwd within its bound, refused when it cannot start or does not finish.
async function call(
  name: string,
  program: string,
  args: readonly string[],
  cwd: string,
  { output = "keep", foreground = false, timeoutMs = waitMs }: CallOptions = {},
): Promise<Outcome> {
  const outcome = await run(name, program, args, { cwd, env: childEnv(), output, foreground, timeoutMs });
  if (outcome.timedOut) {
    throw new Refusal(`${name} did not finish within ${duration(timeoutMs)} and was stopped`);
  }
  return outcome;
}

// What a failed call printed on stderr, then the reason, and the permission gh's login needs for it when GitHub
// answered 403 or 404 (a token without a permission can get either).
function failure(name: string, outcome: Outcome, permission?: string): Refusal {
  for (const line of outcome.stderr.split("\n")) {
    if (line.trim() !== "") {
      printError(`  ${line.trim()}`);
    }
  }
  const denied = permission !== undefined && /HTTP 40[34]/.test(outcome.stderr);
  return new Refusal(
    `${name} failed (${exited(outcome)})${denied ? `: it takes ${permission} on the repository for gh's login` : ""}`,
  );
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const outcome = await call(`git ${args[0] ?? ""}`, "git", args, cwd);
  if (outcome.code !== 0) {
    throw failure(`git ${args[0] ?? ""}`, outcome);
  }
  return outcome.stdout.trim();
}

function gh(args: readonly string[], cwd: string, timeoutMs = waitMs): Promise<Outcome> {
  return call(`gh ${args[0] ?? ""}`, ghProgram, args, cwd, { timeoutMs });
}

// A gh api read that answers JSON: `gh api <args>`.
async function ghApi<S extends v.GenericSchema>(
  args: readonly string[],
  cwd: string,
  schema: S,
  permission?: string,
): Promise<v.InferOutput<S>> {
  const outcome = await gh(["api", ...args], cwd);
  if (outcome.code !== 0) {
    throw failure("gh api", outcome, permission);
  }
  return answerOf("gh api", schema, outcome.stdout);
}

// A question the owner answers on the terminal: refused without one, as gh-infra's own is.
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Refusal("setup asks the owner on a terminal: run it from one");
  }
  return answer(question);
}

type Checkout = { root: string; repository: string; sha: string };

// The repository .github/infra.yaml declares (metadata.owner and metadata.name), from its own lines.
function declared(text: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === "metadata:");
  const fields = new Map<string, string>();
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    if (!line.startsWith(" ")) {
      break;
    }
    const match = /^ {2}(name|owner):\s*["']?([\w.-]+)["']?\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      fields.set(match[1], match[2]);
    }
  }
  const owner = fields.get("owner");
  const name = fields.get("name");
  return owner === undefined || name === undefined ? null : `${owner}/${name}`;
}

// .github/infra.yaml as it is on disk, which gh-infra reads, refused unless it is byte for byte main's as fetched: a
// file the index marks skip-worktree or assume-unchanged hides its edits from git status.
async function mainsInfra(root: string): Promise<string> {
  let text;
  try {
    text = await readFile(join(root, INFRA), "utf8");
  } catch {
    throw new Refusal(`the checkout has no ${INFRA}`);
  }
  const shown = await call("git show", "git", ["show", "--end-of-options", `refs/remotes/origin/main:${INFRA}`], root);
  if (shown.code !== 0) {
    throw failure("git show", shown);
  }
  if (shown.stdout !== text) {
    throw new Refusal(`${INFRA} differs from main's: the settings applied are main's (git restore ${INFRA})`);
  }
  return text;
}

// origin's main as a fetch finds it now, by its own refspec, whatever origin's fetch configuration holds.
async function fetchMain(root: string): Promise<string> {
  await git(root, ["fetch", "--quiet", "--end-of-options", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  return git(root, ["rev-parse", "--verify", "--end-of-options", "refs/remotes/origin/main"]);
}

// The checkout this runs in: origin is the GitHub repository .github/infra.yaml declares, HEAD is origin's main as
// fetched now, and .github/infra.yaml is main's.
async function checkout(): Promise<Checkout> {
  const root = await git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const url = (await call("git config", "git", ["config", "--get", "remote.origin.url"], root)).stdout.trim();
  const match = GITHUB.exec(url);
  if (match === null) {
    throw new Refusal("origin is not a GitHub repository");
  }
  const repository = `${match[1]}/${match[2]}`;
  const head = await git(root, ["rev-parse", "--verify", "HEAD"]);
  const originMain = await fetchMain(root);
  if (head !== originMain) {
    throw new Refusal(
      `HEAD is ${head}, not origin's main (${originMain}): run setup from a checkout of main (git switch main, then git pull)`,
    );
  }
  const named = declared(await mainsInfra(root));
  if (named !== repository) {
    throw new Refusal(`${INFRA} declares ${named ?? "no repository"}, not ${repository}, origin's`);
  }
  print(`setup: ${repository} at origin's main (${head})`);
  return { root, repository, sha: head };
}

const RepositoryAnswer = v.object({ permissions: v.nullish(v.object({ admin: v.nullish(v.boolean()) })) });

// gh is logged in, as an admin of the repository. A fine-grained token's own permissions are not readable: each call
// GitHub denies names the one it takes.
async function ghAdmin({ root, repository }: Checkout, step: PublisherStep): Promise<void> {
  // gh auth status prints the login's account and a part of its token: none of it is printed.
  if ((await gh(["auth", "status"], root)).code !== 0) {
    throw new Refusal("gh is not logged in: gh auth login");
  }
  const repo = await ghApi([`repos/${repository}`], root, RepositoryAnswer);
  if (repo.permissions?.admin !== true) {
    throw new Refusal(
      `gh's login is not an admin of ${repository}: setup ${step} takes the admin role and ${NEEDS[step]}`,
    );
  }
}

function ghInfra(args: readonly string[], root: string, options: CallOptions): Promise<Outcome> {
  const [program, base] = ghInfraCommand;
  return call(`gh-infra ${args[0] ?? ""}`, program, [...base, ...args], root, options);
}

// gh-infra's plan of main's .github/infra.yaml, shown: whether it finds changes (its exit 2) or none (0).
async function planned(root: string): Promise<boolean> {
  await mainsInfra(root);
  const outcome = await ghInfra(["plan", "--detailed-exitcode", INFRA], root, { output: "show" });
  if (outcome.code === 0 || outcome.code === 2) {
    return outcome.code === 2;
  }
  throw new Refusal(`gh-infra plan failed (${exited(outcome)})`);
}

const RulesetList = v.array(v.object({ id: v.number(), name: v.string() }));
const Ruleset = v.object({
  target: v.nullish(v.string()),
  enforcement: v.string(),
  bypass_actors: v.nullish(
    v.array(v.object({ actor_id: v.nullish(v.number()), actor_type: v.string(), bypass_mode: v.nullish(v.string()) })),
  ),
  conditions: v.nullish(
    v.object({
      ref_name: v.nullish(
        v.object({ include: v.nullish(v.array(v.string())), exclude: v.nullish(v.array(v.string())) }),
      ),
    }),
  ),
  rules: v.nullish(v.array(v.object({ type: v.string() }))),
});
const SelectedActions = v.object({ patterns_allowed: v.nullish(v.array(v.string())) });
const ImmutableReleases = v.object({ enabled: v.boolean() });

function list(values: readonly string[]): string {
  return `[${values.join(", ")}]`;
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return list(a.toSorted()) === list(b.toSorted());
}

// Each field of a release tag ruleset that is not as .github/infra.yaml declares it.
function rulesetIssues(found: v.InferOutput<typeof Ruleset>, expected: (typeof TAG_RULESETS)[number]): string[] {
  const issues: string[] = [];
  if (found.target !== "tag") {
    issues.push(`target is ${found.target ?? "none"}, not tag`);
  }
  if (found.enforcement !== "active") {
    issues.push(`enforcement is ${found.enforcement}, not active`);
  }
  const include = found.conditions?.ref_name?.include ?? [];
  const exclude = found.conditions?.ref_name?.exclude ?? [];
  if (!same(include, ["refs/tags/v*"])) {
    issues.push(`its refs include ${list(include)}, not [refs/tags/v*] alone`);
  }
  if (exclude.length > 0) {
    issues.push(`its refs exclude ${list(exclude)}`);
  }
  const rules = (found.rules ?? []).map((rule) => rule.type);
  if (!same(rules, expected.rules)) {
    issues.push(`its rules are ${list(rules)}, not ${list(expected.rules)}`);
  }
  // GitHub leaves bypass_actors out for a login without write access: unreadable, not none.
  if (found.bypass_actors === undefined || found.bypass_actors === null) {
    issues.push("its bypass is not readable with gh's login, which takes write access to the repository");
    return issues;
  }
  const bypass = found.bypass_actors.map(
    (actor) => `${actor.actor_type} ${actor.actor_id ?? "none"} ${actor.bypass_mode ?? "none"}`,
  );
  if (!same(bypass, expected.bypass)) {
    issues.push(
      `its bypass is ${list(bypass)}, not ${expected.bypass.length === 0 ? "none" : "the admin role alone, always"}`,
    );
  }
  return issues;
}

// The release settings as GitHub reports them: the two tag rulesets, the actions allowlist's attest, and immutable
// releases. Each prints a pass line; any other is a refusal naming each field that differs.
async function readBack({ root, repository }: Checkout): Promise<void> {
  const issues: string[] = [];
  const check = (name: string, found: string[]) => {
    if (found.length === 0) {
      print(`repository: ${name}: pass`);
    }
    issues.push(...found.map((issue) => `${name}: ${issue}`));
  };
  const rulesets = await ghApi([`repos/${repository}/rulesets?per_page=100`], root, RulesetList);
  for (const expected of TAG_RULESETS) {
    const matching = rulesets.filter((each) => each.name === expected.name);
    const [only] = matching;
    if (only === undefined || matching.length > 1) {
      check(expected.name, [
        matching.length === 0 ? "there is no such ruleset" : `${matching.length} rulesets have the name`,
      ]);
      continue;
    }
    const found = await ghApi([`repos/${repository}/rulesets/${only.id}`], root, Ruleset);
    check(expected.name, rulesetIssues(found, expected));
  }
  const actions = await ghApi(
    [`repos/${repository}/actions/permissions/selected-actions`],
    root,
    SelectedActions,
    ADMINISTRATION_READ,
  );
  check(
    "selected actions",
    (actions.patterns_allowed ?? []).includes(ATTEST) ? [] : [`the allowed patterns do not include ${ATTEST}`],
  );
  // GitHub answers 404 when the repository's immutable releases are off.
  const immutable = await gh(["api", `repos/${repository}/immutable-releases`], root);
  if (immutable.code !== 0 && !immutable.stderr.includes("HTTP 404")) {
    throw failure("gh api", immutable, ADMINISTRATION_READ);
  }
  const enabled = immutable.code === 0 && answerOf("gh api", ImmutableReleases, immutable.stdout).enabled;
  check("immutable releases", enabled ? [] : ["they are not enabled"]);
  if (issues.length > 0) {
    throw new Refusal(
      ...issues.map((issue) => `repository: ${issue}`),
      `the release settings do not read back as ${INFRA} declares them`,
    );
  }
}

const UNKNOWN_APPLY = "what it changed is not known: run setup repository again, which plans from what GitHub has now";

// The repository step: gh-infra's plan; when it finds changes, its apply with its own confirmation on the terminal
// (a declined or interrupted apply exits 0), then its plan again, which must find none; then the read-back.
async function repositoryStep(where: Checkout): Promise<void> {
  await ghAdmin(where, "repository");
  if (!(await planned(where.root))) {
    print(`repository: gh-infra plans no change to ${INFRA}`);
  } else {
    if (!process.stdin.isTTY) {
      throw new Refusal("gh-infra asks to confirm its apply on a terminal: run setup repository from one");
    }
    await mainsInfra(where.root);
    const applied = await ghInfra(["apply", INFRA], where.root, {
      output: "show",
      foreground: true,
      timeoutMs: applyMs,
    }).catch((error: unknown) => {
      throw error instanceof Refusal ? new Unconfirmed(...error.lines, UNKNOWN_APPLY) : error;
    });
    if (applied.code !== 0) {
      throw new Unconfirmed(`gh-infra apply failed (${exited(applied)})`, UNKNOWN_APPLY);
    }
    if (await planned(where.root)) {
      throw new Refusal(
        "gh-infra still plans changes after its apply, which was declined or left some: run setup repository again",
      );
    }
    print(`repository: applied ${INFRA}; gh-infra plans no change now`);
  }
  await readBack(where);
  print("repository: done");
}

// The rehearsal's record in the state file: a dispatch about to be sent (dispatching), the run gh named for it
// (running, until its drafts are known to be gone), and its outcome once they are (passed or failed).
const Base = { repository: v.string(), sha: v.string() };
const RehearsalRecord = v.variant("outcome", [
  v.object({ ...Base, outcome: v.literal("dispatching"), requestedAt: v.string() }),
  v.object({ ...Base, outcome: v.literal("running"), runId: v.number() }),
  v.object({ ...Base, outcome: v.picklist(["passed", "failed"]), runId: v.number() }),
]);
type RehearsalRecord = v.InferOutput<typeof RehearsalRecord>;
type Running = Extract<RehearsalRecord, { outcome: "running" }>;

// The state directory, the owner's alone and not a symbolic link; made when missing and make is set. Null when it is
// missing.
async function stateDir(make: boolean): Promise<string | null> {
  if (make) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  }
  const info = await lstat(stateDirectory).catch(() => null);
  if (info === null) {
    return null;
  }
  if (!info.isDirectory()) {
    throw new Refusal(`the state directory ${stateDirectory} is not a directory`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Refusal(
      `the state directory ${stateDirectory} is open to others than its owner (mode ${mode(info.mode)}): chmod 700 it`,
    );
  }
  return stateDirectory;
}

// The setup's state file as an object: empty when there is none.
async function readState(): Promise<Record<string, unknown>> {
  const dir = await stateDir(false);
  if (dir === null) {
    return {};
  }
  let handle;
  try {
    handle = await open(join(dir, STATE_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new Refusal(`could not read ${STATE_FILE} in ${dir}`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Refusal(`${STATE_FILE} in ${dir} is not a regular file of the owner's alone`);
    }
    const state: unknown = JSON.parse(await handle.readFile("utf8"));
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      throw new Refusal(`${STATE_FILE} in ${dir} does not hold a JSON object`);
    }
    return { ...state };
  } catch (error) {
    throw error instanceof Refusal ? error : new Refusal(`${STATE_FILE} in ${dir} does not hold JSON`);
  } finally {
    await handle.close();
  }
}

// The state file with key set, the rest kept: written whole beside it (0600, a new file), then renamed over it.
async function recordState(key: string, value: unknown): Promise<void> {
  const state = { ...(await readState()), [key]: value };
  const dir = (await stateDir(true)) ?? stateDirectory;
  const temp = join(dir, `.${STATE_FILE}.${randomBytes(6).toString("hex")}`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await rename(temp, join(dir, STATE_FILE));
}

async function recordRehearsal(record: RehearsalRecord, notice?: string | null): Promise<void> {
  await recordState("rehearsal", {
    ...record,
    ...(notice === undefined ? {} : { notice }),
    recordedAt: new Date().toISOString(),
  });
}

const Workflow = v.object({ id: v.number(), path: v.string() });
const Job = v.object({
  databaseId: v.number(),
  name: v.string(),
  status: v.string(),
  conclusion: v.nullish(v.string()),
});
const RunView = v.object({
  status: v.string(),
  conclusion: v.nullish(v.string()),
  headSha: v.string(),
  headBranch: v.nullish(v.string()),
  event: v.string(),
  workflowDatabaseId: v.number(),
  jobs: v.array(Job),
});
type RunView = v.InferOutput<typeof RunView>;
const RunList = v.array(
  v.object({
    databaseId: v.number(),
    createdAt: v.string(),
    headSha: v.string(),
    headBranch: v.nullish(v.string()),
    workflowDatabaseId: v.number(),
  }),
);
const Annotations = v.array(v.object({ annotation_level: v.nullish(v.string()), message: v.nullish(v.string()) }));
const ReleasePages = v.array(v.array(v.object({ id: v.number(), tag_name: v.string(), draft: v.boolean() })));

// The release workflow's ID, by its path: a run is the rehearsal's only when it is of this workflow, whatever another
// workflow's display name.
async function workflowId({ root, repository }: Checkout): Promise<number> {
  const workflow = await ghApi([`repos/${repository}/actions/workflows/${WORKFLOW}`], root, Workflow);
  if (workflow.path !== WORKFLOW_PATH) {
    throw new Refusal(`GitHub's ${WORKFLOW} is ${workflow.path}, not ${WORKFLOW_PATH}`);
  }
  return workflow.id;
}

// What makes a run the rehearsal's dispatch: the release workflow, dispatched, on main. Its commit is the follow's.
function runIssues(view: RunView, workflow: number): string[] {
  const issues: string[] = [];
  if (view.workflowDatabaseId !== workflow) {
    issues.push(`its workflow is ${view.workflowDatabaseId}, not ${WORKFLOW_PATH} (${workflow})`);
  }
  if (view.event !== "workflow_dispatch") {
    issues.push(`its event is ${view.event}, not workflow_dispatch`);
  }
  if (view.headBranch !== "main") {
    issues.push(`its branch is ${view.headBranch ?? "none"}, not main`);
  }
  return issues;
}

// The run followed until it completes, each job's conclusion printed as it ends, within the bound: each read is
// capped by the time left, and a read that ends past it is not taken as the run's end. Refused when it is not the
// rehearsal's dispatch; returned at once when it runs on another commit than the one recorded.
async function follow(where: Checkout, record: Running, workflow: number): Promise<RunView> {
  const deadline = Date.now() + followMs;
  const late = () =>
    new Refusal(
      `run ${record.runId} did not complete within ${duration(followMs)}; it stays recorded: run setup rehearsal again to follow it`,
    );
  const reported = new Set<number>();
  let failures = 0;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      throw late();
    }
    const outcome = await gh(
      [
        "run",
        "view",
        String(record.runId),
        "--repo",
        where.repository,
        "--json",
        "status,conclusion,headSha,headBranch,event,workflowDatabaseId,jobs",
      ],
      where.root,
      Math.min(waitMs, left),
    ).catch((error: unknown) => {
      throw Date.now() >= deadline ? late() : error;
    });
    if (Date.now() >= deadline) {
      throw late();
    }
    if (outcome.code !== 0) {
      failures += 1;
      if (failures >= VIEW_FAILURES) {
        throw failure(`gh run view (${VIEW_FAILURES} times in a row)`, outcome);
      }
    } else {
      failures = 0;
      const view = answerOf("gh run view", RunView, outcome.stdout);
      const issues = runIssues(view, workflow);
      if (issues.length > 0) {
        await recordRehearsal({ ...record, outcome: "failed" });
        throw new Refusal(
          ...issues.map((issue) => `rehearsal: run ${record.runId}: ${issue}`),
          `run ${record.runId} is not the rehearsal dispatched on main: recorded as failed; run setup rehearsal again`,
        );
      }
      if (view.headSha !== record.sha) {
        return view;
      }
      for (const job of view.jobs) {
        if (job.status === "completed" && !reported.has(job.databaseId)) {
          reported.add(job.databaseId);
          print(`rehearsal: ${job.name}: ${job.conclusion ?? "no conclusion"}`);
        }
      }
      if (view.status === "completed") {
        return view;
      }
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

// The text of a notice in a job's log, as gh prints each line (job, step, a timestamp, then the line).
const LOGGED_NOTICE = /\t\S+Z (?:##\[notice\]|::notice::)(.*)$/;

// The notices of a job's check run, null when they cannot be read (annotations take Checks: read), the call failed,
// or it passed its bound.
async function annotated({ root, repository }: Checkout, jobId: number): Promise<string[] | null> {
  const outcome = await gh(["api", `repos/${repository}/check-runs/${jobId}/annotations`], root).catch(() => null);
  if (outcome?.code !== 0) {
    return null;
  }
  try {
    return answerOf("gh api", Annotations, outcome.stdout)
      .filter((each) => each.annotation_level === "notice")
      .map((each) => each.message ?? "");
  } catch {
    return null;
  }
}

// The notices a job's log holds, empty when it cannot be read, the call failed, or it passed its bound.
async function logged({ root, repository }: Checkout, jobId: number): Promise<string[]> {
  const outcome = await gh(["run", "view", "--job", String(jobId), "--log", "--repo", repository], root).catch(
    () => null,
  );
  if (outcome?.code !== 0) {
    return [];
  }
  return outcome.stdout.split("\n").flatMap((line) => {
    const text = LOGGED_NOTICE.exec(line.trimEnd())?.[1];
    return text === undefined ? [] : [text.trim()];
  });
}

// What the Read probe noted: its check run's notices, else those its log holds; null, reported as unreadable, when
// neither has one. It never stops the step: the run's drafts are checked whatever this found.
async function readProbe(where: Checkout, view: RunView): Promise<string | null> {
  const job = view.jobs.find((each) => each.name === READ_PROBE);
  if (job === undefined) {
    return null;
  }
  let notices = await annotated(where, job.databaseId);
  if (notices === null || notices.length === 0) {
    notices = await logged(where, job.databaseId);
  }
  if (notices.length === 0) {
    print(`rehearsal: ${READ_PROBE}: its notice could not be read`);
    return null;
  }
  for (const notice of notices) {
    print(`rehearsal: ${READ_PROBE} noted: ${notice}`);
  }
  return notices.join("\n");
}

// Whether the run concluded success and each job the rehearsal requires did, each printed.
function verdict(view: RunView): boolean {
  let passed = view.conclusion === "success";
  print(`rehearsal: the run: ${view.conclusion ?? view.status}`);
  for (const name of REQUIRED_JOBS) {
    const job = view.jobs.find((each) => each.name === name);
    const conclusion = job === undefined ? "the run has no such job" : (job.conclusion ?? job.status);
    if (conclusion === "success") {
      print(`rehearsal: ${name}: pass`);
    } else {
      print(`rehearsal: ${name}: fail (${conclusion})`);
      passed = false;
    }
  }
  return passed;
}

// Whether the drafts the run left (tagged rehearsal-<run>) are all gone: each offered for deletion by its ID, then
// read again. A list that fails is a refusal: the run stays recorded, and the next run lists them again.
async function draftsGone({ root, repository }: Checkout, runId: number): Promise<boolean> {
  const tag = `rehearsal-${runId}`;
  const drafts = async () =>
    (
      await ghApi(
        ["--paginate", "--slurp", `repos/${repository}/releases?per_page=100`],
        root,
        ReleasePages,
        CONTENTS_WRITE,
      ).catch((error: unknown) => {
        throw error instanceof Refusal
          ? new Refusal(...error.lines, `run ${runId} stays recorded: run setup rehearsal again to check its drafts`)
          : error;
      })
    )
      .flat()
      .filter((release) => release.draft && release.tag_name === tag);
  const left = await drafts();
  if (left.length === 0) {
    print(`rehearsal: no draft of ${tag} is left`);
    return true;
  }
  let gone = true;
  for (const draft of left) {
    print(`rehearsal: the draft ${draft.id} (${tag}) is left`);
    if (!(await confirm(`Delete the draft ${draft.id}? [y/N] `))) {
      print(`rehearsal: kept the draft ${draft.id}`);
      gone = false;
      continue;
    }
    const deleted = await gh(["api", "--method", "DELETE", `repos/${repository}/releases/${draft.id}`], root);
    if (deleted.code !== 0) {
      throw new Unconfirmed(
        ...failure(`gh api DELETE of the draft ${draft.id}`, deleted, CONTENTS_WRITE).lines,
        "whether it is gone is not known: run setup rehearsal again, which lists the run's drafts",
      );
    }
    if ((await drafts()).some((each) => each.id === draft.id)) {
      throw new Refusal(`GitHub still lists the draft ${draft.id} after its deletion`);
    }
    print(`rehearsal: deleted the draft ${draft.id}`);
  }
  return gone;
}

const UNKNOWN_DISPATCH =
  "a run may have started: run setup rehearsal again, which lists the runs since the dispatch to choose from";

// A dispatch of the release workflow on main, on the owner's yes: recorded as dispatching before it is sent, then as
// the run gh names.
async function dispatch(where: Checkout): Promise<Running> {
  if (!(await confirm(`Dispatch the release rehearsal on main (${where.sha})? [y/N] `))) {
    throw new Refusal("the rehearsal was not dispatched");
  }
  // The dispatch names the branch, not the commit: one that moved since the owner confirmed would be rehearsed instead.
  const mainNow = await fetchMain(where.root);
  if (mainNow !== where.sha) {
    throw new Refusal(
      `origin's main moved to ${mainNow} after ${where.sha} was confirmed, and nothing was dispatched: git pull, then run setup rehearsal again`,
    );
  }
  const { repository, sha } = where;
  await recordRehearsal({ repository, sha, outcome: "dispatching", requestedAt: new Date().toISOString() });
  const dispatched = await gh(["workflow", "run", WORKFLOW, "--ref", "main", "--repo", repository], where.root).catch(
    (error: unknown) => {
      throw error instanceof Refusal ? new Unconfirmed(...error.lines, UNKNOWN_DISPATCH) : error;
    },
  );
  if (dispatched.code !== 0) {
    throw new Unconfirmed(...failure("gh workflow run", dispatched, ACTIONS_WRITE).lines, UNKNOWN_DISPATCH);
  }
  const named = new RegExp(`^https://github\\.com/${repository}/actions/runs/([0-9]+)$`, "m").exec(
    dispatched.stdout,
  )?.[1];
  if (named === undefined) {
    throw new Unconfirmed(
      "gh workflow run did not name the run it started (gh before 2.87.0, or GitHub did not return it)",
      UNKNOWN_DISPATCH,
    );
  }
  const record: Running = { repository, sha, outcome: "running", runId: Number(named) };
  await recordRehearsal(record);
  return record;
}

// A dispatch recorded without its run: the release workflow's dispatched runs on main at its commit, created since,
// each offered to follow; with none taken, a new dispatch on the owner's yes.
async function recover(
  where: Checkout,
  recorded: Extract<RehearsalRecord, { outcome: "dispatching" }>,
  workflow: number,
): Promise<Running> {
  print(`rehearsal: a dispatch on ${recorded.sha} was sent at ${recorded.requestedAt}, and its run was not recorded`);
  const listed = await gh(
    [
      "run",
      "list",
      "--repo",
      where.repository,
      "--workflow",
      WORKFLOW,
      "--event",
      "workflow_dispatch",
      "--branch",
      "main",
      "--commit",
      recorded.sha,
      "--json",
      "databaseId,createdAt,headSha,headBranch,workflowDatabaseId",
      "--limit",
      "20",
    ],
    where.root,
  );
  if (listed.code !== 0) {
    throw failure("gh run list", listed);
  }
  const since = Date.parse(recorded.requestedAt) - CLOCK_SKEW_MS;
  const runs = answerOf("gh run list", RunList, listed.stdout).filter(
    (each) =>
      each.headSha === recorded.sha &&
      each.headBranch === "main" &&
      each.workflowDatabaseId === workflow &&
      Date.parse(each.createdAt) >= since,
  );
  for (const each of runs) {
    if (await confirm(`Follow run ${each.databaseId}, created ${each.createdAt}? [y/N] `)) {
      const record: Running = {
        repository: recorded.repository,
        sha: recorded.sha,
        outcome: "running",
        runId: each.databaseId,
      };
      await recordRehearsal(record);
      return record;
    }
  }
  print(
    runs.length === 0
      ? "rehearsal: GitHub lists no run of the release workflow dispatched on main at that commit since then"
      : "rehearsal: no listed run was taken",
  );
  return dispatch(where);
}

// The rehearsal step, once the repository's release settings read back. A recorded run is resolved before anything
// else: followed while it is recorded as running (its outcome is recorded only once its drafts are gone), and looked
// for when only its dispatch was recorded. Done once a rehearsal of origin's main passed; else a new dispatch.
async function rehearsalStep(where: Checkout): Promise<void> {
  await ghAdmin(where, "rehearsal");
  await readBack(where);
  const workflow = await workflowId(where);
  const found = v.safeParse(RehearsalRecord, (await readState())["rehearsal"]);
  const recorded = found.success && found.output.repository === where.repository ? found.output : null;
  let record: Running;
  if (recorded?.outcome === "running") {
    record = recorded;
    print(`rehearsal: run ${record.runId} is recorded as running: following it instead of dispatching again`);
  } else if (recorded?.outcome === "dispatching") {
    record = await recover(where, recorded, workflow);
  } else if (recorded?.outcome === "passed" && recorded.sha === where.sha) {
    print(`rehearsal: done: run ${recorded.runId} passed on ${where.sha}, origin's main`);
    return;
  } else {
    if (recorded?.outcome === "passed") {
      print(`rehearsal: run ${recorded.runId} passed on ${recorded.sha}; main is now ${where.sha}, not rehearsed`);
    }
    record = await dispatch(where);
  }
  print(
    `rehearsal: following run ${record.runId} (https://github.com/${where.repository}/actions/runs/${record.runId})`,
  );
  const view = await follow(where, record, workflow);
  if (view.headSha !== record.sha) {
    print(`rehearsal: run ${record.runId} runs on ${view.headSha}, not ${record.sha}, the commit confirmed`);
    if (!(await draftsGone(where, record.runId))) {
      throw new Refusal(
        `run ${record.runId} is no rehearsal of ${record.sha}, and a draft it left is kept: it stays recorded; run setup rehearsal again to delete the draft`,
      );
    }
    await recordRehearsal({ ...record, sha: view.headSha, outcome: "failed" });
    throw new Refusal(
      `run ${record.runId} ran on ${view.headSha}, not ${record.sha}: recorded as failed, as no rehearsal of main; run setup rehearsal again`,
    );
  }
  const passed = verdict(view);
  const notice = await readProbe(where, view);
  const outcome = passed ? "passed" : "failed";
  if (!(await draftsGone(where, record.runId))) {
    throw new Refusal(
      `run ${record.runId} ${outcome}, and a draft it left is kept: it stays recorded; run setup rehearsal again to delete the draft before another dispatch`,
    );
  }
  await recordRehearsal({ ...record, outcome }, notice);
  print(`rehearsal: recorded run ${record.runId} as ${outcome} on ${record.sha}`);
  if (!passed) {
    throw new Refusal(`the rehearsal failed (run ${record.runId}): fix what failed, then run setup rehearsal again`);
  }
  if (record.sha !== where.sha) {
    print(`rehearsal: main is now ${where.sha}, which a rehearsal has not run on: run setup rehearsal again`);
    return;
  }
  print(`rehearsal: done: run ${record.runId} passed on ${where.sha}, origin's main`);
}

function isStep(arg: string): arg is Step {
  return STEPS.some((step) => step === arg);
}

function isHostStep(step: Step): step is HostStep {
  return HOST_STEPS.some((each) => each === step);
}

// The host's steps in order: each that stops (its refusal printed under its name) stops the steps that need it, which
// are skipped, saying which; the others still run. Refused at the end when any stopped, with the worst exit code.
async function hostSteps(): Promise<void> {
  const stopped = new Set<HostStep>();
  let unconfirmed = false;
  for (const step of HOST_STEPS) {
    const need = HOST_NEEDS[step].find((each) => stopped.has(each));
    if (need !== undefined) {
      print(`${step}: skipped (it needs ${need}, which stopped)`);
      stopped.add(step);
      continue;
    }
    try {
      await hostStep(step);
    } catch (error) {
      if (!(error instanceof Refusal)) {
        throw error;
      }
      for (const line of error.lines) {
        printError(`${step}: ${line}`);
      }
      stopped.add(step);
      unconfirmed ||= error instanceof Unconfirmed;
    }
  }
  if (stopped.size > 0) {
    const line = `stopped: ${[...stopped].join(", ")}; fix what the first one says, then run setup again`;
    throw unconfirmed ? new Unconfirmed(line) : new Refusal(line);
  }
  print("setup: done");
}

async function main(args: readonly string[]): Promise<void> {
  const [step, ...rest] = args;
  if (rest.length > 0 || (step !== undefined && !isStep(step))) {
    throw new Refusal(USAGE);
  }
  refuseOverrides();
  notInCi(CI_REASON);
  if (step === undefined) {
    print(`setup: the host's steps: ${HOST_STEPS.join(", ")}`);
    print(
      `setup: the publisher's steps run only when named: ${PUBLISHER_STEPS.map((each) => `setup ${each}`).join(", ")}`,
    );
    await hostSteps();
    return;
  }
  if (isHostStep(step)) {
    await hostStep(step);
    return;
  }
  const where = await checkout();
  await (step === "repository" ? repositoryStep(where) : rehearsalStep(where));
}

// A "--" before the arguments (as some package managers pass it) is not an argument.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
await runCommand("setup", () => main(args));
