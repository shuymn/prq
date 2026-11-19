// The Worker's production secrets: `pnpm run secrets check|status|put` in packages/server. docs/operations.md
// describes the deploy directory's files, what each command checks and does, and what it never prints.
//
// wrangler runs in a process group of its own with a bound on its time; a timeout, or a signal to this process, stops
// the group (SIGTERM, then SIGKILL after a grace), and this process then ends as the signal would have ended it.

import { spawn } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { jwtVerify } from "jose";
import githubAppJwt from "universal-github-app-jwt";
import * as v from "valibot";

import {
  readAccessConfig,
  readGithubAppConfig,
  readModelConfig,
  readWebhookConfig,
  SECRET_NAMES,
} from "../src/config.ts";

// The Worker's name in wrangler.jsonc.
const WORKER = "prq";
const KEY = "GITHUB_APP_PRIVATE_KEY";
// What worker.env holds: every secret but the key, which has a file of its own.
const SCALARS = SECRET_NAMES.filter((name) => name !== KEY);
const WORKER_ENV = "worker.env";
const KEY_FILE = "github-app.pk8.pem";
const TARGET_ENV = "target.env";
const USAGE = "usage: secrets check | status | put";
const STATUS_HINT = "`pnpm --dir packages/server run secrets status` (from the repository root)";
const NOT_INSTALLED = "wrangler is not installed: run pnpm install --frozen-lockfile in the repository";

const SERVER = fileURLToPath(new URL("..", import.meta.url));
// The production API, which every wrangler call is pinned to.
const API = "https://api.cloudflare.com/client/v4";
// How long wrangler, or the answer to put's question, is waited for.
const DEFAULT_WAIT_MS = 5 * 60_000;
// How long wrangler's process group has to end after SIGTERM before SIGKILL.
const KILL_GRACE_MS = 5_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
// Exit codes: a refusal, or nothing written; and put's write sent without an acknowledgement.
const EXIT_REFUSED = 1;
const EXIT_UNCONFIRMED = 2;

// Only for tests: another deploy directory, a program run in wrangler's place, another wrangler configuration, and a
// shorter wait.
const directory = process.env["PRQ_DEPLOY_DIRECTORY"] ?? join(homedir(), ".config", "prq", "deploy");
const wranglerOverride = process.env["PRQ_DEPLOY_WRANGLER"];
const config = process.env["PRQ_DEPLOY_WRANGLER_CONFIG"] ?? join(SERVER, "wrangler.jsonc");
const waitMs = /^[1-9][0-9]*$/.test(process.env["PRQ_DEPLOY_WAIT_MS"] ?? "")
  ? Number(process.env["PRQ_DEPLOY_WAIT_MS"])
  : DEFAULT_WAIT_MS;

// A refusal: each line names a file or a variable, never a value.
class Refusal extends Error {
  readonly lines: readonly string[];
  readonly exitCode: number = EXIT_REFUSED;
  constructor(...lines: string[]) {
    super(lines.join("\n"));
    this.lines = lines;
  }
}

// put's write, sent to wrangler, that wrangler did not acknowledge: the Worker may hold either set.
class Unconfirmed extends Refusal {
  override readonly exitCode = EXIT_UNCONFIRMED;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown error";
}

// What is replaced in every line printed: each value read, as it is and as JSON escapes it inside a string, and each
// line of a value that has several (the key's), longest first so that no part of a longer one is left.
let hidden: string[] = [];

function hide(values: Iterable<string>): void {
  const texts = new Set<string>();
  for (const value of values) {
    texts.add(value);
    texts.add(JSON.stringify(value).slice(1, -1));
    for (const line of value.split(/\r?\n/)) {
      texts.add(line.trim());
    }
  }
  texts.delete("");
  hidden = [...texts].toSorted((a, b) => b.length - a.length);
}

function redact(text: string): string {
  let result = text;
  for (const secret of hidden) {
    result = result.replaceAll(secret, "[redacted]");
  }
  return result;
}

function print(line: string): void {
  process.stdout.write(`${redact(line)}\n`);
}

function printError(line: string): void {
  process.stderr.write(`${redact(line)}\n`);
}

function mode(bits: number): string {
  return `0${(bits & 0o777).toString(8)}`;
}

