// The secrets command (secrets.ts) run through the tests' entry (test-entry.ts), whose fixture gives it a deploy
// directory in the OS temp directory and a stand-in for wrangler that records each call's arguments, environment and
// stdin and answers as wrangler would (its own FAKE_* settings added to wrangler's environment). Every value below is a
// sentinel no output may hold, nor any line of a key.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

import { fixtureRoot } from "../../cli/src/test/git.ts";
import type { Fixture } from "./fixture.ts";

const SCRIPT = fileURLToPath(new URL("secrets.ts", import.meta.url));
const TEST_ENTRY = fileURLToPath(new URL("test-entry.ts", import.meta.url));
const CONFIG = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

const KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;
const SCALARS = {
  ACCESS_TEAM_DOMAIN: "https://sentinel-team.example",
  ACCESS_AUD: "sentinel-aud-5e3c0b9a7d1f4e2a",
  WEBHOOK_SECRET: "sentinel-webhook-secret-81f2",
  HOST_GITHUB_ID: "7340021",
  MODEL_BASE_URL: "https://sentinel-model.example/v1",
  MODEL_API_KEY: "sk-sentinel-api-key-0f9e8d7c",
  MODEL_ID: "sentinel/model-id:7741",
  MODEL_CONTEXT_TOKENS: "1048576",
  GITHUB_APP_ID: "918273645",
};
const NAMES = [...Object.keys(SCALARS), "GITHUB_APP_PRIVATE_KEY"];
const EXPECTED = { ...SCALARS, GITHUB_APP_PRIVATE_KEY: KEY };
const ACCOUNT = "5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e";
// What no output may hold: each value, and each line of a key.
// What put says when the outcome of its write is unknown.
const UNCONFIRMED =
  "the live secret update is unconfirmed. Retry the intended set until put exits 0, or restore the saved set and put " +
  "it until put exits 0 (docs/operations.md, Rotation)";
const STATUS_HINT = "`pnpm --dir packages/server run secrets status` (from the repository root)";
const keyLines = (key: string) => key.split("\n").filter((line) => line !== "" && !line.startsWith("-----"));
const SECRETS = [...Object.values(SCALARS), ...keyLines(KEY)];

// The stand-in for wrangler, run as wrangler is (an executable given its arguments). It appends one record per call
// to FAKE_WRANGLER_LOG and writes its pid, and its own child's, to FAKE_WRANGLER_PIDS. FAKE_WRANGLER_HANG names the
// call that never ends (and starts a child that never ends either), FAKE_WRANGLER_STUBBORN makes it ignore SIGTERM and
// FAKE_WRANGLER_TERM_EXIT_0 exit 0 on it, FAKE_WRANGLER_FAIL=list makes the Worker unreadable, FAKE_WRANGLER_BULK
// names how `secret bulk` fails (Cloudflare's API refusing it with a value quoted, a version not deployed, a response
// lost), FAKE_WRANGLER_ECHO makes `secret bulk` print what it read on both streams (as a log with sanitizing off
// would), FAKE_WRANGLER_SECRETS lists the Worker's secret names, and FAKE_WRANGLER_ACCOUNTS replaces the login's
// accounts. With WRANGLER_LOG=debug it prints a debug line first, as wrangler does.
const FAKE = `#!${process.execPath}
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const call = args[0] === "secret" ? args[1] : args[0];
const stdin = call === "bulk" ? readFileSync(0, "utf8") : null;
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ args, env: process.env, stdin }) + "\\n");
if (process.env.FAKE_WRANGLER_STUBBORN === "1") {
  process.on("SIGTERM", () => {});
}
if (process.env.FAKE_WRANGLER_TERM_EXIT_0 === "1") {
  process.on("SIGTERM", () => process.exit(0));
}
if (process.env.WRANGLER_LOG === "debug") {
  console.log("-- START CF API REQUEST: GET https://api.cloudflare.com/client/v4/memberships");
}
if (process.env.FAKE_WRANGLER_HANG === call) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.FAKE_WRANGLER_PIDS, JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
} else {
  const failing = process.env.FAKE_WRANGLER_FAIL === call;
  if (call === "whoami") {
    const accounts = process.env.FAKE_WRANGLER_ACCOUNTS ?? JSON.stringify([{ id: process.env.CLOUDFLARE_ACCOUNT_ID, name: "Synthetic Account" }]);
    console.log(JSON.stringify({ loggedIn: true, authType: "OAuth Token", email: "host@example.com", accounts: JSON.parse(accounts) }, null, 4));
  } else if (call === "list") {
    if (failing) {
      console.error("✘ [ERROR] Worker \\"prq\\" not found.");
      process.exit(1);
    }
    const names = (process.env.FAKE_WRANGLER_SECRETS ?? "").split(",").filter((name) => name !== "");
    console.log(JSON.stringify(names.map((name) => ({ name, type: "secret_text" })), null, "  "));
  } else if (call === "bulk") {
    const sent = JSON.parse(stdin);
    if (process.env.FAKE_WRANGLER_ECHO === "1") {
      console.log("INIT: " + JSON.stringify({ body: stdin }));
      console.error(stdin);
    }
    const errors = {
      api:
        "✘ [ERROR] A request to the Cloudflare API (/accounts/" + process.env.CLOUDFLARE_ACCOUNT_ID +
        "/workers/scripts/prq/secrets-bulk) failed.\\n\\n  " + sent.MODEL_API_KEY + " is not valid [code: 10021]",
      version:
        "✘ [ERROR] Secret edit failed. You attempted to modify a secret, but the latest version of your Worker isn't " +
        "currently deployed.\\nThis limitation exists to prevent accidental deployment",
      lost: "✘ [ERROR] Received a malformed response from the API",
    };
    const failure = process.env.FAKE_WRANGLER_BULK;
    if (failure !== undefined) {
      console.log("\\n🚨 Secrets failed to upload");
      console.error(errors[failure]);
      process.exit(1);
    }
    for (const name of Object.keys(sent)) {
      console.log("✨ Successfully created secret for key: " + name);
    }
  }
}
`;

