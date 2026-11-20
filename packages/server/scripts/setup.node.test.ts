// The setup (setup.ts) run through the tests' entry (test-entry.ts), whose fixture gives it stand-ins for gh and
// gh-infra and shorter bounds, from a publisher's clone whose origin is a GitHub URL that the fixture's git config
// rewrites to a bare repository, all in the OS temp directory. The stand-ins answer from a state file each call reads
// and changes (GitHub's repository, rulesets, release settings, the workflow's runs and releases, and whether
// .github/infra.yaml is applied) and record every call. Runs get a terminal from python3's pty module, where gh-infra's
// apply and the setup's questions are answered. Nothing reaches the network or GitHub.

import { type ChildProcess, execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FixtureGit, type FixtureRepo, fixtureRoot } from "../../cli/src/test/git.ts";
import type { Fixture } from "./fixture.ts";
import { type Answer, runInTerminal } from "./test-terminal.ts";

const TEST_ENTRY = fileURLToPath(new URL("test-entry.ts", import.meta.url));
const INFRA_YAML = fileURLToPath(new URL("../../../.github/infra.yaml", import.meta.url));
const REPOSITORY = "prq-test/prq";
const RUN_ID = 7001;
const WORKFLOW_ID = 77;
const PROBE_JOB = 21;
// What gh auth status prints of the login's token, which no output may hold.
const TOKEN = "gho_sentinelTokenPart9c1f";
const NOTICE = "contents: read reads the draft and its archive by ID: smoke can drop to it";

const infraYaml = (owner = "prq-test") => `apiVersion: gh-infra/v1
kind: Repository
metadata:
  name: prq
  owner: ${owner}
spec:
  release_immutability: true
`;

// The stand-in for gh: GitHub as the state file has it, each call recorded by its key (an API call's method and path,
// a job's log "run log", another command's first two words). A behavior per key: "fail" (HTTP 500), "403", "hang", or "orphan" (fails,
// leaving a process in its group); "-once" after one applies it to the next call alone.
const FAKE_GH = `#!${process.execPath}
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const R = ${JSON.stringify(REPOSITORY)};
const args = process.argv.slice(2);
let key;
if (args[0] === "api") {
  const method = args.indexOf("--method");
  key = (method === -1 ? "GET" : args[method + 1]) + " " + args[args.length - 1];
} else if (args.includes("--log")) {
  key = "run log";
} else {
  key = args[0] + " " + args[1];
}
appendFileSync(process.env.FAKE_SETUP_LOG, JSON.stringify({ tool: "gh", key, args, cwd: process.cwd() }) + "\\n");
const statePath = process.env.FAKE_SETUP_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const json = (value) => process.stdout.write(JSON.stringify(value));
const fail = (message) => {
  process.stderr.write(message + "\\n");
  process.exit(1);
};
let behavior = state.behavior[key];
if (behavior?.endsWith("-once")) {
  delete state.behavior[key];
  save();
  behavior = behavior.slice(0, -"-once".length);
}
if (behavior === "hang") {
  writeFileSync(process.env.FAKE_SETUP_PIDS, JSON.stringify([process.pid]));
  setInterval(() => {}, 1000);
} else if (behavior === "orphan") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.FAKE_SETUP_PIDS, JSON.stringify([child.pid]));
  fail("gh: Server Error (HTTP 500)");
} else if (behavior === "fail") {
  fail("gh: Server Error (HTTP 500)");
} else if (behavior === "403") {
  fail("gh: Resource not accessible by personal access token (HTTP 403)");
} else if (key === "auth status") {
  if (!state.authed) {
    fail("You are not logged into any GitHub hosts. To log in, run: gh auth login");
  }
  process.stderr.write("github.com\\n  ✓ Logged in to github.com account publisher\\n  - Token: ${TOKEN}\\n");
} else if (key === "GET repos/" + R) {
  json({ full_name: R, permissions: { admin: state.admin } });
} else if (key === "GET repos/" + R + "/rulesets?per_page=100") {
  json(state.rulesets.map(({ id, name }) => ({ id, name })));
} else if (key.startsWith("GET repos/" + R + "/rulesets/")) {
  json(state.rulesets.find((each) => String(each.id) === key.split("/").pop()));
} else if (key === "GET repos/" + R + "/actions/permissions/selected-actions") {
  json(state.selectedActions);
} else if (key === "GET repos/" + R + "/immutable-releases") {
  if (!state.immutable) {
    fail("gh: Not Found (HTTP 404)");
  }
  json({ enabled: true, enforced_by_owner: false });
} else if (key === "GET repos/" + R + "/actions/workflows/release.yml") {
  json({ id: ${WORKFLOW_ID}, path: ".github/workflows/release.yml", name: "Release" });
} else if (key === "workflow run") {
  const run = state.dispatch.run;
  state.runs[run.id] = { ...run, views: 0 };
  state.runList.unshift({ databaseId: run.id, createdAt: new Date().toISOString(), headSha: run.sequence[0].headSha, headBranch: "main", workflowDatabaseId: ${WORKFLOW_ID} });
  save();
  if (state.dispatch.printUrl) {
    console.log("https://github.com/" + R + "/actions/runs/" + run.id);
  }
} else if (key === "run list") {
  json(state.runList);
} else if (key === "run log") {
  process.stdout.write(state.logs[args[args.indexOf("--job") + 1]] ?? "");
} else if (key.startsWith("run view")) {
  const run = state.runs[args[2]];
  if (run === undefined) {
    fail("could not find any workflow run with ID " + args[2]);
  }
  const view = run.sequence[Math.min(run.views, run.sequence.length - 1)];
  run.views += 1;
  save();
  json(view);
} else if (key.startsWith("GET repos/" + R + "/check-runs/")) {
  json(state.annotations[key.split("/")[4]] ?? []);
} else if (key === "GET repos/" + R + "/releases?per_page=100") {
  json([state.releases]);
} else if (key.startsWith("DELETE repos/" + R + "/releases/")) {
  state.releases = state.releases.filter((each) => String(each.id) !== key.split("/").pop());
  save();
} else {
  console.error("the stand-in for gh has no answer for " + key);
  process.exit(2);
}
`;