// The directory itself, not followed if it is a symbolic link: the owner's alone by its permission bits.
async function checkDirectory(): Promise<void> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    const code = errorCode(error);
    throw new Refusal(
      code === "ENOENT"
        ? "the deploy directory does not exist (docs/operations.md, Setup)"
        : `could not read the deploy directory (${code})`,
    );
  }
  if (info.isSymbolicLink()) {
    throw new Refusal("the deploy directory is a symbolic link");
  }
  if (!info.isDirectory()) {
    throw new Refusal("the deploy directory is not a directory");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Refusal(`the deploy directory is open to others than its owner (mode ${mode(info.mode)}): chmod 700 it`);
  }
}

// A file of the deploy directory, opened without following a symbolic link (or waiting on a FIFO) and checked on the
// opened descriptor: a regular file with no group or other permission bits.
async function readPrivate(name: string): Promise<string> {
  let handle;
  try {
    handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      throw new Refusal(`the deploy directory has no ${name}`);
    }
    throw new Refusal(code === "ELOOP" ? `${name} is a symbolic link` : `could not read ${name} (${code})`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Refusal(`${name} is not a regular file`);
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Refusal(`${name} is open to others than its owner (mode ${mode(info.mode)}): chmod 600 it`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

// The ten secrets, as the Worker reads them and in its order, refused unless each is set and nothing else is.
async function readSecrets(): Promise<Record<string, string>> {
  await checkDirectory();
  const vars = parseEnv(await readPrivate(WORKER_ENV));
  const key = await readPrivate(KEY_FILE);
  hide([...Object.values(vars).filter((value) => value !== undefined), key]);

  const issues: string[] = [];
  const unexpected = Object.keys(vars).filter((name) => !SCALARS.includes(name));
  if (unexpected.includes(KEY)) {
    issues.push(`${WORKER_ENV} sets ${KEY}, which ${KEY_FILE} holds`);
  }
  // Not named: a value pasted where a name goes reads as one.
  if (unexpected.some((name) => name !== KEY)) {
    issues.push(
      `${WORKER_ENV} sets a name the Worker does not read (not printed, since it could be a misplaced value)`,
    );
  }
  const values = Object.fromEntries([...SCALARS.map((name) => [name, vars[name] ?? ""]), [KEY, key]]);
  const unset = SCALARS.filter((name) => values[name] === "");
  if (unset.length > 0) {
    issues.push(`${WORKER_ENV} does not set ${unset.join(", ")}`);
  }
  if (key.trim() === "") {
    issues.push(`${KEY_FILE} is empty`);
  }
  if (issues.length > 0) {
    throw new Refusal(...issues);
  }
  return values;
}

// Whether the key makes an RS256 token with the signer the Worker uses for the App (src/github.ts) that verifies with
// the key's public half.
async function signs(appId: number, key: string): Promise<boolean> {
  try {
    const { token } = await githubAppJwt({ id: appId, privateKey: key });
    await jwtVerify(token, createPublicKey(key), { algorithms: ["RS256"] });
    return true;
  } catch {
    return false;
  }
}

// The secrets as the Worker would read them: each group through src/config.ts (none reads as left out, since each
// value is set), then the key by signing.
async function check(): Promise<Record<string, string>> {
  const values = await readSecrets();
  const issues: string[] = [];
  const app = readGithubAppConfig(values);
  for (const result of [readAccessConfig(values), readWebhookConfig(values), readModelConfig(values), app]) {
    if (result !== null && !result.ok) {
      issues.push(...result.issues);
    }
  }
  if (app?.ok === true && !(await signs(app.config.GITHUB_APP_ID, app.config.GITHUB_APP_PRIVATE_KEY))) {
    issues.push(`${KEY_FILE} does not make an RS256 signature that verifies (an RSA private key is needed)`);
  }
  if (issues.length > 0) {
    throw new Refusal(...issues);
  }
  return values;
}

async function account(): Promise<string> {
  await checkDirectory();
  const id = parseEnv(await readPrivate(TARGET_ENV))["CLOUDFLARE_ACCOUNT_ID"] ?? "";
  if (!/^[0-9a-f]{32}$/.test(id)) {
    throw new Refusal(`${TARGET_ENV} does not set CLOUDFLARE_ACCOUNT_ID to an account ID (32 hexadecimal digits)`);
  }
  return id;
}

// wrangler takes the account from its configuration's account_id before CLOUDFLARE_ACCOUNT_ID, so a configuration
// that names another account is refused before anything is read from either. The top-level environment, as every
// call selects it (--env ""). Its warnings, which can quote what the configuration holds, are not printed (nor is the
// update check they start made). Loaded here, not at the start: check needs none of wrangler.
async function checkConfigAccount(accountId: string): Promise<void> {
  let api;
  try {
    api = await import("wrangler");
  } catch {
    throw new Refusal(NOT_INSTALLED);
  }
  let configured;
  try {
    configured = api.unstable_readConfig({ config, env: "" }, { hideWarnings: true }).account_id;
  } catch {
    throw new Refusal("wrangler could not read its configuration, wrangler.jsonc");
  }
  if (configured !== undefined && configured !== accountId) {
    throw new Refusal(
      `the wrangler configuration's account_id names another account than ${TARGET_ENV}'s, and wrangler would use it`,
    );
  }
}

type Outcome = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

// The wrangler running now, stopped by a signal to this process or when it ends; and what to print if a signal stops
// it.
let current: { pid: number; stop(signal: NodeJS.Signals): Promise<void> } | null = null;
let interruptedNote: string | null = null;
const listeners = new Map(SIGNALS.map((signal) => [signal, () => end(signal)]));
let ending = false;

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group has ended.
  }
}

function end(signal: NodeJS.Signals): void {
  if (ending) {
    return;
  }
  ending = true;
  void (current?.stop(signal) ?? Promise.resolve()).then(() => {
    if (interruptedNote !== null) {
      printError(`secrets: stopped by ${signal}: ${interruptedNote}`);
    }
    for (const [name, listener] of listeners) {
      process.off(name, listener);
    }
    process.kill(process.pid, signal);
  });
}

// An exit while wrangler runs (an error this process did not catch) leaves no wrangler behind.
process.on("exit", () => {
  if (current !== null) {
    signalGroup(current.pid, "SIGKILL");
  }
});

function wranglerCommand(): [string, string[]] {
  if (wranglerOverride !== undefined) {
    return [wranglerOverride, []];
  }
  let cli: string;
  try {
    cli = fileURLToPath(import.meta.resolve("wrangler"));
  } catch {
    throw new Refusal(NOT_INSTALLED);
  }
  // wrangler's own bin runs this file in a second process; run directly, it is the one process to stop.
  return [process.execPath, ["--no-warnings", cli]];
}

// wrangler with args on the account, input (if any) on its stdin, its output kept for the caller.
async function wrangler(args: readonly string[], accountId: string, input?: string): Promise<Outcome> {
  const [command, base] = wranglerCommand();
  // Each set, not left out: wrangler reads a variable its environment lacks from a .env file in packages/server, and
  // one set here, not empty, wins over the file.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    // An inherited override (or its older name, CF_API_BASE_URL, which this one wins over) cannot send the requests
    // elsewhere.
    CLOUDFLARE_API_BASE_URL: API,
    // Its debug log, which it also writes to disk, leaves out request bodies, the values among them.
    WRANGLER_LOG_SANITIZE: "true",
    // No debug lines among the JSON whoami and secret list print.
    WRANGLER_LOG: "log",
  };
  delete env["CF_API_BASE_URL"];
  if (input !== undefined) {
    // The call that gets the values writes no log file: an error from the API, which can quote what was sent, is
    // logged there as it is.
    env["WRANGLER_WRITE_LOGS"] = "false";
  }
  const child = spawn(command, [...base, ...args], {
    cwd: SERVER,
    env,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code)).once("error", () => resolve(null));
  });
  const started = await new Promise<Error | null>((resolve) => {
    child.once("spawn", () => resolve(null)).once("error", resolve);
  });
  const { pid } = child;
  if (started !== null || pid === undefined) {
    throw new Refusal(`wrangler could not start (${errorCode(started)})`);
  }

  let stopping: Promise<void> | null = null;
  current = {
    pid,
    stop: async (signal) => {
      stopping ??= (async () => {
        signalGroup(pid, signal);
        let grace: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([closed, new Promise((resolve) => (grace = setTimeout(resolve, KILL_GRACE_MS)))]);
        clearTimeout(grace);
        signalGroup(pid, "SIGKILL");
        await closed;
      })();
      return stopping;
    },
  };
  for (const [signal, listener] of listeners) {
    process.on(signal, listener);
  }
  if (input !== undefined && child.stdin !== null) {
    // wrangler may end before reading it all; its exit says why.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void current?.stop("SIGTERM");
  }, waitMs);
  const code = await closed;
  clearTimeout(timer);
  if (ending) {
    // A signal stops this process once wrangler has ended; nothing more is done or printed.
    await new Promise(() => {});
  }
  current = null;
  for (const [signal, listener] of listeners) {
    process.off(signal, listener);
  }
  return { code, stdout, stderr, timedOut };
}