const Call = v.object({
  args: v.array(v.string()),
  env: v.record(v.string(), v.string()),
  stdin: v.nullable(v.string()),
});
type Call = v.InferOutput<typeof Call>;
type Result = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

let fakeRoot: string;
let fake: string;
let root: string;
let deploy: string;
let env: Record<string, string>;
let settings: v.InferOutput<typeof Fixture>;

function envFile(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => `${name}='${value}'\n`)
    .join("");
}

async function writePrivate(name: string, text: string): Promise<void> {
  await writeFile(join(deploy, name), text, { mode: 0o600 });
  await chmod(join(deploy, name), 0o600);
}

// One stand-in for the file, run once here: macOS checks a new executable on its first run, which can take seconds.
beforeAll(async () => {
  fakeRoot = await fixtureRoot("prq-secrets-wrangler-");
  fake = join(fakeRoot, "wrangler.mjs");
  await writeFile(fake, FAKE, { mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    execFile(
      fake,
      ["--version"],
      { env: { FAKE_WRANGLER_LOG: join(fakeRoot, "warm.jsonl") }, timeout: 60_000 },
      (error) => (error === null ? resolve() : reject(error)),
    );
  });
}, 90_000);

afterAll(async () => {
  await rm(fakeRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await fixtureRoot("prq-secrets-");
  deploy = join(root, "deploy");
  await mkdir(deploy, { mode: 0o700 });
  await chmod(deploy, 0o700);
  await writePrivate("worker.env", envFile(SCALARS));
  await writePrivate("github-app.pk8.pem", KEY);
  await writePrivate("target.env", envFile({ PRQ_HOST: "prq.sentinel-zone.example", CLOUDFLARE_ACCOUNT_ID: ACCOUNT }));
  env = {
    PATH: process.env["PATH"] ?? "",
    HOME: root,
    FAKE_WRANGLER_LOG: join(root, "calls.jsonl"),
    FAKE_WRANGLER_PIDS: join(root, "pids.json"),
  };
  settings = { directory: deploy, wrangler: fake };
});

// The scripts a test started, and the stand-in's processes it recorded: a test that failed leaves none running.
const started: ChildProcess[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const pid of (await recordedPids()) ?? []) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It has ended.
    }
  }
  await rm(root, { recursive: true, force: true });
});

// The script with these arguments and this stdin (none: closed at once), through the tests' entry with the settings,
// or (production) as `pnpm run secrets` runs it, with none; its outcome, whose output holds no value.
function start(args: string[], input: string | null = null, { production = false } = {}) {
  const file = join(root, "fixture.json");
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("FAKE_")));
  writeFileSync(file, JSON.stringify({ ...settings, childEnv }));
  const argv = production ? [SCRIPT, ...args] : [TEST_ENTRY, file, "secrets", ...args];
  const child = spawn(process.execPath, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
  started.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  if (input !== null) {
    child.stdin.end(input);
  }
  const result = new Promise<Result>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  }).then((outcome) => {
    const output = outcome.stdout + outcome.stderr;
    expect(output).not.toMatch(/sentinel/i);
    for (const secret of SECRETS) {
      expect(output).not.toContain(secret);
    }
    return outcome;
  });
  return { child, result };
}