// The stand-in for gh-infra: plan exits 2 until the state says .github/infra.yaml is applied (then 0), or 1 when it
// fails, and records the manifest it read; apply asks on its stdin, applies on y, and exits as the state says, or
// hangs, alone or (ignoring) beside a process that ignores SIGINT and SIGTERM.
const FAKE_GH_INFRA = `#!${process.execPath}
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { isatty } from "node:tty";

const args = process.argv.slice(2);
const manifest = readFileSync(args[args.length - 1], "utf8");
appendFileSync(process.env.FAKE_SETUP_LOG, JSON.stringify({ tool: "gh-infra", key: args[0], args, cwd: process.cwd(), stdinTTY: isatty(0), manifest }) + "\\n");
const statePath = process.env.FAKE_SETUP_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const infra = state.infra;
if (args[0] === "plan") {
  if (infra.planFails) {
    console.error("Error: failed to fetch the repository");
    process.exit(1);
  }
  console.log(infra.applied ? "No changes." : "~ prq-test/prq: rulesets.release-tag-creation");
  process.exit(infra.applied ? 0 : 2);
}
if (infra.applyHangs !== undefined) {
  const pids = [process.ppid];
  if (infra.applyHangs === "ignoring") {
    const child = spawn(process.execPath, ["-e", "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    pids.push(child.pid);
  }
  writeFileSync(process.env.FAKE_SETUP_PIDS, JSON.stringify(pids));
  setInterval(() => {}, 1000);
} else {
  process.stdout.write("Apply 1 change to prq-test/prq? [y/N] ");
  const byte = Buffer.alloc(1);
  let line = "";
  while (readSync(0, byte, 0, 1, null) === 1 && byte[0] !== 10 && byte[0] !== 13) {
    line += byte.toString();
  }
  if (line.trim() === "y") {
    infra.applied = true;
    writeFileSync(statePath, JSON.stringify(state));
    console.log("Applied.");
    process.exit(infra.applyExit ?? 0);
  }
  console.log("Apply canceled.");
}
`;

const Call = v.object({
  tool: v.string(),
  key: v.string(),
  args: v.array(v.string()),
  cwd: v.string(),
  stdinTTY: v.optional(v.boolean()),
  manifest: v.optional(v.string()),
});
type Call = v.InferOutput<typeof Call>;

type Ruleset = {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  bypass_actors?: { actor_id: number | null; actor_type: string; bypass_mode: string }[] | undefined;
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: { type: string; parameters?: unknown }[];
};
type View = {
  status: string;
  conclusion: string;
  headSha: string;
  headBranch: string;
  event: string;
  workflowDatabaseId: number;
  jobs: { databaseId: number; name: string; status: string; conclusion: string }[];
};
type Run = { id: number; sequence: View[] };
type ListedRun = {
  databaseId: number;
  createdAt: string;
  headSha: string;
  headBranch: string;
  workflowDatabaseId: number;
};
type State = {
  authed: boolean;
  admin: boolean;
  rulesets: Ruleset[];
  selectedActions: { patterns_allowed: string[] };
  immutable: boolean;
  infra: { applied: boolean; planFails?: boolean; applyExit?: number; applyHangs?: "alone" | "ignoring" };
  dispatch: { printUrl: boolean; run: Run };
  runs: Record<string, Run & { views: number }>;
  runList: ListedRun[];
  annotations: Record<string, { annotation_level: string; message: string }[]>;
  logs: Record<string, string>;
  releases: { id: number; tag_name: string; draft: boolean }[];
  behavior: Record<string, string>;
};

const JOBS: [string, number][] = [
  ["Verify", 1],
  ["Build (darwin-arm64)", 2],
  ["Build (linux-x64)", 3],
  ["Build (linux-arm64)", 4],
  ["Smoke (darwin-arm64)", 11],
  ["Smoke (linux-x64)", 12],
  ["Smoke (linux-arm64)", 13],
  ["Read probe", PROBE_JOB],
  ["Discard the rehearsal", 31],
];

// The release workflow's dispatched run at sha: in progress, then completed with each job's conclusion (success
// unless given) and the run's (failure when a job's is not success, unless given), its identity as given.
function rehearsalRun(sha: string, conclusions: Record<string, string> = {}, identity: Partial<View> = {}): Run {
  const base = {
    headSha: sha,
    headBranch: "main",
    event: "workflow_dispatch",
    workflowDatabaseId: WORKFLOW_ID,
    ...identity,
  };
  const jobs = (done: boolean) =>
    JOBS.map(([name, databaseId]) => {
      const completed = done || name === "Verify";
      return {
        databaseId,
        name,
        status: completed ? "completed" : "queued",
        conclusion: completed ? (conclusions[name] ?? "success") : "",
      };
    });
  const failed = Object.entries(conclusions).some(([name, each]) => name !== "run" && each !== "success");
  return {
    id: RUN_ID,
    sequence: [
      { ...base, status: "in_progress", conclusion: "", jobs: jobs(false) },
      {
        ...base,
        status: "completed",
        conclusion: conclusions["run"] ?? (failed ? "failure" : "success"),
        jobs: jobs(true),
      },
    ],
  };
}

const RULESETS: Ruleset[] = [
  {
    id: 100,
    name: "default",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "deletion" }],
  },
  {
    id: 101,
    name: "release-tag-creation",
    target: "tag",
    enforcement: "active",
    bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "creation" }],
  },
  {
    id: 102,
    name: "release-tag-immutability",
    target: "tag",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "update", parameters: { update_allows_fetch_and_merge: false } }, { type: "deletion" }],
  },
];

let bin: string;
let root: string;
let fixture: FixtureGit;
let origin: FixtureRepo;
let seed: FixtureRepo;
let host: FixtureRepo;
let commit: string;
let env: Record<string, string>;
let settings: v.InferOutput<typeof Fixture>;