// Whether a wrangler call that gets no value succeeded: exit 0 within its wait.
function succeeded(outcome: Outcome): boolean {
  return outcome.code === 0 && !outcome.timedOut;
}

// Why a wrangler call did not succeed.
function stopped(what: string): string {
  return `wrangler ${what} did not finish within ${Math.round(waitMs / 1000)} s and was stopped`;
}

function exited(outcome: Outcome): string {
  return `exit ${outcome.code ?? "by a signal"}`;
}

// The outcome of a wrangler call that gets no value when it did not succeed: what it printed, then the reason.
function failed(what: string, outcome: Outcome): Refusal {
  for (const line of `${outcome.stdout}${outcome.stderr}`.split("\n")) {
    if (line.trim() !== "") {
      printError(`  ${line}`);
    }
  }
  return new Refusal(outcome.timedOut ? stopped(what) : `wrangler ${what} failed (${exited(outcome)})`);
}

// What wrangler answers as JSON: `whoami --json`'s accounts, and `secret list --format json`'s names.
const WhoamiAnswer = v.object({ accounts: v.array(v.object({ id: v.string(), name: v.optional(v.string()) })) });
const SecretList = v.array(v.object({ name: v.string() }));

function answerOf<S extends v.GenericSchema>(what: string, schema: S, text: string): v.InferOutput<S> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Refusal(`wrangler ${what} did not answer JSON`);
  }
  const parsed = v.safeParse(schema, json);
  if (!parsed.success) {
    throw new Refusal(`wrangler ${what} did not answer in the shape this command reads`);
  }
  return parsed.output;
}