function secrets(args: string[], input = ""): Promise<Result> {
  return start(args, input).result;
}

async function calls(): Promise<Call[]> {
  const text = await readFile(env["FAKE_WRANGLER_LOG"] ?? "", "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => v.parse(Call, JSON.parse(line)));
}

async function bulkCalls(): Promise<Call[]> {
  return (await calls()).filter((call) => call.args[1] === "bulk");
}

// Whether a process has ended within a few seconds: one whose parent ended with it is reaped by init, not at once.
async function ended(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000;
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

// The stand-in's pid and its child's, as it wrote them; null before it has.
async function recordedPids(): Promise<number[] | null> {
  const text = await readFile(env["FAKE_WRANGLER_PIDS"] ?? "", "utf8").catch(() => "");
  return text === "" ? null : v.parse(v.array(v.number()), JSON.parse(text));
}

// The stand-in's pid and its child's, once it has written them.
async function hangingPids(): Promise<number[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const pids = await recordedPids();
    if (pids !== null) {
      return pids;
    }
    if (Date.now() > deadline) {
      throw new Error("the stand-in for wrangler did not start");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const CHECKED =
  `set: ${NAMES.join(", ")}\n` +
  "each passes the Worker's checks (src/config.ts), and the key signs an RS256 token that verifies\n";

describe("secrets check", () => {
  it("names the ten secrets and calls nothing", async () => {
    expect(await secrets(["check"])).toMatchObject({ code: 0, stdout: CHECKED, stderr: "" });
    expect(await calls()).toEqual([]);
  });

  it.each([
    ["worker.env", "0640"],
    ["worker.env", "0604"],
    ["github-app.pk8.pem", "0644"],
    ["github-app.pk8.pem", "0620"],
  ])("refuses %s with mode %s, open to others than its owner", async (name, bits) => {
    await chmod(join(deploy, name), Number.parseInt(bits, 8));

    expect(await secrets(["check"])).toMatchObject({
      code: 1,
      stdout: "",
      stderr: `secrets: ${name} is open to others than its owner (mode ${bits}): chmod 600 it\n`,
    });
  });

  it("refuses a deploy directory open to others than its owner", async () => {
    await chmod(deploy, 0o750);

    expect(await secrets(["check"])).toMatchObject({
      code: 1,
      stderr: "secrets: the deploy directory is open to others than its owner (mode 0750): chmod 700 it\n",
    });
  });

  it("refuses a deploy directory that is a symbolic link", async () => {
    settings.directory = join(root, "linked");
    await symlink(deploy, join(root, "linked"));

    expect(await secrets(["check"])).toMatchObject({
      code: 1,
      stderr: "secrets: the deploy directory is a symbolic link\n",
    });
  });

  it("refuses a symbolic link and what is not a regular file", async () => {
    await writeFile(join(root, "elsewhere.env"), envFile(SCALARS), { mode: 0o600 });
    await rm(join(deploy, "worker.env"));
    await symlink(join(root, "elsewhere.env"), join(deploy, "worker.env"));
    expect(await secrets(["check"])).toMatchObject({ code: 1, stderr: "secrets: worker.env is a symbolic link\n" });

    await rm(join(deploy, "worker.env"));
    await mkdir(join(deploy, "worker.env"), { mode: 0o700 });
    expect(await secrets(["check"])).toMatchObject({ code: 1, stderr: "secrets: worker.env is not a regular file\n" });
  });

  it.each(Object.keys(SCALARS))("requires %s, set and not empty", async (name) => {
    await writePrivate(
      "worker.env",
      envFile(Object.fromEntries(Object.entries(SCALARS).filter(([each]) => each !== name))),
    );
    expect(await secrets(["check"])).toMatchObject({
      code: 1,
      stderr: `secrets: worker.env does not set ${name}\n`,
    });

    await writePrivate("worker.env", envFile({ ...SCALARS, [name]: "" }));
    expect(await secrets(["check"])).toMatchObject({
      code: 1,
      stderr: `secrets: worker.env does not set ${name}\n`,
    });
  });

  it("requires the key, and names every missing secret at once", async () => {
    await writePrivate("github-app.pk8.pem", "");
    const { MODEL_ID: _id, ACCESS_AUD: _aud, ...rest } = SCALARS;
    await writePrivate("worker.env", envFile(rest));

    expect(await secrets(["check"])).toMatchObject({
      code: 1,
      stderr: "secrets: worker.env does not set ACCESS_AUD, MODEL_ID\nsecrets: github-app.pk8.pem is empty\n",
    });

    await rm(join(deploy, "github-app.pk8.pem"));
    expect(await secrets(["check"])).toMatchObject({
      code: 1,
      stderr: "secrets: the deploy directory has no github-app.pk8.pem\n",
    });
  });

  it("refuses the key's name, and any other name the Worker does not read without printing it", async () => {
    await writePrivate("worker.env", envFile({ ...SCALARS, GITHUB_APP_PRIVATE_KEY: "sentinel-key-in-the-env" }));
    expect(await secrets(["check"])).toMatchObject({
      code: 1,
      stderr: "secrets: worker.env sets GITHUB_APP_PRIVATE_KEY, which github-app.pk8.pem holds\n",
    });

    // A value pasted where a name goes, as a variable's name and as one that is not.
    for (const line of ["SK_SENTINEL_PASTED_AS_A_NAME=1", "sk-sentinel-pasted-as-a-name=1"]) {
      await writePrivate("worker.env", `${envFile(SCALARS)}${line}\n`);
      expect(await secrets(["check"])).toMatchObject({
        code: 1,
        stderr:
          "secrets: worker.env sets a name the Worker does not read (not printed, since it could be a misplaced " +
          "value)\n",
      });
    }
  });

  it.each([
    [
      "ACCESS_TEAM_DOMAIN",
      "https://sentinel-team.example/",
      "is not an https origin (https://<team>.cloudflareaccess.com)",
    ],
    ["HOST_GITHUB_ID", "sentinel-host", "is not a numeric GitHub user ID"],
    ["MODEL_BASE_URL", "http://sentinel-model.example/v1", "is not an https URL"],
    ["MODEL_CONTEXT_TOKENS", "16383", "is below 16,384"],
    ["GITHUB_APP_ID", "sentinel-app", "is not a numeric GitHub App ID"],
  ])("refuses a malformed %s with the Worker's own message", async (name, value, message) => {
    await writePrivate("worker.env", envFile({ ...SCALARS, [name]: value }));

    expect(await secrets(["check"])).toMatchObject({ code: 1, stdout: "", stderr: `secrets: ${name} ${message}\n` });
  });

  it("refuses GitHub's PKCS#1 key with the Worker's own message", async () => {
    const pkcs1 = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    }).privateKey;
    await writePrivate("github-app.pk8.pem", pkcs1);
    SECRETS.push(...keyLines(pkcs1));

    expect(await secrets(["check"])).toMatchObject({
      code: 1,
      stderr:
        "secrets: GITHUB_APP_PRIVATE_KEY is not a PKCS#8 private key (convert GitHub's key with openssl pkcs8 " +
        "-topk8)\n",
    });
  });

  it("refuses a PKCS#8 key that cannot make an RS256 signature that verifies", async () => {
    const ec = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }).privateKey;
    SECRETS.push(...keyLines(ec));
    const refusal = {
      code: 1,
      stderr:
        "secrets: github-app.pk8.pem does not make an RS256 signature that verifies (an RSA private key is " +
        "needed)\n",
    };
    await writePrivate("github-app.pk8.pem", ec);
    expect(await secrets(["check"])).toMatchObject(refusal);

    // An RSA key's PEM with a line of its body left out.
    await writePrivate("github-app.pk8.pem", KEY.split("\n").toSpliced(10, 1).join("\n"));
    expect(await secrets(["check"])).toMatchObject(refusal);
  });

  it("prints its usage, not the arguments, for anything else", async () => {
    for (const args of [[], ["sentinel-typed-as-a-command"], ["check", "sentinel-extra"]]) {
      expect(await secrets(args)).toMatchObject({
        code: 1,
        stdout: "",
        stderr: "secrets: usage: secrets check | status | put\n",
      });
    }
  });
});