// One stand-in each, run once here: macOS checks a new executable on its first run, which can take seconds.
beforeAll(async () => {
  bin = await fixtureRoot("prq-setup-bin-");
  for (const [name, text] of [
    ["gh", FAKE_GH],
    ["gh-infra", FAKE_GH_INFRA],
  ] as const) {
    await writeFile(join(bin, name), text, { mode: 0o700 });
    await new Promise<void>((resolve) => {
      execFile(join(bin, name), ["warm"], { timeout: 60_000 }, () => resolve());
    });
  }
}, 120_000);

afterAll(async () => {
  await rm(bin, { recursive: true, force: true });
});

async function saveState(change: Partial<State> = {}): Promise<void> {
  const state: State = {
    authed: true,
    admin: true,
    rulesets: structuredClone(RULESETS),
    selectedActions: { patterns_allowed: ["actions/attest@*", "actions/checkout@*"] },
    immutable: true,
    infra: { applied: true },
    dispatch: { printUrl: true, run: rehearsalRun(commit) },
    runs: {},
    runList: [],
    annotations: {
      [PROBE_JOB]: [
        { annotation_level: "warning", message: "a warning that is not the probe's" },
        { annotation_level: "notice", message: NOTICE },
      ],
    },
    logs: {},
    releases: [],
    behavior: {},
    ...change,
  };
  await writeFile(join(root, "state.json"), JSON.stringify(state));
}

// The stand-ins' state as they left it: what the tests read of it, the rest kept.
const StoredState = v.looseObject({
  releases: v.array(v.looseObject({ id: v.number() })),
  behavior: v.record(v.string(), v.string()),
});

async function readState(): Promise<v.InferOutput<typeof StoredState>> {
  return v.parse(StoredState, JSON.parse(await readFile(join(root, "state.json"), "utf8")));
}

// The stand-ins' state as it is now, changed.
async function changeState(change: Partial<State>): Promise<void> {
  await writeFile(join(root, "state.json"), JSON.stringify({ ...(await readState()), ...change }));
}

beforeEach(async () => {
  root = await fixtureRoot("prq-setup-");
  fixture = await FixtureGit.create(root, { [`https://github.com/${REPOSITORY}.git`]: "origin.git" });
  origin = await fixture.init("origin.git", { bare: true });
  seed = await fixture.init("seed");
  await mkdir(join(seed.path, ".github"));
  await writeFile(join(seed.path, ".github", "infra.yaml"), infraYaml());
  await seed.add(".github");
  await seed.commit("ci: declare the repository's settings");
  commit = await seed.headCommit();
  await seed.push(origin, "HEAD:refs/heads/main");
  host = await fixture.clone(origin, "host");
  await saveState();
  env = {
    ...fixture.env,
    PATH: fixture.env["PATH"] ?? "",
    FAKE_SETUP_STATE: join(root, "state.json"),
    FAKE_SETUP_LOG: join(root, "calls.jsonl"),
    FAKE_SETUP_PIDS: join(root, "pids.json"),
  };
  settings = {
    gh: join(bin, "gh"),
    ghInfra: join(bin, "gh-infra"),
    stateDir: join(root, "state", "prq"),
    waitMs: 15_000,
    stepMs: 15_000,
    pollMs: 50,
    followMs: 20_000,
  };
});

const started: ChildProcess[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const pid of await recordedPids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It has ended.
    }
  }
  await rm(root, { recursive: true, force: true });
});

// The processes a stand-in recorded, waited for until it has.
async function recordedPids(wait = false): Promise<number[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const text = await readFile(join(root, "pids.json"), "utf8").catch(() => "");
    if (text !== "" || !wait || Date.now() > deadline) {
      return text === "" ? [] : v.parse(v.array(v.number()), JSON.parse(text));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type Result = { code: number | null; output: string };

// The setup with these arguments in the host's clone, in a terminal unless told otherwise, answering each [y/N]
// question in turn (gh-infra's among them). Its output never holds the login's token.
function start(args: string[], { terminal = true, answers = [] as Answer[] } = {}) {
  const file = join(root, "fixture.json");
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("FAKE_")));
  writeFileSync(file, JSON.stringify({ ...settings, childEnv }));
  const { child, result } = runInTerminal([process.execPath, TEST_ENTRY, file, "setup", ...args], {
    cwd: host.path,
    env,
    terminal,
    answers,
    prompt: /\[y\/N\] /,
  });
  started.push(child);
  return result.then((outcome) => {
    expect(outcome.output).not.toContain(TOKEN);
    return outcome;
  });
}

function setup(args: string[], options: { terminal?: boolean; answers?: Answer[] } = {}): Promise<Result> {
  return start(args, options);
}

