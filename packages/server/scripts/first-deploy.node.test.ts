// The first deploy (first-deploy.ts) run through the tests' entry (test-entry.ts) from a host's clone whose origin is a
// GitHub URL the fixture's git config rewrites to a bare repository, all in the OS temp directory. One local server
// answers both the programs the fixture puts in place of the existing commands, check:deployed, docker and gh (each a
// small program that asks the server what to print and how to exit, and records its call), and GitHub's REST API for
// the App's webhook. The deployed checks' arguments are read by the CLI's own parser, the release v0.1.0's (its file is
// unchanged since), so a check the driver could not run on that tag fails here. Runs get a terminal from python3's pty
// module, where the driver's questions are answered. Nothing reaches the network, GitHub or Cloudflare.

import { type ChildProcess, execFile } from "node:child_process";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { jwtVerify } from "jose";
import * as v from "valibot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseInvocation } from "../../cli/src/test/deployed-invocation.ts";
import { FixtureGit, type FixtureRepo, fixtureRoot } from "../../cli/src/test/git.ts";
import type { Fixture } from "./fixture.ts";
import { type Answer, runInTerminal } from "./test-terminal.ts";

const TEST_ENTRY = fileURLToPath(new URL("test-entry.ts", import.meta.url));
const REPOSITORY = "prq-test/prq";
const TEST_REPO = "octo-host/prq-test";
const TAG = "v0.1.0";
const HOST = "prq.sentinel-host.test";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TEAM = "https://sentinel-team.cloudflareaccess.com";
const AUD = "sentinel-aud-5f2e9a";
const CLIENT_ID = "sentinel-client-id.access";
const CLIENT_SECRET = "sentinel-client-secret-77c1";
const WEBHOOK_SECRET = "sentinel-webhook-secret-3b8d";
const APP_ID = 918273;
const HOST_ID = 7340021;
const SUBDOMAIN = "sentinel-sub";
const BOOTSTRAP_VERSION = "00000010-0000-4000-8000-000000000000";
const BRANCH = `prq-first-deploy-${TAG}`;
const WORKFLOW_RUN = 9001;
const ASSETS = ["darwin-arm64", "linux-x64", "linux-arm64"].map((target) => `prq-${TAG}-${target}.tar.gz`);
// What no output of the driver holds, and what its report holds none of besides.
const SECRETS = [CLIENT_SECRET, WEBHOOK_SECRET];
const DEPLOYMENT = [HOST, ACCOUNT, "sentinel-team", AUD];

// A stand-in program: it sends its tool, arguments, directory, parent and the deployment variables it got to the
// server, then prints what the server streams back and exits as it says.
function program(tool: string): string {
  return `#!${process.execPath}
const env = process.env;
const response = await fetch(env.FD_STAND_IN + "/run", {
  method: "POST",
  body: JSON.stringify({
    tool: ${JSON.stringify(tool)},
    args: process.argv.slice(2),
    cwd: process.cwd(),
    pid: process.pid,
    ppid: process.ppid,
    env: { url: env.PRQ_URL ?? null, id: env.PRQ_ACCESS_CLIENT_ID ?? null, secret: env.PRQ_ACCESS_CLIENT_SECRET ?? null },
  }),
});
let text = "";
for await (const chunk of response.body) {
  text += Buffer.from(chunk).toString();
  for (let at = text.indexOf("\\n"); at !== -1; at = text.indexOf("\\n")) {
    const line = JSON.parse(text.slice(0, at));
    text = text.slice(at + 1);
    if ("out" in line) process.stdout.write(line.out);
    else if ("err" in line) process.stderr.write(line.err);
    else process.exit(line.code);
  }
}
`;
}

// A stand-in's call, as it sends it.
const CallSchema = v.object({
  tool: v.string(),
  args: v.array(v.string()),
  cwd: v.string(),
  pid: v.number(),
  ppid: v.number(),
  env: v.object({ url: v.nullable(v.string()), id: v.nullable(v.string()), secret: v.nullable(v.string()) }),
});
type Call = v.InferOutput<typeof CallSchema>;
type Out = { out: (text: string) => void; err: (text: string) => void };

// The world the stand-ins answer from, which each test changes.
type PrRow = { number: number; headRefOid: string; branch: string; state: string; author: { login: string } };
type Delivery = { id: number; event: string; status_code: number; delivered_at: string };
type World = {
  bootstrapFirst: number;
  secretsPut: number[];
  secretsStatus: number[];
  // What the next read-back writes ("fails": nothing, exiting 1).
  // ("again, exit 1": the upload's verdict written, but an exit other than the deploy's 2).
  readBack: "complete" | "deploy again" | "unread" | "fails" | "again, exit 1";
  // How the next deploy of the tag ends ("declined": at its question, before the upload).
  deploy: "complete" | "declined";
  release: "published" | "after-run" | "missing-asset" | "mutable";
  runAppears: boolean;
  // The commit of the release workflow's run the stand-in lists (the merge commit when null).
  runSha: string | null;
  testRepoEmpty: boolean;
  prs: PrRow[];
  jobsNotes: (name: string) => string[];
  summaryTakes: "new" | "other" | "hang";
  events: string[][];
  // The App's deliveries: those listed from the first listing on, and the ping's status (none when null) and one
  // more delivery (late), listed from the second on: after the hook's update is read back.
  deliveries: Delivery[];
  deliveryReads: number;
  ping: number | null;
  late: Delivery | null;
  e4: string;
  edgeOther: string;
  // By mode: the verdict of one more observation of each next run of it.
  extra: Record<string, string[]>;
  // Whether each next edge run saves its run (true when none is left).
  edgeSaves: boolean[];
  mergeSha: string;
  mergeState: string;
};

let bin: string;
let root: string;
let fixture: FixtureGit;
let origin: FixtureRepo;
let seed: FixtureRepo;
let host: FixtureRepo;
let commit: string;
let env: Record<string, string>;
let settings: v.InferOutput<typeof Fixture>;
let server: Server;
let world: World;
let calls: Call[];
let hookPatches: unknown[];
let appKey: { pem: string; publicKey: KeyObject };
let clone: string;
let created: { resolve: () => void; promise: Promise<void> };