describe("secrets status", () => {
  it("names the account and the Worker, the secrets it lacks and those it has besides", async () => {
    env["FAKE_WRANGLER_SECRETS"] = "ACCESS_TEAM_DOMAIN,ACCESS_AUD,WEBHOOK_SECRET,OLD_SECRET";

    expect(await secrets(["status"])).toMatchObject({
      code: 0,
      stderr: "",
      stdout: [
        `account: ${ACCOUNT} (Synthetic Account)`,
        "Worker: prq",
        "set: 3 of the 10 secrets",
        `missing: ${NAMES.slice(3).join(", ")}`,
        "optional set: none",
        "not expected: OLD_SECRET",
        "",
      ].join("\n"),
    });
    // The Worker's name in wrangler.jsonc, on the account target.env names.
    expect(unstable_readConfig({ config: CONFIG }).name).toBe("prq");
    const made = await calls();
    expect(made.map((call) => call.args)).toEqual([
      ["whoami", "--json", "--config", CONFIG, "--env", "", "--env-file", "/dev/null"],
      [
        "secret",
        "list",
        "--format",
        "json",
        "--config",
        CONFIG,
        "--env",
        "",
        "--env-file",
        "/dev/null",
        "--name",
        "prq",
      ],
    ]);
    for (const call of made) {
      expect(call.env["CLOUDFLARE_ACCOUNT_ID"]).toBe(ACCOUNT);
    }
  });

  it("reads wrangler's JSON when a debug log level is inherited", async () => {
    env["WRANGLER_LOG"] = "debug";

    expect(await secrets(["status"])).toMatchObject({ code: 0, stderr: "" });
    for (const call of await calls()) {
      expect(call.env["WRANGLER_LOG"]).toBe("log");
    }
  });

  it("refuses a wrangler configuration naming another account, before calling wrangler", async () => {
    const other = join(root, "wrangler.jsonc");
    settings.wranglerConfig = other;
    // wrangler would put on this account, while whoami shows target.env's.
    await writeFile(other, JSON.stringify({ name: "prq", account_id: "0".repeat(32) }));

    const refusal = {
      code: 1,
      stdout: "",
      stderr:
        "secrets: the wrangler configuration's account_id names another account than target.env's, and wrangler " +
        "would use it\n",
    };
    expect(await secrets(["status"])).toMatchObject(refusal);
    expect(await secrets(["put"], "y\n")).toMatchObject(refusal);
    expect(await calls()).toEqual([]);

    // The top-level environment, whatever another environment names (CLOUDFLARE_ENV, which would select one, is
    // refused).
    await writeFile(
      other,
      JSON.stringify({ name: "prq", account_id: ACCOUNT, env: { other: { account_id: "0".repeat(32) } } }),
    );
    expect(await secrets(["status"])).toMatchObject({ code: 0, stderr: "" });
  });

  it("prints none of the warnings reading the wrangler configuration gives, which can quote what it holds", async () => {
    const other = join(root, "wrangler.jsonc");
    settings.wranglerConfig = other;
    // A value pasted as a key, which wrangler warns of as an unexpected field.
    await writeFile(other, JSON.stringify({ name: "prq", "sk-sentinel-pasted-as-a-key": 1 }));

    expect(await secrets(["status"])).toMatchObject({ code: 0, stderr: "" });
  });

  it("reads neither worker.env nor the key", async () => {
    await rm(join(deploy, "worker.env"));
    await rm(join(deploy, "github-app.pk8.pem"));
    env["FAKE_WRANGLER_SECRETS"] = NAMES.join(",");

    expect((await secrets(["status"])).stdout).toContain(
      "set: 10 of the 10 secrets\nmissing: none\noptional set: none\nnot expected: none\n",
    );
  });

  it("names the optional reasoning effort apart from the required secrets", async () => {
    env["FAKE_WRANGLER_SECRETS"] = [...NAMES, "MODEL_REASONING_EFFORT"].join(",");

    expect((await secrets(["status"])).stdout).toContain(
      "set: 10 of the 10 secrets\nmissing: none\noptional set: MODEL_REASONING_EFFORT\nnot expected: none\n",
    );
  });

  it("refuses a target.env open to others, or one without an account ID", async () => {
    await chmod(join(deploy, "target.env"), 0o644);
    expect(await secrets(["status"])).toMatchObject({
      code: 1,
      stderr: "secrets: target.env is open to others than its owner (mode 0644): chmod 600 it\n",
    });

    await writePrivate("target.env", envFile({ CLOUDFLARE_ACCOUNT_ID: "sentinel-account" }));
    expect(await secrets(["status"])).toMatchObject({
      code: 1,
      stderr: "secrets: target.env does not set CLOUDFLARE_ACCOUNT_ID to an account ID (32 hexadecimal digits)\n",
    });
    expect(await calls()).toEqual([]);
  });

  it("refuses an account the login does not reach, before reading the Worker", async () => {
    env["FAKE_WRANGLER_ACCOUNTS"] = JSON.stringify([{ id: "0".repeat(32), name: "Another Account" }]);

    expect(await secrets(["status"])).toMatchObject({
      code: 1,
      stdout: "",
      stderr:
        "secrets: wrangler's login does not reach the account in target.env (pnpm --dir packages/server exec " +
        "wrangler whoami)\n",
    });
    expect((await calls()).map((call) => call.args[0])).toEqual(["whoami"]);
  });

  it("shows what wrangler printed when it fails, and fails", async () => {
    env["FAKE_WRANGLER_FAIL"] = "list";

    expect(await secrets(["status"])).toMatchObject({
      code: 1,
      stderr: '  ✘ [ERROR] Worker "prq" not found.\nsecrets: wrangler secret list failed (exit 1)\n',
    });
  });
});