async function calls(tool?: string): Promise<Call[]> {
  const text = await readFile(join(root, "calls.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => v.parse(Call, JSON.parse(line)))
    .filter((each) => tool === undefined || each.tool === tool);
}

async function keys(tool?: string): Promise<string[]> {
  return (await calls(tool)).map((each) => each.key);
}

async function dispatches(): Promise<number> {
  return (await keys("gh")).filter((key) => key === "workflow run").length;
}

const STATE_FILE = () => join(root, "state", "prq", "setup.json");

async function recorded(): Promise<Record<string, unknown> | null> {
  const text = await readFile(STATE_FILE(), "utf8").catch(() => null);
  return text === null ? null : v.parse(v.record(v.string(), v.unknown()), JSON.parse(text));
}

// A new commit on origin's main, and the host's clone of it.
async function advanceMain(): Promise<string> {
  await writeFile(join(seed.path, "README.md"), "prq\n");
  await seed.add("README.md");
  await seed.commit("docs: add a readme");
  await seed.push(origin, "HEAD:refs/heads/main");
  return seed.headCommit();
}

describe("setup", () => {
  it("runs no step without one, and names the publisher's", async () => {
    const result = await setup([], { terminal: false });

    expect(result.code).toBe(0);
    expect(result.output).toContain("setup: there is no host step yet, so nothing was run");
    expect(result.output).toContain("the publisher's steps run only when named: setup repository, setup rehearsal");
    expect(await calls()).toEqual([]);
  });

  it("prints its usage for anything but one step", async () => {
    for (const args of [["deploy"], ["repository", "rehearsal"]]) {
      const result = await setup(args, { terminal: false });
      expect(result).toMatchObject({ code: 1, output: "setup: usage: setup [repository | rehearsal]\n" });
    }
    expect(await calls()).toEqual([]);
  });

  it.each([
    ["CI", { CI: "true" }, "setup: the environment marks this run as CI (CI), where nobody answers"],
    ["an override", { PRQ_DEPLOY_X: "1" }, "setup: the environment sets PRQ_DEPLOY_X"],
  ])("refuses %s before any call", async (_what, marks, refusal) => {
    Object.assign(env, marks);

    const result = await setup(["repository"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(refusal);
    expect(await calls()).toEqual([]);
  });
});

describe("the repository's .github/infra.yaml", () => {
  it("declares the immutability ruleset's bypass as empty, which gh-infra applies as none", async () => {
    const text = await readFile(INFRA_YAML, "utf8");
    const block = /- name: release-tag-immutability\n((?: {6}.*\n)+)/.exec(text)?.[1] ?? "";

    expect(block).toMatch(/^ {6}bypass_actors: \[\]$/m);
  });
});

describe("setup repository", () => {
  const PASSES = [
    "repository: release-tag-creation: pass",
    "repository: release-tag-immutability: pass",
    "repository: selected actions: pass",
    "repository: immutable releases: pass",
    "repository: done",
  ];

  it("reads back an applied repository without applying", async () => {
    const result = await setup(["repository"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain(`setup: ${REPOSITORY} at origin's main (${commit})`);
    expect(result.output).toContain("repository: gh-infra plans no change to .github/infra.yaml");
    for (const line of PASSES) {
      expect(result.output).toContain(line);
    }
    expect(await calls("gh-infra")).toEqual([
      expect.objectContaining({ args: ["plan", "--detailed-exitcode", ".github/infra.yaml"], cwd: host.path }),
    ]);
  });

  it("applies through gh-infra's own confirmation on the terminal, then plans no change", async () => {
    await saveState({ infra: { applied: false } });

    const result = await setup(["repository"], { answers: ["y"] });

    expect(result.code).toBe(0);
    expect(result.output).toContain("Apply 1 change to prq-test/prq? [y/N] ");
    expect(result.output).toContain("repository: applied .github/infra.yaml; gh-infra plans no change now");
    for (const line of PASSES) {
      expect(result.output).toContain(line);
    }
    const infra = await calls("gh-infra");
    expect(infra.map((each) => each.args)).toEqual([
      ["plan", "--detailed-exitcode", ".github/infra.yaml"],
      ["apply", ".github/infra.yaml"],
      ["plan", "--detailed-exitcode", ".github/infra.yaml"],
    ]);
    expect(infra[1]?.stdinTTY).toBe(true);
    expect(infra.map((each) => each.manifest)).toEqual([infraYaml(), infraYaml(), infraYaml()]);
  });

  it("refuses when the apply is declined, and reads nothing back", async () => {
    await saveState({ infra: { applied: false } });

    const result = await setup(["repository"], { answers: ["n"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain("Apply canceled.");
    expect(result.output).toContain(
      "setup: gh-infra still plans changes after its apply, which was declined or left some",
    );
    expect(await keys("gh")).not.toContain(`GET repos/${REPOSITORY}/rulesets?per_page=100`);
  });

  it("exits 2 when the apply fails, its changes unknown", async () => {
    await saveState({ infra: { applied: false, applyExit: 1 } });

    const result = await setup(["repository"], { answers: ["y"] });

    expect(result.code).toBe(2);
    expect(result.output).toContain("setup: gh-infra apply failed (exit 1)");
    expect(result.output).toContain("setup: what it changed is not known");
    expect(await keys("gh-infra")).toEqual(["plan", "apply"]);
  });

  it("exits 2 when the apply passes its bound, and stops it", async () => {
    await saveState({ infra: { applied: false, applyHangs: "alone" } });
    settings.stepMs = 1_000;

    const result = await setup(["repository"]);

    expect(result.code).toBe(2);
    expect(result.output).toContain("setup: gh-infra apply did not finish within 1 s and was stopped");
  });

  it("stops on a signal what the apply started, after the apply itself has ended", async () => {
    await saveState({ infra: { applied: false, applyHangs: "ignoring" } });
    const running = start(["repository"]);
    const [setupPid = 0, ignoring = 0] = await recordedPids(true);

    process.kill(setupPid, "SIGINT");
    await running;

    expect(alive(ignoring)).toBe(false);
  }, 30_000);

  it("refuses to apply without a terminal", async () => {
    await saveState({ infra: { applied: false } });

    const result = await setup(["repository"], { terminal: false });

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: gh-infra asks to confirm its apply on a terminal");
    expect(await keys("gh-infra")).toEqual(["plan"]);
  });

  it("refuses when gh-infra's plan fails", async () => {
    await saveState({ infra: { applied: true, planFails: true } });

    const result = await setup(["repository"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: gh-infra plan failed (exit 1)");
  });

  const creation = (change: Partial<Ruleset>) => {
    const rulesets = structuredClone(RULESETS);
    Object.assign(rulesets[1] ?? {}, change);
    return rulesets;
  };
  const immutability = (change: Partial<Ruleset>) => {
    const rulesets = structuredClone(RULESETS);
    Object.assign(rulesets[2] ?? {}, change);
    return rulesets;
  };

  it.each<[string, Partial<State>, string]>([
    [
      "a second bypass",
      {
        rulesets: creation({
          bypass_actors: [
            { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
            { actor_id: 9, actor_type: "Integration", bypass_mode: "always" },
          ],
        }),
      },
      "release-tag-creation: its bypass is [RepositoryRole 5 always, Integration 9 always], not the admin role alone, always",
    ],
    [
      "a bypass it cannot read",
      { rulesets: creation({ bypass_actors: undefined }) },
      "release-tag-creation: its bypass is not readable with gh's login, which takes write access to the repository",
    ],
    [
      "an immutability bypass it cannot read",
      { rulesets: immutability({ bypass_actors: undefined }) },
      "release-tag-immutability: its bypass is not readable with gh's login, which takes write access to the repository",
    ],
    [
      "a bypass of the immutability",
      {
        rulesets: immutability({
          bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
        }),
      },
      "release-tag-immutability: its bypass is [RepositoryRole 5 always], not none",
    ],
    [
      "an evaluated ruleset",
      { rulesets: creation({ enforcement: "evaluate" }) },
      "release-tag-creation: enforcement is evaluate, not active",
    ],
    [
      "a branch ruleset",
      { rulesets: creation({ target: "branch" }) },
      "release-tag-creation: target is branch, not tag",
    ],
    [
      "other refs",
      { rulesets: immutability({ conditions: { ref_name: { include: ["refs/tags/*"], exclude: [] } } }) },
      "release-tag-immutability: its refs include [refs/tags/*], not [refs/tags/v*] alone",
    ],
    [
      "an excluded tag",
      { rulesets: creation({ conditions: { ref_name: { include: ["refs/tags/v*"], exclude: ["refs/tags/v9*"] } } }) },
      "release-tag-creation: its refs exclude [refs/tags/v9*]",
    ],
    [
      "a missing rule",
      { rulesets: immutability({ rules: [{ type: "update" }] }) },
      "release-tag-immutability: its rules are [update], not [deletion, update]",
    ],
    [
      "a missing ruleset",
      { rulesets: RULESETS.filter((each) => each.id !== 101) },
      "release-tag-creation: there is no such ruleset",
    ],
    [
      "attest not allowed",
      { selectedActions: { patterns_allowed: ["actions/checkout@*"] } },
      "selected actions: the allowed patterns do not include actions/attest@*",
    ],
    ["immutable releases off", { immutable: false }, "immutable releases: they are not enabled"],
  ])("refuses %s, naming the field", async (_what, change, issue) => {
    await saveState(change);

    const result = await setup(["repository"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`setup: repository: ${issue}\n`);
    expect(result.output).toContain("setup: the release settings do not read back as .github/infra.yaml declares them");
    expect(result.output).not.toContain("repository: done");
  });

  it("names the permission a denied read takes", async () => {
    await saveState({ behavior: { [`GET repos/${REPOSITORY}/actions/permissions/selected-actions`]: "403" } });

    const result = await setup(["repository"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "setup: gh api failed (exit 1): it takes Administration: read on the repository for gh's login",
    );
  });

  it("refuses a checkout behind origin's main before any call to GitHub", async () => {
    const main = await advanceMain();

    const result = await setup(["repository"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`setup: HEAD is ${commit}, not origin's main (${main})`);
    expect(await calls()).toEqual([]);
  });

  it("fetches main whatever origin's fetch configuration holds", async () => {
    await host.configSet("remote.origin.fetch", "+refs/heads/side:refs/remotes/origin/side");
    const main = await advanceMain();

    const result = await setup(["repository"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`setup: HEAD is ${commit}, not origin's main (${main})`);
  });

  it("refuses a changed .github/infra.yaml before any call to GitHub", async () => {
    await writeFile(join(host.path, ".github", "infra.yaml"), `${infraYaml()}  archived: true\n`);

    const result = await setup(["repository"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: .github/infra.yaml differs from main's");
    expect(await calls()).toEqual([]);
  });

  it("refuses a change git status does not show (skip-worktree)", async () => {
    await host.skipWorktree(".github/infra.yaml");
    await writeFile(join(host.path, ".github", "infra.yaml"), `${infraYaml()}  archived: true\n`);

    const result = await setup(["repository"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: .github/infra.yaml differs from main's");
    expect(await calls()).toEqual([]);
  });

  it("refuses a .github/infra.yaml of another repository than origin", async () => {
    await writeFile(join(seed.path, ".github", "infra.yaml"), infraYaml("someone-else"));
    await seed.add(".github");
    await seed.commit("ci: another owner");
    await seed.push(origin, "HEAD:refs/heads/main");
    host = await fixture.clone(origin, "host-2");

    const result = await setup(["repository"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`setup: .github/infra.yaml declares someone-else/prq, not ${REPOSITORY}, origin's`);
    expect(await calls()).toEqual([]);
  });

  it.each<[string, Partial<State>, string]>([
    ["a gh that is not logged in", { authed: false }, "setup: gh is not logged in: gh auth login"],
    [
      "a login that is not an admin",
      { admin: false },
      `setup: gh's login is not an admin of ${REPOSITORY}: setup repository takes the admin role and Administration: write and Issues: write (or Pull requests: write, for the labels)`,
    ],
  ])("refuses %s before gh-infra", async (_what, change, refusal) => {
    await saveState(change);

    const result = await setup(["repository"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(refusal);
    expect(await calls("gh-infra")).toEqual([]);
  });

  it("stops a gh call at its bound", async () => {
    await saveState({ behavior: { [`GET repos/${REPOSITORY}`]: "hang" } });
    settings.waitMs = 1_000;

    const result = await setup(["repository"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: gh api did not finish within 1 s and was stopped");
    const [pid = 0] = await recordedPids();
    expect(alive(pid)).toBe(false);
  });

  it("ends what a failed gh call left in its group", async () => {
    await saveState({ behavior: { [`GET repos/${REPOSITORY}`]: "orphan" } });

    const result = await setup(["repository"]);

    expect(result.code).toBe(1);
    const [pid = 0] = await recordedPids(true);
    expect(alive(pid)).toBe(false);
  });
});

// A run of the commit with these conclusions (Discard failing unless given) whose draft is left.
const withDraft = (conclusions: Record<string, string> = { "Discard the rehearsal": "failure" }) => ({
  dispatch: { printUrl: true, run: rehearsalRun(commit, conclusions) },
  releases: [{ id: 501, tag_name: `rehearsal-${RUN_ID}`, draft: true }],
});

describe("setup rehearsal", () => {
  const DISPATCH = ["workflow", "run", "release.yml", "--ref", "main", "--repo", REPOSITORY];
  it("dispatches on yes, follows the run gh names, records it passed, and is done after", async () => {
    const result = await setup(["rehearsal"], { answers: ["y"] });

    expect(result.code).toBe(0);
    expect(result.output).toContain(`Dispatch the release rehearsal on main (${commit})? [y/N] `);
    for (const line of [
      `rehearsal: following run ${RUN_ID} (https://github.com/${REPOSITORY}/actions/runs/${RUN_ID})`,
      "rehearsal: Verify: success",
      "rehearsal: the run: success",
      "rehearsal: Smoke (darwin-arm64): pass",
      "rehearsal: Smoke (linux-x64): pass",
      "rehearsal: Smoke (linux-arm64): pass",
      "rehearsal: Read probe: pass",
      "rehearsal: Discard the rehearsal: pass",
      `rehearsal: Read probe noted: ${NOTICE}`,
      `rehearsal: no draft of rehearsal-${RUN_ID} is left`,
      `rehearsal: recorded run ${RUN_ID} as passed on ${commit}`,
      `rehearsal: done: run ${RUN_ID} passed on ${commit}, origin's main`,
    ]) {
      expect(result.output).toContain(line);
    }
    expect(result.output).not.toContain("a warning that is not the probe's");
    expect((await calls("gh")).filter((each) => each.key === "workflow run").map((each) => each.args)).toEqual([
      DISPATCH,
    ]);
    expect(await recorded()).toEqual({
      rehearsal: {
        repository: REPOSITORY,
        runId: RUN_ID,
        sha: commit,
        outcome: "passed",
        notice: NOTICE,
        recordedAt: expect.any(String),
      },
    });
    expect((await stat(STATE_FILE())).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "state", "prq"))).mode & 0o777).toBe(0o700);

    const again = await setup(["rehearsal"]);

    expect(again.code).toBe(0);
    expect(again.output).toContain(`rehearsal: done: run ${RUN_ID} passed on ${commit}, origin's main`);
    expect(await dispatches()).toBe(1);
  });

  it("says main still needs a rehearsal once a passed one is of an older commit", async () => {
    await setup(["rehearsal"], { answers: ["y"] });
    const main = await advanceMain();
    host = await fixture.clone(origin, "host-2");

    const result = await setup(["rehearsal"], { answers: ["n"] });

    expect(result.output).toContain(`rehearsal: run ${RUN_ID} passed on ${commit}; main is now ${main}, not rehearsed`);
    expect(result.output).toContain(`Dispatch the release rehearsal on main (${main})? [y/N] `);
  });

  it("records the run at once, and a later run follows it instead of dispatching again", async () => {
    await saveState({ behavior: { [`run view`]: "fail" } });

    const first = await setup(["rehearsal"], { answers: ["y"] });

    expect(first.code).toBe(1);
    expect(first.output).toContain("setup: gh run view (3 times in a row) failed (exit 1)");
    expect(await recorded()).toMatchObject({ rehearsal: { runId: RUN_ID, sha: commit, outcome: "running" } });
    await changeState({ behavior: {} });

    const second = await setup(["rehearsal"]);

    expect(second.code).toBe(0);
    expect(second.output).toContain(
      `rehearsal: run ${RUN_ID} is recorded as running: following it instead of dispatching again`,
    );
    expect(second.output).not.toContain("Dispatch the release rehearsal");
    expect(await dispatches()).toBe(1);
    expect(await recorded()).toMatchObject({ rehearsal: { outcome: "passed" } });
  });

  it("labels a recorded run of an older commit with it, and says main still needs one", async () => {
    await saveState({ behavior: { [`run view`]: "fail" } });
    await setup(["rehearsal"], { answers: ["y"] });
    await changeState({ behavior: {} });
    const main = await advanceMain();
    host = await fixture.clone(origin, "host-2");

    const result = await setup(["rehearsal"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain(`rehearsal: recorded run ${RUN_ID} as passed on ${commit}`);
    expect(result.output).toContain(`rehearsal: main is now ${main}, which a rehearsal has not run on`);
    expect(result.output).not.toContain("rehearsal: done");
  });

  it("keeps a run that passes the follow's bound recorded as running", async () => {
    const run = rehearsalRun(commit);
    await saveState({ dispatch: { printUrl: true, run: { ...run, sequence: run.sequence.slice(0, 1) } } });
    settings.followMs = 500;

    const result = await setup(["rehearsal"], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `setup: run ${RUN_ID} did not complete within 1 s; it stays recorded: run setup rehearsal again to follow it`,
    );
    expect(await recorded()).toMatchObject({ rehearsal: { outcome: "running" } });
  });

  it("does not take a run's end read past the follow's bound", async () => {
    await saveState({
      dispatch: { printUrl: true, run: { id: RUN_ID, sequence: rehearsalRun(commit).sequence.slice(1) } },
    });
    settings.followMs = 1;

    const result = await setup(["rehearsal"], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(`setup: run ${RUN_ID} did not complete within`);
    expect(await recorded()).toMatchObject({ rehearsal: { outcome: "running" } });
  });

  it.each<[string, Record<string, string>, string]>([
    ["a failed Smoke", { "Smoke (linux-arm64)": "failure" }, "rehearsal: Smoke (linux-arm64): fail (failure)"],
    ["a skipped Smoke", { "Smoke (darwin-arm64)": "skipped" }, "rehearsal: Smoke (darwin-arm64): fail (skipped)"],
    ["a cancelled Smoke", { "Smoke (linux-x64)": "cancelled" }, "rehearsal: Smoke (linux-x64): fail (cancelled)"],
    ["a failed Read probe", { "Read probe": "failure" }, "rehearsal: Read probe: fail (failure)"],
    ["a cancelled run", { run: "cancelled" }, "rehearsal: the run: cancelled"],
  ])("records %s as failed and refuses", async (_what, conclusions, line) => {
    await saveState({ dispatch: { printUrl: true, run: rehearsalRun(commit, conclusions) } });

    const result = await setup(["rehearsal"], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(line);
    expect(result.output).toContain(`setup: the rehearsal failed (run ${RUN_ID})`);
    expect(await recorded()).toMatchObject({ rehearsal: { outcome: "failed" } });
  });

  it.each<[string, Partial<View>, string]>([
    [
      "another workflow of the same name",
      { workflowDatabaseId: 78 },
      `its workflow is 78, not .github/workflows/release.yml (${WORKFLOW_ID})`,
    ],
    ["another event", { event: "push" }, "its event is push, not workflow_dispatch"],
    ["another branch", { headBranch: "side" }, "its branch is side, not main"],
  ])("refuses a run of %s, recorded as failed", async (_what, identity, issue) => {
    await saveState({ dispatch: { printUrl: true, run: rehearsalRun(commit, {}, identity) } });

    const result = await setup(["rehearsal"], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(`setup: rehearsal: run ${RUN_ID}: ${issue}`);
    expect(await recorded()).toMatchObject({ rehearsal: { outcome: "failed" } });
    expect(result.output).not.toContain("Smoke (darwin-arm64): pass");
  });

  it("checks the drafts of a run on another commit than confirmed, then records it failed, not as main's", async () => {
    const other = "f".repeat(40);
    await saveState({
      dispatch: { printUrl: true, run: rehearsalRun(commit, {}, { headSha: other }) },
      releases: [{ id: 501, tag_name: `rehearsal-${RUN_ID}`, draft: true }],
    });

    const result = await setup(["rehearsal"], { answers: ["y", "y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(`rehearsal: run ${RUN_ID} runs on ${other}, not ${commit}, the commit confirmed`);
    expect(result.output).toContain("rehearsal: deleted the draft 501");
    expect(result.output).toContain(`setup: run ${RUN_ID} ran on ${other}, not ${commit}: recorded as failed`);
    expect(result.output).not.toContain("rehearsal: done");
    expect(await recorded()).toMatchObject({ rehearsal: { sha: other, outcome: "failed" } });
  });

  it("dispatches nothing when main moved while the owner confirmed", async () => {
    let main = "";
    const result = await setup(["rehearsal"], {
      answers: [
        async () => {
          main = await advanceMain();
          return "y";
        },
      ],
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `setup: origin's main moved to ${main} after ${commit} was confirmed, and nothing was dispatched`,
    );
    expect(await dispatches()).toBe(0);
    expect(await recorded()).toBeNull();
  });

  it("deletes on yes only the draft its run left, and reads it gone", async () => {
    await saveState({
      ...withDraft(),
      releases: [
        { id: 501, tag_name: `rehearsal-${RUN_ID}`, draft: true },
        { id: 502, tag_name: "rehearsal-6999", draft: true },
        { id: 503, tag_name: "v0.0.9", draft: false },
      ],
    });

    // A yes for every question it could ask.
    const result = await setup(["rehearsal"], { answers: ["y", "y", "y", "y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain("rehearsal: Discard the rehearsal: fail (failure)");
    expect(result.output).toContain(`rehearsal: the draft 501 (rehearsal-${RUN_ID}) is left`);
    expect(result.output).toContain("rehearsal: deleted the draft 501");
    expect(result.output).not.toContain("draft 502");
    expect((await keys("gh")).filter((key) => key.startsWith("DELETE"))).toEqual([
      `DELETE repos/${REPOSITORY}/releases/501`,
    ]);
    expect((await readState()).releases.map((each) => each.id)).toEqual([502, 503]);
    expect(await recorded()).toMatchObject({ rehearsal: { outcome: "failed" } });
  });

  it("keeps a run whose draft is kept recorded, and asks again before any dispatch", async () => {
    await saveState(withDraft());

    const first = await setup(["rehearsal"], { answers: ["y", "n"] });

    expect(first.code).toBe(1);
    expect(first.output).toContain("rehearsal: kept the draft 501");
    expect(first.output).toContain(`setup: run ${RUN_ID} failed, and a draft it left is kept: it stays recorded`);
    expect(await recorded()).toMatchObject({ rehearsal: { outcome: "running" } });

    const second = await setup(["rehearsal"], { answers: ["y"] });

    expect(second.output).toContain("rehearsal: deleted the draft 501");
    expect(await dispatches()).toBe(1);
    expect(await recorded()).toMatchObject({ rehearsal: { outcome: "failed" } });
  });

  it("never reports done while a draft may be left, after a list that failed", async () => {
    await saveState({
      ...withDraft({}),
      behavior: { [`GET repos/${REPOSITORY}/releases?per_page=100`]: "fail-once" },
    });

    const first = await setup(["rehearsal"], { answers: ["y"] });

    expect(first.code).toBe(1);
    expect(first.output).toContain(
      `setup: run ${RUN_ID} stays recorded: run setup rehearsal again to check its drafts`,
    );
    expect(await recorded()).toMatchObject({ rehearsal: { outcome: "running" } });

    const second = await setup(["rehearsal"], { answers: ["y"] });

    expect(second.code).toBe(0);
    expect(second.output).toContain("rehearsal: deleted the draft 501");
    expect(second.output).toContain(`rehearsal: done: run ${RUN_ID} passed on ${commit}`);
    expect(await dispatches()).toBe(1);
  });

  it("exits 2 when a deletion fails", async () => {
    await saveState({ ...withDraft({}), behavior: { [`DELETE repos/${REPOSITORY}/releases/501`]: "403" } });

    const result = await setup(["rehearsal"], { answers: ["y", "y"] });

    expect(result.code).toBe(2);
    expect(result.output).toContain("it takes Contents: write on the repository for gh's login");
    expect(result.output).toContain("setup: whether it is gone is not known");
    expect(await recorded()).toMatchObject({ rehearsal: { outcome: "running" } });
  });

  const LOG = [
    'Read probe\tRead the draft with contents read\t2026-11-20T01:02:03.0000000Z   echo "::notice::contents: read does not read the draft by ID: smoke keeps contents: write"',
    "Read probe\tRead the draft with contents read\t2026-11-20T01:02:04.0000000Z ##[notice]contents: read does not read the draft by ID: smoke keeps contents: write",
  ].join("\n");

  it.each<[string, Partial<State>]>([
    ["has none", { annotations: {} }],
    ["cannot be read", { behavior: { [`GET repos/${REPOSITORY}/check-runs/${PROBE_JOB}/annotations`]: "403" } }],
    ["passes its bound", { behavior: { [`GET repos/${REPOSITORY}/check-runs/${PROBE_JOB}/annotations`]: "hang" } }],
  ])("reads the probe's notice from its log when its check run %s", async (_what, change) => {
    await saveState({ logs: { [PROBE_JOB]: LOG }, ...change });
    settings.waitMs = 2_000;

    const result = await setup(["rehearsal"], { answers: ["y"] });

    expect(result.code).toBe(0);
    expect(result.output.split("rehearsal: Read probe noted:").length - 1).toBe(1);
    expect(result.output).toContain(
      "rehearsal: Read probe noted: contents: read does not read the draft by ID: smoke keeps contents: write",
    );
  });

  it.each<[string, Record<string, string>]>([
    ["a denied check run and an empty log", { [`GET repos/${REPOSITORY}/check-runs/${PROBE_JOB}/annotations`]: "403" }],
    [
      "a denied check run and a log past its bound",
      { [`GET repos/${REPOSITORY}/check-runs/${PROBE_JOB}/annotations`]: "403", "run log": "hang" },
    ],
  ])("reports a notice it cannot read (%s), and still checks the drafts", async (_what, behavior) => {
    await saveState({ ...withDraft({}), behavior, logs: {} });
    settings.waitMs = 2_000;

    const result = await setup(["rehearsal"], { answers: ["y", "y"] });

    expect(result.output).toContain("rehearsal: Read probe: its notice could not be read");
    expect(result.output).toContain("rehearsal: deleted the draft 501");
    expect(await recorded()).toMatchObject({ rehearsal: { outcome: "passed", notice: null } });
  });

  it("refuses on no without dispatching", async () => {
    const result = await setup(["rehearsal"], { answers: ["n"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: the rehearsal was not dispatched");
    expect(await dispatches()).toBe(0);
    expect(await recorded()).toBeNull();
  });

  it("asks only on a terminal", async () => {
    const result = await setup(["rehearsal"], { terminal: false });

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: setup asks the owner on a terminal: run it from one");
    expect(await dispatches()).toBe(0);
  });

  it("refuses before a dispatch when the release settings do not read back", async () => {
    await saveState({ immutable: false });

    const result = await setup(["rehearsal"], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: repository: immutable releases: they are not enabled");
    expect(await dispatches()).toBe(0);
  });

  it("exits 2 when gh does not name the run, and a later run offers the runs since to follow", async () => {
    await saveState({
      dispatch: { printUrl: false, run: rehearsalRun(commit) },
      runList: [
        {
          databaseId: 6990,
          createdAt: "2020-01-01T00:00:00Z",
          headSha: commit,
          headBranch: "main",
          workflowDatabaseId: WORKFLOW_ID,
        },
      ],
    });

    const first = await setup(["rehearsal"], { answers: ["y"] });

    expect(first.code).toBe(2);
    expect(first.output).toContain("setup: gh workflow run did not name the run it started");
    expect(await recorded()).toMatchObject({ rehearsal: { outcome: "dispatching", sha: commit } });

    const second = await setup(["rehearsal"], { answers: ["y"] });

    expect(second.code).toBe(0);
    expect(second.output).toContain(`Follow run ${RUN_ID}, created `);
    expect(second.output).not.toContain("Follow run 6990");
    expect(await dispatches()).toBe(1);
    expect(await recorded()).toMatchObject({ rehearsal: { runId: RUN_ID, outcome: "passed" } });
  });

  it("dispatches again after a lost dispatch only once the owner takes no listed run", async () => {
    await saveState({ dispatch: { printUrl: false, run: rehearsalRun(commit) } });
    await setup(["rehearsal"], { answers: ["y"] });
    await changeState({ dispatch: { printUrl: true, run: rehearsalRun(commit) } });

    const result = await setup(["rehearsal"], { answers: ["n", "y"] });

    expect(result.code).toBe(0);
    expect(result.output).toContain("rehearsal: no listed run was taken");
    expect(await dispatches()).toBe(2);
  });

  it("exits 2 when the dispatch fails or passes its bound, its run unknown", async () => {
    await saveState({ behavior: { "workflow run": "403" } });

    const denied = await setup(["rehearsal"], { answers: ["y"] });

    expect(denied.code).toBe(2);
    expect(denied.output).toContain(
      "setup: gh workflow run failed (exit 1): it takes Actions: write on the repository for gh's login",
    );
    expect(denied.output).toContain("setup: a run may have started");
    expect(await recorded()).toMatchObject({ rehearsal: { outcome: "dispatching" } });

    await changeState({ behavior: { "workflow run": "hang" } });
    settings.waitMs = 1_000;

    const hung = await setup(["rehearsal"], { answers: ["y", "y"] });

    expect(hung.code).toBe(2);
    expect(hung.output).toContain("setup: gh workflow did not finish within 1 s and was stopped");
  });
});