const stateDir = () => join(root, "state", "prq");
const deploys = () => join(stateDir(), "deploys");

function deferred() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { resolve: () => resolve(), promise };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

// A release record as the deploy writes it, of this target unless target says otherwise.
async function writeRecord(
  upload: "complete" | "incomplete",
  target: { accountId?: string; host?: string; sha?: string } = {},
  readBack: { state: string; reason: string; at: string } | null = null,
): Promise<string> {
  const dir = join(deploys(), `${new Date().toISOString().replaceAll(":", "-")}-${TAG}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, "record.json"),
    JSON.stringify({
      kind: "prq-deploy",
      tag: TAG,
      sha: target.sha ?? world.mergeSha,
      accountId: target.accountId ?? ACCOUNT,
      host: target.host ?? HOST,
      clone,
      outcome: upload === "complete" ? "deployed" : "uploading",
      upload: { exit: upload === "complete" ? 0 : null },
      readBack:
        upload === "complete"
          ? { state: "complete", reason: "provisioning observed", at: new Date().toISOString() }
          : readBack,
    }),
    { mode: 0o600 },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  return dir;
}

// What the existing commands, check:deployed and docker answer.
async function commands(call: Call, io: Out): Promise<number> {
  const [name = "", ...args] = call.args;
  const line = [name, ...args].join(" ");
  if (line === "setup check" || line === "setup repository" || line === "docker info") {
    return 0;
  }
  if (name === "release-check") {
    return args.join(" ") === `${TAG} --pre-tag ${world.mergeSha}` ? 0 : 1;
  }
  if (line === "deploy --bootstrap" || line === "deploy --bootstrap --resume") {
    if (line === "deploy --bootstrap" && world.bootstrapFirst !== 0) {
      io.err(`deploy: the Worker prq has a live version\n`);
      return world.bootstrapFirst;
    }
    const dir = join(deploys(), "bootstrap");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeJson(join(dir, `${Date.now()}.json`), {
      kind: "prq-bootstrap",
      accountId: ACCOUNT,
      worker: "prq",
      versionId: BOOTSTRAP_VERSION,
      tag: "prq-bootstrap",
      subdomain: SUBDOMAIN,
    });
    return 0;
  }
  if (line === "secrets put") {
    return world.secretsPut.shift() ?? 0;
  }
  if (line === "secrets status") {
    const code = world.secretsStatus.shift() ?? 0;
    if (code === 0) {
      io.out("secrets: missing: none\nsecrets: not expected: none\n");
    }
    return code;
  }
  if (line === `deploy ${TAG}`) {
    if (world.deploy === "declined") {
      const dir = join(deploys(), `${new Date().toISOString().replaceAll(":", "-")}-${TAG}`);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeJson(join(dir, "record.json"), {
        kind: "prq-deploy",
        tag: TAG,
        sha: world.mergeSha,
        accountId: ACCOUNT,
        host: HOST,
        clone,
        outcome: "declined",
        upload: null,
        readBack: null,
      });
      io.err("deploy: declined: nothing deployed\n");
      return 1;
    }
    await writeRecord("complete");
    return 0;
  }
  if (name === "deploy" && args[0] === "--read-back") {
    const file = join(args[1] ?? "", "record.json");
    if (world.readBack === "fails") {
      io.err("deploy: EACCES: the record could not be written\n");
      return 1;
    }
    const record = JSON.parse(await readFile(file, "utf8"));
    const at = new Date().toISOString();
    record.readBack =
      world.readBack === "complete"
        ? { state: "complete", reason: "read back", at }
        : world.readBack === "unread"
          ? { state: "incomplete", reason: "what is live could not be read: the live versions: HTTP 503", at }
          : { state: "incomplete", reason: `the upload did not finish (uploading): deploy ${TAG} again`, at };
    await writeFile(file, JSON.stringify(record));
    return world.readBack === "complete" ? 0 : world.readBack === "again, exit 1" ? 1 : 2;
  }
  if (name === "check:deployed") {
    let invocation;
    try {
      invocation = parseInvocation(args);
    } catch (error) {
      io.err(`check:deployed: ${error instanceof Error ? error.message : "usage"}\n`);
      return 1;
    }
    const observations: { id: string; what: string; verdict: string }[] = [];
    const notes: string[] = [];
    if (invocation.mode === "edge") {
      observations.push(
        { id: "E4", what: "the ledger", verdict: world.e4 },
        { id: "E2", what: "a wrong secret", verdict: world.edgeOther },
      );
    } else if (invocation.mode === "summary") {
      io.out(`  open a new pull request in ${invocation.repo} now; this waits up to 30 min\n`);
      if (world.summaryTakes === "hang") {
        await new Promise(() => {});
      }
      await created.promise;
      const number = world.summaryTakes === "other" ? 999 : (world.prs.at(-1)?.number ?? 0);
      observations.push({ id: "S2", what: `the owner of ${invocation.repo}#${number}`, verdict: "pass" });
    } else if (invocation.mode === "jobs") {
      notes.push(...world.jobsNotes(`${invocation.pr.owner}/${invocation.pr.repo}#${invocation.pr.number}`));
    } else {
      observations.push({ id: invocation.mode, what: invocation.mode, verdict: "pass" });
    }
    const extra = world.extra[invocation.mode]?.shift();
    if (extra !== undefined) {
      observations.push({ id: "X1", what: "one more", verdict: extra });
    }
    if (invocation.mode === "edge" && world.edgeSaves.shift() === false) {
      return 1;
    }
    if (invocation.json !== undefined) {
      await writeJson(invocation.json, { mode: invocation.mode, observations, notes });
    }
    return observations.some((each) => each.verdict === "fail") ? 1 : 0;
  }
  io.err(`the stand-in has no answer for ${line}\n`);
  return 3;
}