describe("the production entry", () => {
  // secrets.ts as `pnpm run secrets` runs it, with no fixture. Were an override taken, status and put would still stop
  // before any call: HOME holds no deploy directory.
  it.each([
    [
      "the tests' own settings",
      { PRQ_DEPLOY_WRANGLER: "/sentinel/wrangler", PRQ_DEPLOY_DIRECTORY: "/sentinel/deploy" },
    ],
    ["the Worker's name", { WRANGLER_CI_OVERRIDE_NAME: "sentinel-other-worker" }],
    ["the configuration's environment", { CLOUDFLARE_ENV: "sentinel-env" }],
    ["the account", { CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) }],
    ["other credentials", { CLOUDFLARE_API_TOKEN: "sentinel-other-token" }],
    [
      "the API",
      {
        CLOUDFLARE_API_BASE_URL: "https://api.sentinel.example/client/v4",
        CF_API_BASE_URL: "https://api.sentinel.example/client/v4",
      },
    ],
    [
      "the OAuth login",
      {
        WRANGLER_TOKEN_URL: "https://login.sentinel.example/oauth2/token",
        WRANGLER_AUTH_DOMAIN: "login.sentinel.example",
      },
    ],
  ] as const)("refuses status and put in a terminal that sets %s, before any call", async (_what, set) => {
    Object.assign(env, set);
    const names = Object.keys(set).toSorted();

    for (const args of [["status"], ["put"]]) {
      expect(await start(args, "y\n", { production: true }).result).toMatchObject({
        code: 1,
        stdout: "",
        stderr: `secrets: the environment sets ${names.join(", ")}, which would send this command elsewhere than target.env's account and the Worker prq, or with other credentials than wrangler's login: unset ${names.length === 1 ? "it" : "them"} (docs/operations.md, The deploy command)\n`,
      });
    }
    expect(await calls()).toEqual([]);
  });
});