// The account's name, from the accounts the login reaches.
async function accountName(accountId: string): Promise<string> {
  const outcome = await wrangler(["whoami", "--json", "--config", config, "--env", ""], accountId);
  if (!succeeded(outcome)) {
    throw failed("whoami", outcome);
  }
  const found = answerOf("whoami", WhoamiAnswer, outcome.stdout).accounts.find((entry) => entry.id === accountId);
  if (found === undefined) {
    throw new Refusal(
      `wrangler's login does not reach the account in ${TARGET_ENV} (pnpm --dir packages/server exec wrangler whoami)`,
    );
  }
  return found.name ?? "unnamed";
}

// The names of the Worker's secrets; refused when the Worker cannot be read, a missing one included.
async function secretNames(accountId: string): Promise<string[]> {
  const outcome = await wrangler(
    ["secret", "list", "--format", "json", "--config", config, "--env", "", "--name", WORKER],
    accountId,
  );
  if (!succeeded(outcome)) {
    throw failed("secret list", outcome);
  }
  return answerOf("secret list", SecretList, outcome.stdout).map((entry) => entry.name);
}

function namesLine(names: readonly string[]): string {
  return names.length > 0 ? names.join(", ") : "none";
}

async function where(): Promise<{ accountId: string; names: string[] }> {
  const accountId = await account();
  await checkConfigAccount(accountId);
  const name = await accountName(accountId);
  print(`account: ${accountId} (${name})`);
  print(`Worker: ${WORKER}`);
  return { accountId, names: await secretNames(accountId) };
}

async function status(): Promise<void> {
  const { names } = await where();
  print(`set: ${SECRET_NAMES.filter((name) => names.includes(name)).length} of the ${SECRET_NAMES.length} secrets`);
  print(`missing: ${namesLine(SECRET_NAMES.filter((name) => !names.includes(name)))}`);
  print(`not expected: ${namesLine(names.filter((name) => !SECRET_NAMES.includes(name)))}`);
}

// One line from stdin within the wait; none (stdin ended, or the wait passed) is a no.
async function answer(question: string): Promise<boolean> {
  process.stdout.write(question);
  const line = await new Promise<string | null>((resolve) => {
    let text = "";
    const finish = (value: string | null) => {
      clearTimeout(timer);
      process.stdin.off("data", onData).off("end", onEnd).off("error", onEnd);
      // Not read again: wrangler gets a stdin of its own.
      process.stdin.destroy();
      resolve(value);
    };
    const onData = (chunk: string) => {
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline !== -1) {
        finish(text.slice(0, newline));
      }
    };
    const onEnd = () => finish(null);
    const timer = setTimeout(() => finish(null), waitMs);
    process.stdin.setEncoding("utf8").on("data", onData).once("end", onEnd).once("error", onEnd);
    process.stdin.resume();
  });
  if (line === null) {
    process.stdout.write("\n");
  }
  return line !== null && /^\s*y(es)?\s*$/i.test(line);
}