// What gh answers.
async function ghAnswer(call: Call, io: Out): Promise<number> {
  const args = call.args;
  const line = args.join(" ");
  const json = (value: unknown) => {
    io.out(JSON.stringify(value));
    return 0;
  };
  if (line === "auth status") {
    return 0;
  }
  if (line === "api user") {
    return json({ login: "octo-host", id: HOST_ID });
  }
  if (line.startsWith("pr view")) {
    return json({
      state: world.mergeState,
      title: `chore(release): ${TAG}`,
      baseRefName: "main",
      mergeCommit: { oid: world.mergeSha },
    });
  }
  if (line === `api repos/${REPOSITORY}/immutable-releases --jq .enabled`) {
    io.out("true\n");
    return 0;
  }
  if (line === `api repos/${REPOSITORY}/releases/tags/${TAG}`) {
    if (world.release === "after-run") {
      io.err("gh: Not Found (HTTP 404)\n");
      return 1;
    }
    const assets = world.release === "missing-asset" ? ASSETS.slice(1) : ASSETS;
    return json({
      draft: false,
      immutable: world.release !== "mutable",
      assets: assets.map((name) => ({ name, state: "uploaded" })),
    });
  }
  if (args[0] === "run" && args[1] === "list") {
    return json(
      world.runAppears ? [{ databaseId: WORKFLOW_RUN, headSha: world.runSha ?? world.mergeSha, headBranch: TAG }] : [],
    );
  }
  if (args[0] === "run" && args[1] === "view") {
    if (world.release === "after-run") {
      world.release = "published";
    }
    return json({
      status: "completed",
      conclusion: "success",
      jobs: [{ name: "Publish", status: "completed", conclusion: "success" }],
    });
  }
  if (line === `api repos/${TEST_REPO}`) {
    return json({ default_branch: "main" });
  }
  if (line === `api repos/${TEST_REPO}/git/ref/heads/main`) {
    if (world.testRepoEmpty) {
      io.err("gh: Git Repository is empty. (HTTP 409)\n");
      return 1;
    }
    return json({ object: { sha: "a".repeat(40) } });
  }
  if (
    line.startsWith(`api --method POST repos/${TEST_REPO}/git/refs`) ||
    line.startsWith(`api --method PUT repos/${TEST_REPO}/contents/`)
  ) {
    return json({});
  }
  if (args[0] === "pr" && args[1] === "list") {
    const branch = args[args.indexOf("--head") + 1];
    return json(
      world.prs
        .filter((row) => row.branch === branch)
        .map(({ number, headRefOid, state, author }) => ({ number, headRefOid, state, author })),
    );
  }
  if (args[0] === "pr" && args[1] === "create") {
    const number = 41;
    const branch = args[args.indexOf("--head") + 1] ?? "";
    world.prs.push({ number, headRefOid: "b".repeat(40), branch, state: "OPEN", author: { login: "octo-host" } });
    created.resolve();
    io.out(`https://github.com/${TEST_REPO}/pull/${number}\n`);
    return 0;
  }
  io.err(`the stand-in for gh has no answer for ${line}\n`);
  return 3;
}

// GitHub's REST API for the App: its token checked against the App's key.
async function githubApi(method: string, url: string, authorization: string, body: string): Promise<[number, unknown]> {
  try {
    await jwtVerify(authorization.replace(/^Bearer /, ""), appKey.publicKey, { algorithms: ["RS256"] });
  } catch {
    return [401, { message: "A JSON web token could not be decoded" }];
  }
  if (method === "PATCH" && url === "/api/app/hook/config") {
    hookPatches.push(JSON.parse(body));
    return [200, {}];
  }
  if (url === "/api/app/hook/config") {
    const last = v.parse(v.record(v.string(), v.unknown()), hookPatches.at(-1) ?? {});
    return [
      200,
      { url: last["url"], content_type: last["content_type"], insecure_ssl: last["insecure_ssl"], secret: "********" },
    ];
  }
  if (url === "/api/app") {
    return [200, { id: APP_ID, slug: "octo-host-prq", events: world.events.shift() ?? ["pull_request"] }];
  }
  if (url.startsWith("/api/app/hook/deliveries")) {
    world.deliveryReads++;
    if (world.deliveryReads === 2) {
      if (world.late !== null) {
        world.deliveries.unshift(world.late);
      }
      if (world.ping !== null) {
        world.deliveries.unshift({
          id: 100,
          event: "ping",
          status_code: world.ping,
          delivered_at: new Date().toISOString(),
        });
      }
    }
    return [200, world.deliveries];
  }
  return [404, { message: "Not Found" }];
}