describe("secrets put", () => {
  it("checks, asks, then sends the ten secrets as one JSON object on wrangler's stdin and nowhere else", async () => {
    env["FAKE_WRANGLER_SECRETS"] = "ACCESS_AUD,OLD_SECRET";
    // Set otherwise in the environment the command starts from: wrangler gets its own.
    env["WRANGLER_LOG_SANITIZE"] = "false";
    env["WRANGLER_WRITE_LOGS"] = "true";

    const result = await secrets(["put"], "y\n");

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe(
      [
        `account: ${ACCOUNT} (Synthetic Account)`,
        "Worker: prq",
        `sends: ${NAMES.join(", ")}`,
        "kept as they are: OLD_SECRET",
        "put deploys a new version of the live Worker prq with these values; secrets it does not send stay.",
        `Put the secrets? [y/N] wrangler acknowledged the 10 secrets on prq; ${STATUS_HINT} lists them`,
        "",
      ].join("\n"),
    );
    const made = await calls();
    expect(made.map((call) => call.args)).toEqual([
      ["whoami", "--json", "--config", CONFIG, "--env", "", "--env-file", "/dev/null"],
      [
        "secret",
        "list",
        "--format",
        "json",
        "--config",
        CONFIG,
        "--env",
        "",
        "--env-file",
        "/dev/null",
        "--name",
        "prq",
      ],
      ["secret", "bulk", "--config", CONFIG, "--env", "", "--env-file", "/dev/null", "--name", "prq"],
    ]);
    const stdin = made[2]?.stdin ?? "";
    expect(stdin).not.toContain("\n");
    // The object as parsed, before a schema could leave a key out; then its order.
    const sent: unknown = JSON.parse(stdin);
    expect(sent).toStrictEqual(EXPECTED);
    expect(Object.keys(v.parse(v.record(v.string(), v.string()), sent))).toEqual(NAMES);
    for (const call of made) {
      expect(call.env["CLOUDFLARE_ACCOUNT_ID"]).toBe(ACCOUNT);
      expect(call.env["CLOUDFLARE_API_BASE_URL"]).toBe("https://api.cloudflare.com/client/v4");
      expect(call.env).not.toHaveProperty("CF_API_BASE_URL");
      expect(call.env["WRANGLER_LOG_SANITIZE"]).toBe("true");
      // The call that gets the values writes no log file.
      expect(call.env["WRANGLER_WRITE_LOGS"]).toBe(call.args[1] === "bulk" ? "false" : undefined);
      // No value in any call's arguments or environment.
      const elsewhere = JSON.stringify([call.args, call.env]);
      for (const secret of SECRETS) {
        expect(elsewhere).not.toContain(secret);
      }
    }
  });

  it("sends the reasoning effort when worker.env sets it, and checks and sends it as given", async () => {
    await writePrivate("worker.env", envFile({ ...SCALARS, MODEL_REASONING_EFFORT: "max" }));

    const names = NAMES.toSpliced(8, 0, "MODEL_REASONING_EFFORT");
    expect(await secrets(["check"])).toMatchObject({
      code: 0,
      stdout: CHECKED.replace(NAMES.join(", "), names.join(", ")),
    });
    expect(await secrets(["put"], "y\n")).toMatchObject({ code: 0, stderr: "" });
    const [bulk] = await bulkCalls();
    expect(JSON.parse(bulk?.stdin ?? "")).toStrictEqual({ ...EXPECTED, MODEL_REASONING_EFFORT: "max" });
  });

  it("leaves a live reasoning effort that worker.env does not set, and says it keeps it", async () => {
    env["FAKE_WRANGLER_SECRETS"] = [...NAMES, "MODEL_REASONING_EFFORT"].join(",");
    await writePrivate("worker.env", envFile({ ...SCALARS, MODEL_REASONING_EFFORT: "" }));

    const result = await secrets(["put"], "y\n");

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(`sends: ${NAMES.join(", ")}\nkept as they are: MODEL_REASONING_EFFORT\n`);
    const [bulk] = await bulkCalls();
    expect(JSON.parse(bulk?.stdin ?? "")).toStrictEqual(EXPECTED);
  });

  it.each([
    ["no", "n\n"],
    ["an empty line", "\n"],
    ["stdin closed", ""],
  ])("sends nothing on %s", async (_what, input) => {
    expect(await secrets(["put"], input)).toMatchObject({ code: 1, stderr: "secrets: nothing sent\n" });
    expect(await bulkCalls()).toEqual([]);
  });

  it("sends nothing when no answer comes within the wait", async () => {
    settings.waitMs = 1000;
    const { result } = start(["put"]);

    expect(await result).toMatchObject({ code: 1, stderr: "secrets: nothing sent\n" });
    expect(await bulkCalls()).toEqual([]);
  });

  it("asks nothing and sends nothing when the secrets fail the check", async () => {
    await writePrivate("worker.env", envFile({ ...SCALARS, HOST_GITHUB_ID: "sentinel-host" }));

    expect(await secrets(["put"], "y\n")).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "secrets: HOST_GITHUB_ID is not a numeric GitHub user ID\n",
    });
    expect(await calls()).toEqual([]);
  });

  // wrangler would create an empty Worker of the name to put secrets on.
  it("asks nothing and sends nothing when the Worker cannot be read", async () => {
    env["FAKE_WRANGLER_FAIL"] = "list";

    const result = await secrets(["put"], "y\n");

    expect(result).toMatchObject({ code: 1 });
    expect(result.stdout).not.toContain("Put the secrets?");
    expect(await bulkCalls()).toEqual([]);
  });

  it("shows none of what wrangler prints, which can quote a value encoded twice", async () => {
    // A double quote and a backslash, which JSON escapes, so that a value in JSON inside JSON differs from both its
    // raw text and its JSON.
    const value = 'sk-sentinel-"quoted"-and-\\-escaped';
    SECRETS.push(value);
    await writePrivate("worker.env", envFile({ ...SCALARS, MODEL_API_KEY: value }));
    env["FAKE_WRANGLER_ECHO"] = "1";

    const sent = await secrets(["put"], "y\n");

    expect(sent).toMatchObject({ code: 0, stderr: "" });
    expect(sent.stdout).not.toContain("[redacted]");
    const [bulk] = await bulkCalls();
    expect(v.parse(v.record(v.string(), v.string()), JSON.parse(bulk?.stdin ?? ""))["MODEL_API_KEY"]).toBe(value);
  });

  it("exits 1 when Cloudflare refuses the secrets on a latest version that is not deployed", async () => {
    env["FAKE_WRANGLER_BULK"] = "version";

    expect(await secrets(["put"], "y\n")).toMatchObject({
      code: 1,
      stderr:
        "secrets: Cloudflare refused the secrets, since the Worker's latest version is not deployed (wrangler exit " +
        "1): this put changed no secret. Deploy the latest version, then put again\n",
    });
    expect(await bulkCalls()).toHaveLength(1);
  });

  it("exits 2 on an error Cloudflare's API returned for the write, which quotes a value", async () => {
    env["FAKE_WRANGLER_BULK"] = "api";

    expect(await secrets(["put"], "y\n")).toMatchObject({
      code: 2,
      stderr:
        `secrets: Cloudflare returned an error and ${UNCONFIRMED}. wrangler's output is not shown, since the error ` +
        `can quote a value; ${STATUS_HINT} shows wrangler's errors for the login, the account and the Worker\n`,
    });
  });

  it("exits 2 when wrangler fails otherwise: the outcome is unknown", async () => {
    env["FAKE_WRANGLER_BULK"] = "lost";

    expect(await secrets(["put"], "y\n")).toMatchObject({
      code: 2,
      stderr: `secrets: wrangler secret bulk failed (exit 1), and ${UNCONFIRMED}\n`,
    });
  });

  it("exits 2 when the wait for wrangler ends, even if wrangler then exits 0", async () => {
    settings.waitMs = 1000;
    env["FAKE_WRANGLER_HANG"] = "bulk";
    env["FAKE_WRANGLER_TERM_EXIT_0"] = "1";

    expect(await secrets(["put"], "y\n")).toMatchObject({
      code: 2,
      stderr: `secrets: wrangler secret bulk did not finish within 1 s and was stopped, and ${UNCONFIRMED}\n`,
    });
  });

  it("says the outcome is unknown when a signal stops it while wrangler sends", async () => {
    env["FAKE_WRANGLER_HANG"] = "bulk";
    const { child, result } = start(["put"], "y\n");

    await hangingPids();
    child.kill("SIGTERM");

    const outcome = await result;
    expect(outcome).toMatchObject({ code: null, signal: "SIGTERM" });
    expect(outcome.stderr).toBe(`secrets: stopped by SIGTERM: wrangler secret bulk was running, and ${UNCONFIRMED}\n`);
  });
});