const UNCONFIRMED =
  "the live secret update is unconfirmed. Retry the intended set until put exits 0, or restore the saved set and put " +
  "it until put exits 0 (docs/operations.md, Rotation)";

// What wrangler prints for the API's codes 10214 and 10215, a latest version that is not deployed
// (wrangler-dist/cli.js): a precondition Cloudflare refused the write on, which changed nothing.
const NOT_DEPLOYED =
  "Secret edit failed. You attempted to modify a secret, but the latest version of your Worker isn't currently " +
  "deployed.";

// What the bulk call printed when it did not succeed: the refusal above, any other error the API returned for the write
// (throwFetchError's text), which does not show whether the write was applied, or another failure, which does not
// either.
function bulkFailure(outcome: Outcome, accountId: string): "not deployed" | "api error" | "other" {
  const output = `${outcome.stdout}${outcome.stderr}`;
  if (output.includes(NOT_DEPLOYED)) {
    return "not deployed";
  }
  return output.includes(
    `A request to the Cloudflare API (/accounts/${accountId}/workers/scripts/${WORKER}/secrets-bulk) failed.`,
  )
    ? "api error"
    : "other";
}

async function put(): Promise<void> {
  const values = await check();
  const { accountId, names } = await where();
  const sent = Object.keys(values);
  print(`sends: ${sent.join(", ")}`);
  print(`kept as they are: ${namesLine(names.filter((name) => !SECRET_NAMES.includes(name)))}`);
  print(`put deploys a new version of the live Worker ${WORKER} with these values; secrets it does not send stay.`);
  if (!(await answer("Put the secrets? [y/N] "))) {
    throw new Refusal("nothing sent");
  }
  // One JSON object on stdin, which wrangler reads whole (no file holds the values).
  interruptedNote = `wrangler secret bulk was running, and ${UNCONFIRMED}`;
  const outcome = await wrangler(
    ["secret", "bulk", "--config", config, "--env", "", "--name", WORKER],
    accountId,
    JSON.stringify(values),
  );
  interruptedNote = null;
  // wrangler's output is not shown: an error from the API can quote what was sent.
  if (succeeded(outcome)) {
    print(`wrangler acknowledged the ${sent.length} secrets on ${WORKER}; ${STATUS_HINT} lists them`);
    return;
  }
  if (outcome.timedOut) {
    throw new Unconfirmed(`${stopped("secret bulk")}, and ${UNCONFIRMED}`);
  }
  switch (bulkFailure(outcome, accountId)) {
    case "not deployed":
      throw new Refusal(
        `Cloudflare refused the secrets, since the Worker's latest version is not deployed (wrangler ` +
          `${exited(outcome)}): this put changed no secret. Deploy the latest version, then put again`,
      );
    case "api error":
      throw new Unconfirmed(
        `Cloudflare returned an error and ${UNCONFIRMED}. wrangler's output is not shown, since the error can quote ` +
          `a value; ${STATUS_HINT} shows wrangler's errors for the login, the account and the Worker`,
      );
    case "other":
      throw new Unconfirmed(`wrangler secret bulk failed (${exited(outcome)}), and ${UNCONFIRMED}`);
  }
}

// A "--" before the arguments (as some package managers pass it) is not an argument.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
try {
  if (args.length !== 1) {
    // The usage alone: an argument could be a value typed in the wrong place.
    throw new Refusal(USAGE);
  }
  switch (args[0]) {
    case "check": {
      const values = await check();
      print(`set: ${Object.keys(values).join(", ")}`);
      print("each passes the Worker's checks (src/config.ts), and the key signs an RS256 token that verifies");
      break;
    }
    case "status":
      await status();
      break;
    case "put":
      await put();
      break;
    default:
      throw new Refusal(USAGE);
  }
} catch (error) {
  // Only a refusal's own lines: another error's message may quote what it read.
  const lines = error instanceof Refusal ? error.lines : [`failed (${errorCode(error)})`];
  for (const line of lines) {
    printError(`secrets: ${line}`);
  }
  process.exitCode = error instanceof Refusal ? error.exitCode : EXIT_REFUSED;
}