beforeAll(async () => {
  bin = await fixtureRoot("prq-first-deploy-bin-");
  for (const tool of ["commands", "gh"]) {
    await writeFile(join(bin, tool), program(tool), { mode: 0o700 });
    await new Promise<void>((resolve) => {
      execFile(join(bin, tool), [], { timeout: 60_000, env: { FD_STAND_IN: "http://127.0.0.1:9" } }, () => resolve());
    });
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  appKey = { pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey };
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      void (async () => {
        if (request.url === "/run") {
          const call = v.parse(CallSchema, JSON.parse(body));
          calls.push(call);
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          const io: Out = {
            out: (text) => response.write(`${JSON.stringify({ out: text })}\n`),
            err: (text) => response.write(`${JSON.stringify({ err: text })}\n`),
          };
          const code = await (call.tool === "gh" ? ghAnswer(call, io) : commands(call, io));
          response.end(`${JSON.stringify({ code })}\n`);
          return;
        }
        const [status, value] = await githubApi(
          request.method ?? "GET",
          request.url ?? "",
          request.headers.authorization ?? "",
          body,
        );
        response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}, 120_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(bin, { recursive: true, force: true });
});

async function writePrivate(name: string, text: string): Promise<void> {
  await writeFile(join(root, "deploy", name), text, { mode: 0o600 });
}

beforeEach(async () => {
  root = await fixtureRoot("prq-first-deploy-");
  fixture = await FixtureGit.create(root, { [`https://github.com/${REPOSITORY}.git`]: "origin.git" });
  origin = await fixture.init("origin.git", { bare: true });
  seed = await fixture.init("seed");
  await mkdir(join(seed.path, ".github", "workflows"), { recursive: true });
  await writeFile(join(seed.path, ".github", "workflows", "release.yml"), "name: Release\n");
  await seed.add(".github");
  await seed.commit("chore(release): v0.1.0");
  commit = await seed.headCommit();
  // main has moved on since the release's merge commit: the host's clone is not at it.
  await writeFile(join(seed.path, "NEWS.md"), "after the release\n");
  await seed.add("NEWS.md");
  await seed.commit("docs: add news");
  await seed.push(origin, "HEAD:refs/heads/main");
  host = await fixture.clone(origin, "host");
  clone = join(root, "clone");
  await mkdir(join(clone, "packages", "cli"), { recursive: true });
  await mkdir(join(root, "deploy"), { mode: 0o700 });
  await writePrivate("target.env", `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nPRQ_HOST=${HOST}\n`);
  await writePrivate(
    "worker.env",
    `ACCESS_TEAM_DOMAIN=${TEAM}\nACCESS_AUD=${AUD}\nGITHUB_APP_ID=${APP_ID}\nWEBHOOK_SECRET=${WEBHOOK_SECRET}\nHOST_GITHUB_ID=${HOST_ID}\n`,
  );
  await writePrivate(
    "access.env",
    `PRQ_URL=https://${HOST}\nPRQ_ACCESS_CLIENT_ID=${CLIENT_ID}\nPRQ_ACCESS_CLIENT_SECRET=${CLIENT_SECRET}\n`,
  );
  await writePrivate("github-app.pk8.pem", appKey.pem);
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  await writeFile(
    join(stateDir(), "setup.json"),
    JSON.stringify({
      githubApp: { testRepository: TEST_REPO },
      rehearsal: { outcome: "passed", sha: commit, repository: REPOSITORY },
    }),
    { mode: 0o600 },
  );
  world = {
    bootstrapFirst: 0,
    secretsPut: [],
    secretsStatus: [],
    readBack: "complete",
    deploy: "complete",
    release: "published",
    runAppears: true,
    runSha: null,
    testRepoEmpty: false,
    prs: [],
    jobsNotes: (name) => [`${name}: owner cloud, head ${"c".repeat(40)}, 1 jobs`],
    summaryTakes: "new",
    events: [],
    deliveries: [],
    deliveryReads: 0,
    ping: 200,
    late: null,
    e4: "pass",
    edgeOther: "pass",
    extra: {},
    edgeSaves: [],
    mergeSha: commit,
    mergeState: "MERGED",
  };
  calls = [];
  hookPatches = [];
  created = deferred();
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  env = {
    ...fixture.env,
    PATH: fixture.env["PATH"] ?? "",
    XDG_STATE_HOME: join(root, "state"),
    FD_STAND_IN: `http://127.0.0.1:${port}`,
  };
  settings = {
    commands: join(bin, "commands"),
    gh: join(bin, "gh"),
    stateDir: stateDir(),
    directory: join(root, "deploy"),
    githubApi: `http://127.0.0.1:${port}/api`,
    githubWeb: "https://github.invalid",
    waitMs: 15_000,
    stepMs: 3_000,
    pollMs: 50,
    followMs: 1_000,
  };
});

const started: ChildProcess[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await rm(root, { recursive: true, force: true });
});

type Result = { code: number | null; output: string };

// A call's arguments less its --json and the file.
function withoutJson(args: string[]): string {
  const at = args.indexOf("--json");
  return (at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)]).join(" ");
}

// The driver with these arguments in the host's clone, on a terminal, answering each [y/N] question in turn. Its
// output never holds a secret.
function firstDeploy(
  args: string[],
  { answers = [], extraEnv = {} }: { answers?: Answer[]; extraEnv?: Record<string, string> } = {},
) {
  const file = join(root, "fixture.json");
  writeFileSync(file, JSON.stringify(settings));
  const { child, result } = runInTerminal([process.execPath, TEST_ENTRY, file, "first-deploy", ...args], {
    cwd: host.path,
    env: { ...env, ...extraEnv },
    answers,
    prompt: /\[y\/N\] /,
  });
  started.push(child);
  return {
    child,
    result: result.then((outcome): Result => {
      for (const secret of SECRETS) {
        expect(outcome.output).not.toContain(secret);
      }
      return outcome;
    }),
  };
}

function run(args: string[], options: { answers?: Answer[]; extraEnv?: Record<string, string> } = {}): Promise<Result> {
  return firstDeploy(args, options).result;
}

const lines = (tool?: string) =>
  calls.filter((each) => tool === undefined || each.tool === tool).map((each) => each.args.join(" "));

// The answers of a fresh --tag run: signed in, Active saved, the test pull request opened.
const FRESH = ["y", "y", "y"];

async function progress(): Promise<Record<string, unknown>> {
  const state = JSON.parse(await readFile(join(stateDir(), "setup.json"), "utf8"));
  return state.firstDeploy;
}

// The setup's state file with these keys changed.
async function changeState(change: Record<string, unknown>): Promise<void> {
  const state = JSON.parse(await readFile(join(stateDir(), "setup.json"), "utf8"));
  await writeFile(join(stateDir(), "setup.json"), JSON.stringify({ ...state, ...change }));
}

// The release tag on origin, annotated on the merge commit.
async function published(): Promise<void> {
  await seed.tagAnnotated(TAG, commit, TAG);
  await seed.push(origin, `refs/tags/${TAG}`);
}

const OWNER = { login: "octo-host" };