describe("wrangler's process", () => {
  it("is named when it cannot start", async () => {
    settings.wrangler = join(root, "no-wrangler-here");

    expect(await secrets(["status"])).toMatchObject({
      code: 1,
      stderr: "secrets: wrangler could not start (ENOENT)\n",
    });
  });

  it("is stopped with what it started at the end of its wait", async () => {
    settings.waitMs = 1000;
    env["FAKE_WRANGLER_HANG"] = "whoami";

    expect(await secrets(["status"])).toMatchObject({
      code: 1,
      stderr: "secrets: wrangler whoami did not finish within 1 s and was stopped\n",
    });
    for (const pid of await hangingPids()) {
      expect(await ended(pid)).toBe(true);
    }
  });

  it.each([
    ["whoami", "whoami"],
    ["list", "secret list"],
  ])("fails the call when its wait ends, even if %s then exits 0", async (call, what) => {
    settings.waitMs = 1000;
    env["FAKE_WRANGLER_HANG"] = call;
    env["FAKE_WRANGLER_TERM_EXIT_0"] = "1";

    expect(await secrets(["status"])).toMatchObject({
      code: 1,
      stderr: `secrets: wrangler ${what} did not finish within 1 s and was stopped\n`,
    });
  });

  it("is killed when it ignores SIGTERM", async () => {
    settings.waitMs = 1000;
    env["FAKE_WRANGLER_HANG"] = "bulk";
    env["FAKE_WRANGLER_STUBBORN"] = "1";

    expect(await secrets(["put"], "y\n")).toMatchObject({
      code: 2,
      stderr: `secrets: wrangler secret bulk did not finish within 1 s and was stopped, and ${UNCONFIRMED}\n`,
    });
    for (const pid of await hangingPids()) {
      expect(await ended(pid)).toBe(true);
    }
  });

  it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)(
    "is stopped with what it started when the command gets %s, which then ends the command",
    async (signal) => {
      env["FAKE_WRANGLER_HANG"] = "whoami";
      const { child, result } = start(["status"], "");

      const pids = await hangingPids();
      child.kill(signal);

      expect(await result).toMatchObject({ code: null, signal });
      for (const pid of pids) {
        expect(await ended(pid)).toBe(true);
      }
    },
  );
});