describe("first-deploy --tag", () => {
  it("runs a published tag to a summary and an answer on the test pull request, then does nothing again", async () => {
    await published();

    const result = await run(["--tag", TAG], { answers: FRESH });

    expect(result.output).toContain("first-deploy: done");
    expect(result.code).toBe(0);
    expect(calls.filter((each) => each.tool === "commands").map((each) => withoutJson(each.args))).toEqual([
      "setup check",
      "docker info",
      "deploy --bootstrap",
      `check:deployed endpoints ${SUBDOMAIN} --version ${BOOTSTRAP_VERSION}`,
      "secrets put",
      "secrets status",
      `deploy ${TAG}`,
      `check:deployed edge --team-domain ${TEAM}`,
      `check:deployed endpoints ${SUBDOMAIN}`,
      "check:deployed pool",
      `check:deployed summary ${TEST_REPO}`,
      `check:deployed ask ${TEST_REPO}#41 What does this pull request change?`,
      `check:deployed edge --team-domain ${TEAM} --pr ${TEST_REPO}#41`,
    ]);
    // The tag's checks run in the deploy's clone with the service token; the bootstrap's from this checkout.
    const checks = calls.filter((each) => each.args[0] === "check:deployed");
    expect(checks[0]?.cwd).not.toBe(join(clone, "packages", "cli"));
    for (const each of checks.slice(1)) {
      expect(each.cwd).toBe(join(clone, "packages", "cli"));
    }
    const edge = checks[1];
    expect(edge?.env).toEqual({ url: `https://${HOST}`, id: CLIENT_ID, secret: CLIENT_SECRET });
    // No secret in any argument.
    for (const each of calls) {
      for (const secret of SECRETS) {
        expect(each.args.join(" ")).not.toContain(secret);
      }
    }
    expect(hookPatches).toEqual([
      { url: `https://${HOST}/webhook`, secret: WEBHOOK_SECRET, content_type: "json", insecure_ssl: "0" },
    ]);
    // The saved runs' paths come before the report, which holds no deployment value, version or path.
    const at = result.output.indexOf("first-deploy: report\n");
    expect(at).toBeGreaterThan(-1);
    expect(result.output.slice(0, at)).toContain(join(stateDir(), "first-deploy", TAG));
    const report = result.output.slice(at, result.output.indexOf("first-deploy: done"));
    for (const value of [...DEPLOYMENT, ...SECRETS, CLIENT_ID, TAG, root]) {
      expect(report).not.toContain(value);
    }
    expect(report).toContain("served: check:deployed edge: 2 pass, 0 fail, 0 unattributed, 0 unexercised");
    expect(report).toContain("webhook: the ping pass");

    calls = [];
    const again = await run(["--tag", TAG]);
    expect(again.code).toBe(0);
    expect(again.output).toContain("summary: done (recorded)");
    expect(calls).toEqual([]);
  });

  it("refuses a tag origin lacks, or a lightweight one, before any command", async () => {
    const missing = await run(["--tag", TAG]);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain(`first-deploy: release-sha: origin has no tag ${TAG}`);

    await seed.tag(TAG, commit);
    await seed.push(origin, `refs/tags/${TAG}`);
    calls = [];
    const light = await run(["--tag", TAG]);
    expect(light.code).toBe(1);
    expect(light.output).toContain(`origin's ${TAG} is a lightweight tag`);
    expect(lines("commands")).not.toContain(`deploy ${TAG}`);
  });

  it("resumes a bootstrap that stopped with its version live", async () => {
    await published();
    world.bootstrapFirst = 1;

    const result = await run(["--tag", TAG, "--from", "preflight"], { answers: ["n"] });

    expect(lines("commands").slice(2, 5)).toEqual([
      "deploy --bootstrap",
      "deploy --bootstrap --resume",
      expect.stringMatching(/^check:deployed endpoints sentinel-sub --version /),
    ]);
    expect(result.output).toContain("served: the browser's way through Access is not confirmed");
  });

  it("retries a secrets put whose write was not acknowledged until one is", async () => {
    await published();
    world.secretsPut = [2, 2, 0];

    await run(["--tag", TAG], { answers: ["n"] });

    expect(lines("commands").filter((line) => line === "secrets put")).toHaveLength(3);
    expect(lines("commands")).toContain("secrets status");
  });

  it("reads an unfinished upload back before deploying, and deploys again only when the read-back says to", async () => {
    await published();
    const first = await writeRecord("incomplete");

    await run(["--tag", TAG], { answers: ["n"] });
    expect(lines("commands").filter((line) => line.startsWith("deploy "))).toEqual([
      "deploy --bootstrap",
      `deploy --read-back ${first}`,
    ]);
    expect(await progress()).toMatchObject({ deployRecord: first });

    calls = [];
    const second = await writeRecord("incomplete");
    world.readBack = "deploy again";
    await run(["--tag", TAG, "--from", "deploy"], { answers: ["n"] });
    expect(lines("commands").filter((line) => line.startsWith("deploy "))).toEqual([
      `deploy --read-back ${second}`,
      `deploy ${TAG}`,
    ]);
    expect(await progress()).not.toMatchObject({ deployRecord: second });
  });

  it("uploads nothing on an earlier verdict when this read-back recorded none", async () => {
    await published();
    // An earlier read-back said the upload did not finish; this one fails before it records anything.
    const first = await writeRecord(
      "incomplete",
      {},
      {
        state: "incomplete",
        reason: `the upload did not finish (uploading): deploy ${TAG} again`,
        at: new Date(Date.now() - 60_000).toISOString(),
      },
    );
    world.readBack = "fails";

    const stopped = await run(["--tag", TAG]);

    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain("deploy --read-back exited 1 without recording its verdict");
    expect(stopped.output).toContain(`deploy -- --read-back ${first}`);
    expect(lines("commands")).not.toContain(`deploy ${TAG}`);

    // Its verdict written, but not the exit that goes with it.
    world.readBack = "again, exit 1";
    const odd = await run(["--tag", TAG]);
    expect(odd.code).toBe(1);
    expect(odd.output).toContain("deploy --read-back exited 1");
    expect(lines("commands")).not.toContain(`deploy ${TAG}`);
  });

  it("names the deploy, not a read-back, as the next step when it stopped before the upload", async () => {
    await published();
    world.deploy = "declined";

    const stopped = await run(["--tag", TAG]);
    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain(
      "it stopped before the upload: declined; once what it names is resolved, first-deploy --from deploy runs the deploy again",
    );
    expect(stopped.output).not.toContain("--read-back");

    calls = [];
    world.deploy = "complete";
    await run(["--tag", TAG], { answers: ["n"] });
    expect(lines("commands").filter((line) => line.startsWith("deploy "))).toEqual([`deploy ${TAG}`]);
  });

  it("uploads nothing when the read-back could not read what is live, naming the read-back as the next step", async () => {
    await published();
    const first = await writeRecord("incomplete");
    world.readBack = "unread";

    const stopped = await run(["--tag", TAG]);
    expect(stopped.code).toBe(2);
    expect(stopped.output).toContain(`deploy -- --read-back ${first}`);
    expect(lines("commands")).not.toContain(`deploy ${TAG}`);

    calls = [];
    world.readBack = "complete";
    await run(["--tag", TAG], { answers: ["n"] });
    expect(lines("commands").filter((line) => line.startsWith("deploy "))).toEqual([`deploy --read-back ${first}`]);
    expect(await progress()).toMatchObject({ deployRecord: first });
  });

  it.each([
    ["another account", { accountId: "f".repeat(32) }],
    ["another hostname", { host: "prq.other-host.test" }],
    ["another commit", { sha: "e".repeat(40) }],
  ])("does not adopt a record of the tag for %s", async (_what, target) => {
    await published();
    const other = await writeRecord("incomplete", target);

    await run(["--tag", TAG], { answers: ["n"] });

    expect(lines("commands")).not.toContain(`deploy --read-back ${other}`);
    expect(lines("commands")).toContain(`deploy ${TAG}`);
    expect(await progress()).not.toMatchObject({ deployRecord: other });
  });

  it("names how to make a deploy's clone again when it is gone, and goes on from it without deploying", async () => {
    await published();
    await run(["--tag", TAG], { answers: ["n"] });
    await rm(clone, { recursive: true });

    calls = [];
    const gone = await run(["--tag", TAG]);
    expect(gone.code).toBe(1);
    expect(gone.output).toContain(`the deploy's clone ${clone} is gone`);
    expect(gone.output).toContain(`git clone --branch ${TAG} https://github.com/${REPOSITORY}.git ${clone}`);

    await mkdir(join(clone, "packages", "cli"), { recursive: true });
    const again = await run(["--tag", TAG, "--from", "served"], { answers: ["n"] });
    expect(again.output).toContain("Signed in, and saw");
    expect(lines("commands").filter((line) => line.startsWith("deploy"))).toEqual([]);
  });

  it("reads the secrets again without putting them when only their status failed", async () => {
    await published();
    world.secretsStatus = [1];

    const failed = await run(["--tag", TAG]);
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("secrets status exited 1");
    expect(lines("commands").filter((line) => line.startsWith("secrets "))).toEqual(["secrets put", "secrets status"]);

    calls = [];
    await run(["--tag", TAG], { answers: ["n"] });
    expect(lines("commands").filter((line) => line.startsWith("secrets "))).toEqual(["secrets status"]);

    // Starting over at the bootstrap neither deploys nor checks it, nor puts the secrets again.
    calls = [];
    await run(["--tag", TAG, "--from", "bootstrap"], { answers: ["n"] });
    expect(
      lines("commands").filter(
        (line) => line.startsWith("secrets ") || line.startsWith("deploy --") || line.includes(" --version "),
      ),
    ).toEqual(["secrets status"]);
  });

  it("asks for the dashboard's evidence of an unexercised address, and reuses the bootstrap's record", async () => {
    await published();
    world.extra = { endpoints: ["unexercised"] };

    const declined = await run(["--tag", TAG], { answers: ["n"] });
    expect(declined.code).toBe(1);
    expect(declined.output).toContain("are workers.dev and Preview URLs disabled?");
    expect(declined.output).toContain("unexercised, and the dashboard does not show both off");

    calls = [];
    world.extra = { endpoints: ["unexercised"] };
    await run(["--tag", TAG], { answers: ["y", "n"] });
    expect(lines("commands").filter((line) => line.startsWith("deploy --bootstrap"))).toEqual([]);
    expect(lines("commands")).toContain("secrets put");
  });

  it("asks for Access's logs of an unattributed denial, and refuses it unless they show it", async () => {
    await published();
    world.extra = { edge: ["unattributed"] };

    const declined = await run(["--tag", TAG], { answers: ["y", "n"] });
    expect(declined.code).toBe(1);
    expect(declined.output).toContain("Do Zero Trust's Access logs show X1 refused by Access");
    expect(declined.output).toContain("X1 (one more) unattributed: not found in Access's logs");

    world.extra = { edge: ["unattributed"] };
    const found = await run(["--tag", TAG], { answers: ["y", "y", "n"] });
    expect(found.output).toContain("webhook: the webhook is not active");
  });

  it("resumes the served step past its accepted edge check, asking nothing again", async () => {
    await published();
    // The bootstrap's endpoints pass; the served step's first fail.
    world.extra = { endpoints: ["pass", "fail"] };

    const failed = await run(["--tag", TAG], { answers: ["y"] });
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("served: X1 (one more) failed");

    const resumed = await run(["--tag", TAG], { answers: ["n"] });
    expect(resumed.output).not.toContain("Signed in, and saw");
    expect(resumed.output).toContain("check:deployed edge: accepted earlier");
    expect(lines("commands").filter((line) => line.startsWith("check:deployed edge"))).toHaveLength(1);
    expect(resumed.output).toContain("webhook: the webhook is not active");
  });

  it("keeps an unexercised answer pending, and does not ask again once it passed", async () => {
    await published();
    // The served edge passes; the ask's edge first fails.
    world.extra = { ask: ["unexercised"], edge: ["pass", "fail"] };

    const pending = await run(["--tag", TAG], { answers: FRESH });
    expect(pending.code).toBe(1);
    expect(pending.output).toContain("ask: X1 (one more) unexercised");

    const edgeFailed = await run(["--tag", TAG]);
    expect(edgeFailed.code).toBe(1);
    expect(edgeFailed.output).toContain("ask: X1 (one more) failed");

    const done = await run(["--tag", TAG]);
    expect(done.code).toBe(0);
    expect(lines("commands").filter((line) => line.startsWith("check:deployed ask"))).toHaveLength(2);
    // The served step's question was not asked again.
    expect(edgeFailed.output).not.toContain("Signed in, and saw");
    expect(done.output).not.toContain("Signed in, and saw");
  });

  it("takes the test pull request already on its branch by its jobs, opening none", async () => {
    await published();
    const head = "c".repeat(40);
    world.prs = [{ number: 40, headRefOid: head, branch: BRANCH, state: "OPEN", author: OWNER }];
    world.jobsNotes = (name) => [
      `${name}: owner cloud, head ${head}, 1 jobs`,
      `00000000-0000-4000-8000-000000000001 analysis of ${head}: done, rev 1, by cloud`,
    ];

    const result = await run(["--tag", TAG], { answers: ["y", "y"] });

    expect(result.code).toBe(0);
    expect(result.output).toContain("summary: check:deployed jobs: 2 pass, 0 fail, 0 unattributed, 0 unexercised");
    expect(lines("commands").some((line) => line.startsWith(`check:deployed jobs ${TEST_REPO}#40 --json `))).toBe(true);
    expect(lines("commands").some((line) => line.startsWith("check:deployed summary"))).toBe(false);
    expect(lines("gh").some((line) => line.startsWith("pr create"))).toBe(false);
    expect(
      lines("commands").some((line) =>
        line.startsWith(`check:deployed ask ${TEST_REPO}#40 What does this pull request change?`),
      ),
    ).toBe(true);
  });

  it("refuses a test pull request whose analysis at its head is not done", async () => {
    await published();
    world.prs = [{ number: 40, headRefOid: "c".repeat(40), branch: BRANCH, state: "OPEN", author: OWNER }];

    const result = await run(["--tag", TAG], { answers: ["y", "y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(`the analysis of ${TEST_REPO}#40 at ${"c".repeat(40)} is not done`);
  });

  it("opens the test pull request on the next branch when the branch's pull request was closed", async () => {
    await published();
    world.prs = [{ number: 40, headRefOid: "c".repeat(40), branch: BRANCH, state: "CLOSED", author: OWNER }];

    const result = await run(["--tag", TAG], { answers: FRESH });

    expect(result.code).toBe(0);
    expect(lines("gh").filter((line) => line.startsWith("pr create"))).toEqual([
      expect.stringContaining(`--head ${BRANCH}-2 `),
    ]);
    expect(lines("commands")).not.toContainEqual(expect.stringContaining(`${TEST_REPO}#40`));
    expect(await progress()).toMatchObject({ testPr: { branch: `${BRANCH}-2`, number: 41 } });
  });

  it("refuses an open test pull request another account opened", async () => {
    await published();
    world.prs = [
      { number: 40, headRefOid: "c".repeat(40), branch: BRANCH, state: "OPEN", author: { login: "someone-else" } },
    ];

    const result = await run(["--tag", TAG], { answers: ["y", "y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(`${TEST_REPO}#40 on ${BRANCH} was opened by another account`);
    expect(lines("commands")).not.toContainEqual(expect.stringContaining("check:deployed jobs"));
  });

  it("fails a summary that took another pull request than the one it opened", async () => {
    await published();
    world.summaryTakes = "other";

    const result = await run(["--tag", TAG], { answers: FRESH });

    expect(result.code).toBe(1);
    expect(result.output).toContain(`took another pull request than the test pull request ${TEST_REPO}#41`);
    expect(await progress()).toMatchObject({ testPr: { repository: TEST_REPO, branch: BRANCH, number: 41 } });
  });

  it("stops the summary's check, and what it started, when it is stopped", async () => {
    await published();
    world.summaryTakes = "hang";
    const { result } = firstDeploy(["--tag", TAG], { answers: ["y", "y"] });
    const deadline = Date.now() + 30_000;
    let summary: Call | undefined;
    while (summary === undefined && Date.now() < deadline) {
      summary = calls.find((each) => each.args[1] === "summary");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(summary).toBeDefined();
    process.kill(summary?.ppid ?? 0, "SIGTERM");

    await result;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(summary?.pid ?? 0, 0)).toThrow("ESRCH");
  }, 60_000);

  it("confirms a rotated service token once the edge's E4 passed with it, and not when it failed", async () => {
    await published();
    const state = JSON.parse(await readFile(join(stateDir(), "setup.json"), "utf8"));
    await writeFile(
      join(stateDir(), "setup.json"),
      JSON.stringify({ ...state, serviceToken: { id: "t1", clientId: CLIENT_ID, confirmed: false } }),
    );
    world.e4 = "fail";

    const failed = await run(["--tag", TAG], { answers: ["y"] });
    expect(failed.code).toBe(1);
    const token = async () => JSON.parse(await readFile(join(stateDir(), "setup.json"), "utf8")).serviceToken;
    expect(await token()).toMatchObject({ confirmed: false });

    // E4 passed, while another assertion failed.
    world.e4 = "pass";
    world.edgeOther = "fail";
    const passed = await run(["--tag", TAG], { answers: ["y"] });
    expect(passed.code).toBe(1);
    expect(await token()).toMatchObject({ confirmed: true });

    // A secret rotated since: an edge run that saved nothing confirms nothing, whatever an earlier run read.
    await changeState({ serviceToken: { id: "t2", clientId: CLIENT_ID, confirmed: false } });
    world.edgeSaves = [false];
    const unsaved = await run(["--tag", TAG], { answers: ["y"] });
    expect(unsaved.code).toBe(1);
    expect(await token()).toMatchObject({ id: "t2", confirmed: false });
  });

  it("asks for the Pull request event until the App subscribes to it, and refuses a ping the Worker refused", async () => {
    await published();
    // The slug's read, then the event's.
    world.events = [[], []];
    world.ping = 401;

    const result = await run(["--tag", TAG], { answers: ["y", "y", "y"] });

    expect(result.output).toContain("tick Pull request under Subscribe to events");
    expect(result.output).toContain("GitHub's ping got HTTP 401 (the secret differs from the Worker's WEBHOOK_SECRET)");
    expect(result.code).toBe(1);
  });

  it("leaves the ping unexercised when GitHub sends none in time", async () => {
    await published();
    // A ping answered before this update proves nothing of it.
    world.deliveries = [{ id: 7, event: "ping", status_code: 200, delivered_at: new Date().toISOString() }];
    world.ping = null;

    await run(["--tag", TAG], { answers: FRESH });

    expect(await progress()).toMatchObject({ webhook: "unexercised" });
  });

  it("leaves the ping unexercised when the new one was delivered before the update, to the old configuration", async () => {
    await published();
    world.ping = null;
    world.late = { id: 9, event: "ping", status_code: 200, delivered_at: new Date(Date.now() - 60_000).toISOString() };

    await run(["--tag", TAG], { answers: FRESH });

    expect(await progress()).toMatchObject({ webhook: "unexercised" });
  });

  it("refuses a test repository without a commit on its default branch before the deploy", async () => {
    await published();
    world.testRepoEmpty = true;

    const result = await run(["--tag", TAG]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`the test repository ${TEST_REPO} has no commit on its default branch main`);
    expect(lines("commands")).not.toContainEqual(expect.stringMatching(/^deploy /));
  });

  it("refuses a release whose tag is no longer on the recorded commit, or that lacks an archive", async () => {
    await published();
    await run(["--tag", TAG, "--from", "preflight"], { answers: ["n"] });
    const recorded = await progress();
    await changeState({ firstDeploy: { ...recorded, sha: "e".repeat(40) } });

    const moved = await run(["--tag", TAG, "--from", "release"]);
    expect(moved.code).toBe(1);
    expect(moved.output).toContain(`release: origin's ${TAG} is not annotated on the recorded ${"e".repeat(40)}`);

    await changeState({ firstDeploy: recorded });
    world.release = "missing-asset";
    const missing = await run(["--tag", TAG, "--from", "release"]);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain(`${TAG} is not published, immutable, with its three archives`);

    world.release = "mutable";
    const mutable = await run(["--tag", TAG, "--from", "release"]);
    expect(mutable.code).toBe(1);
    expect(mutable.output).toContain(`${TAG} is not published, immutable, with its three archives`);

    // The only run of the workflow listed for the tag is at another commit.
    world.release = "published";
    world.runSha = "d".repeat(40);
    const other = await run(["--tag", TAG, "--from", "release"]);
    expect(other.code).toBe(1);
    expect(other.output).toContain(`no run of release.yml for the push of ${TAG} at ${commit}`);
  });

  it("refuses a run for another tag than the state records, unless it starts over", async () => {
    await published();
    await run(["--tag", TAG], { answers: ["n"] });

    calls = [];
    const other = await run(["--tag", "v0.1.1"]);
    expect(other.code).toBe(1);
    expect(other.output).toContain(`the state records the first deploy of ${TAG}`);
    expect(calls).toEqual([]);
  });

  it.each([
    ["an override", { CLOUDFLARE_API_TOKEN: "x" }, "CLOUDFLARE_API_TOKEN"],
    ["CI", { CI: "true" }, "marks this run as CI"],
  ])("refuses %s before any call", async (_what, extraEnv, line) => {
    const result = await run(["--tag", TAG], { extraEnv });
    expect(result.code).toBe(1);
    expect(result.output).toContain(line);
    expect(calls).toEqual([]);
  });
});

describe("first-deploy --create-tag", () => {
  it("tags the release pull request's merge commit, after the pre-tag check, and follows its release", async () => {
    world.release = "after-run";

    const result = await run(["--create-tag", "--release-pr", "61"], { answers: ["y", ...FRESH] });

    expect(result.code).toBe(0);
    expect(lines("commands").slice(0, 4)).toEqual([
      "setup check",
      "docker info",
      "setup repository",
      `release-check ${TAG} --pre-tag ${commit}`,
    ]);
    expect(await origin.refs()).toContain(`refs/tags/${TAG}`);
    expect(result.output).toContain(`first-deploy: pushed ${TAG}`);
    expect(lines("gh").some((line) => line.startsWith("run view"))).toBe(true);
  });

  it("adopts the tag origin already has on the merge commit (a lost push acknowledgement), asking nothing", async () => {
    await host.tagAnnotated(TAG, commit, TAG);
    await host.push(origin, `refs/tags/${TAG}`);

    const result = await run(["--create-tag", "--release-pr", "61"], { answers: ["n"] });

    expect(result.output).toContain(`first-deploy: origin's ${TAG} is annotated on ${commit}: adopted`);
    expect(result.output).not.toContain("Tag ");
  });

  it("pushes a matching local tag only on yes", async () => {
    await host.tagAnnotated(TAG, commit, TAG);

    const declined = await run(["--create-tag", "--release-pr", "61"], { answers: ["n"] });
    expect(declined.output).toContain(`nothing pushed; ${TAG} stays local`);
    expect(await origin.refs()).not.toContain(`refs/tags/${TAG}`);

    await run(["--create-tag", "--release-pr", "61"], { answers: ["y", "n"] });
    expect(await origin.refs()).toContain(`refs/tags/${TAG}`);
  });

  it("refuses a tag on another commit, pushing nothing", async () => {
    await writeFile(join(seed.path, "README.md"), "prq\n");
    await seed.add("README.md");
    await seed.commit("docs: add a readme");
    const other = await seed.headCommit();
    await seed.push(origin, "HEAD:refs/heads/main");
    await seed.tagAnnotated(TAG, other, TAG);
    await seed.push(origin, `refs/tags/${TAG}`);

    const result = await run(["--create-tag", "--release-pr", "61"], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(`first-deploy: tag: origin's ${TAG} tags ${other}, not ${commit}`);
  });

  it("refuses a release pull request that is not merged", async () => {
    world.mergeState = "OPEN";

    const result = await run(["--create-tag", "--release-pr", "61"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("pull request #61 is not merged into main");
    expect(lines("commands")).not.toContain(`release-check ${TAG} --pre-tag ${commit}`);
  });

  it("stops when the tag's release run does not appear in time", async () => {
    world.release = "after-run";
    world.runAppears = false;

    const result = await run(["--create-tag", "--release-pr", "61"], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(`no run of release.yml for the push of ${TAG} at ${commit} within 3 s`);
  });

  it.each([
    ["of another repository", { outcome: "passed", sha: "", repository: "someone/prq" }, "no passed rehearsal of"],
    ["at a commit origin lacks", { outcome: "passed", sha: "f".repeat(40), repository: REPOSITORY }, "git rev-parse"],
  ])("refuses a rehearsal %s before the tag", async (_what, rehearsal, line) => {
    await changeState({ rehearsal: { ...rehearsal, sha: rehearsal.sha === "" ? commit : rehearsal.sha } });

    const result = await run(["--create-tag", "--release-pr", "61"], { answers: ["y"] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(`pre-tag: ${line}`);
    expect(await origin.refs()).not.toContain(`refs/tags/${TAG}`);
  });
});
