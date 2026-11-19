// What the host's operations commands share (docs/operations.md): the private deploy directory, output that holds no
// value, an answer to a [y/N] question, and wrangler run on the account.
//
// The deploy directory, ~/.config/prq/deploy, and every file read from it must be the owner's alone (no group or other
// permission bits), and neither may be a symbolic link. target.env names the account (CLOUDFLARE_ACCOUNT_ID).
//
// Nothing printed holds a value read: every line printed through print() and printError() has each value hide() was
// given (as it is, as JSON escapes it, and each line of it) replaced, and a refusal names a file or a variable.
//
// A program runs with a bound on its time, in a process group of its own unless it runs in the foreground; a timeout,
// or a signal to this process, stops it with what it started (SIGTERM, then SIGKILL after a grace), and this process
// then ends as the signal would have ended it. wrangler's environment is wranglerEnv()'s.

import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import * as v from "valibot";

// The Worker's name in wrangler.jsonc.
export const WORKER = "prq";
export const WORKER_ENV = "worker.env";
export const TARGET_ENV = "target.env";
const NOT_INSTALLED = "wrangler is not installed: run pnpm install --frozen-lockfile in the repository";

const SERVER = fileURLToPath(new URL("..", import.meta.url));
// The production API, which every wrangler call is pinned to.
export const API = "https://api.cloudflare.com/client/v4";
// How long wrangler, or the answer to a question, is waited for.
const DEFAULT_WAIT_MS = 5 * 60_000;
// How long a program has to end after SIGTERM before SIGKILL.
const KILL_GRACE_MS = 5_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
// Exit codes: a refusal, or nothing written; and a write sent without an acknowledgement.
const EXIT_REFUSED = 1;
const EXIT_UNCONFIRMED = 2;

// Only for tests: another deploy directory, a program run in wrangler's place, another wrangler configuration, and a
// shorter wait.
const directory = process.env["PRQ_DEPLOY_DIRECTORY"] ?? join(homedir(), ".config", "prq", "deploy");
const wranglerOverride = process.env["PRQ_DEPLOY_WRANGLER"];
const CONFIG = process.env["PRQ_DEPLOY_WRANGLER_CONFIG"] ?? join(SERVER, "wrangler.jsonc");
// The repository's wrangler configuration at its top level, whatever CLOUDFLARE_ENV says, for every call on the account.
export const TOP_LEVEL: readonly string[] = ["--config", CONFIG, "--env", ""];
export const waitMs = /^[1-9][0-9]*$/.test(process.env["PRQ_DEPLOY_WAIT_MS"] ?? "")
  ? Number(process.env["PRQ_DEPLOY_WAIT_MS"])
  : DEFAULT_WAIT_MS;

// A refusal: each line names a file or a variable, never a value.
export class Refusal extends Error {
  readonly lines: readonly string[];
  readonly exitCode: number = EXIT_REFUSED;
  constructor(...lines: string[]) {
    super(lines.join("\n"));
    this.lines = lines;
  }
}

// A write sent to wrangler that wrangler did not acknowledge: what it changed is not known.
export class Unconfirmed extends Refusal {
  override readonly exitCode = EXIT_UNCONFIRMED;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown error";
}

// What is replaced in every line printed: each value read, as it is and as JSON escapes it inside a string, and each
// line of a value that has several (the key's), longest first so that no part of a longer one is left.
let hidden: string[] = [];

export function hide(values: Iterable<string>): void {
  const texts = new Set(hidden);
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

export function print(line: string): void {
  process.stdout.write(`${redact(line)}\n`);
}

export function printError(line: string): void {
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

// A file of the deploy directory, once the directory is checked, opened without following a symbolic link (or
// waiting on a FIFO) and checked on the opened descriptor: a regular file with no group or other permission bits.
export async function readPrivate(name: string): Promise<string> {
  await checkDirectory();
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

// The account target.env names.
export async function account(): Promise<string> {
  const id = parseEnv(await readPrivate(TARGET_ENV))["CLOUDFLARE_ACCOUNT_ID"] ?? "";
  if (!/^[0-9a-f]{32}$/.test(id)) {
    throw new Refusal(`${TARGET_ENV} does not set CLOUDFLARE_ACCOUNT_ID to an account ID (32 hexadecimal digits)`);
  }
  return id;
}

// wrangler takes the account from its configuration's account_id before CLOUDFLARE_ACCOUNT_ID, so a configuration
// that names another account is refused before anything is read from either. The top-level environment, as every
// call selects it (--env ""). Its warnings, which can quote what the configuration holds, are not printed (nor is the
// update check they start made). Loaded here, not at the start: a command that runs no wrangler needs none of it.
export async function checkConfigAccount(accountId: string): Promise<void> {
  let api;
  try {
    api = await import("wrangler");
  } catch {
    throw new Refusal(NOT_INSTALLED);
  }
  let configured;
  try {
    configured = api.unstable_readConfig({ config: CONFIG, env: "" }, { hideWarnings: true }).account_id;
  } catch {
    throw new Refusal("wrangler could not read its configuration, wrangler.jsonc");
  }
  if (configured !== undefined && configured !== accountId) {
    throw new Refusal(
      `the wrangler configuration's account_id names another account than ${TARGET_ENV}'s, and wrangler would use it`,
    );
  }
}

export type Outcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

// How a program runs: in cwd with env, its stdin given input (none: closed), its output kept or shown, ended after
// timeoutMs. A program runs in a process group of its own unless it is in the foreground: then it shares this
// process's group and its terminal, which it can read (wrangler asks there), and stopping it signals it and every
// process it started.
type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string | undefined;
  output: "keep" | "show";
  timeoutMs: number;
  foreground?: boolean;
};

// The program running now, stopped by a signal to this process, at its time bound, or when this process exits.
let current: { stop(signal: NodeJS.Signals): Promise<void>; kill(): void } | null = null;
// What a signal to this process does once the program is stopped, before this process ends by the signal: set by a
// command for the part of its work a signal must not leave unrecorded or unsaid.
let interrupt: ((signal: NodeJS.Signals) => Promise<void>) | null = null;
let ending = false;

export function onInterrupt(handler: ((signal: NodeJS.Signals) => Promise<void>) | null): void {
  interrupt = handler;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group has ended.
  }
}

// A process and the processes it started, as ps lists them now, the descendants first.
function tree(pid: number): number[] {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 });
  const children = new Map<number, number[]>();
  for (const line of (listed.stdout ?? "").split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child !== undefined && parent !== undefined && Number.isInteger(child) && Number.isInteger(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), child]);
    }
  }
  const found: number[] = [];
  const visit = (parent: number) => {
    for (const child of children.get(parent) ?? []) {
      if (!found.includes(child) && child !== process.pid) {
        visit(child);
        found.push(child);
      }
    }
  };
  visit(pid);
  return [...found, pid];
}

function signalTree(pid: number, signal: NodeJS.Signals): void {
  for (const each of tree(pid)) {
    try {
      process.kill(each, signal);
    } catch {
      // It has ended.
    }
  }
}

function end(signal: NodeJS.Signals): void {
  if (ending) {
    return;
  }
  ending = true;
  void (async () => {
    await current?.stop(signal);
    await interrupt?.(signal).catch(() => {});
    for (const each of SIGNALS) {
      process.removeAllListeners(each);
    }
    process.kill(process.pid, signal);
  })();
}

for (const signal of SIGNALS) {
  process.on(signal, () => end(signal));
}

// An exit while a program runs (an error this process did not catch) leaves nothing of it behind.
process.on("exit", () => {
  current?.kill();
});

// A program run as options say; refused when it cannot start.
export async function run(
  name: string,
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<Outcome> {
  const { input, foreground = false } = options;
  const shown = options.output === "show";
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: [
      foreground ? "inherit" : input === undefined ? "ignore" : "pipe",
      shown ? "inherit" : "pipe",
      shown ? "inherit" : "pipe",
    ],
    detached: !foreground,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("close", (code, signal) => resolve([code, signal])).once("error", () => resolve([null, null]));
  });
  const started = await new Promise<Error | null>((resolve) => {
    child.once("spawn", () => resolve(null)).once("error", resolve);
  });
  const { pid } = child;
  if (started !== null || pid === undefined) {
    throw new Refusal(`${name} could not start (${errorCode(started)})`);
  }

  const signalAll = (signal: NodeJS.Signals) => (foreground ? signalTree(pid, signal) : signalGroup(pid, signal));
  let stopping: Promise<void> | null = null;
  current = {
    stop: async (signal) => {
      stopping ??= (async () => {
        signalAll(signal);
        let grace: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([closed, new Promise((resolve) => (grace = setTimeout(resolve, KILL_GRACE_MS)))]);
        clearTimeout(grace);
        signalAll("SIGKILL");
        await closed;
      })();
      return stopping;
    },
    kill: () => signalAll("SIGKILL"),
  };
  if (input !== undefined && child.stdin !== null) {
    // The program may end before reading it all; its exit says why.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void current?.stop("SIGTERM");
  }, options.timeoutMs);
  const [code, signal] = await closed;
  clearTimeout(timer);
  if (ending) {
    // A signal stops this process once the program has ended; nothing more is done or printed.
    await new Promise(() => {});
  }
  current = null;
  return { code, signal, stdout, stderr, timedOut };
}

// The command that runs wrangler: the program tests give in its place, else executable (Node) with the wrangler file
// cli() resolves. wrangler's own bin runs that file in a second process; run directly, it is the one process to stop.
export function wranglerArgv(executable: string, cli: () => string): [string, string[]] {
  return wranglerOverride !== undefined ? [wranglerOverride, []] : [executable, ["--no-warnings", cli()]];
}

// The repository's own wrangler.
function wranglerCommand(): [string, string[]] {
  return wranglerArgv(process.execPath, () => {
    try {
      return fileURLToPath(import.meta.resolve("wrangler"));
    } catch {
      throw new Refusal(NOT_INSTALLED);
    }
  });
}

// wrangler's environment on the account. Each variable set, not left out: wrangler reads a variable its environment
// lacks from a .env file in packages/server, and one set here, not empty, wins over the file. A call given values on
// its stdin writes no log file.
export function wranglerEnv(accountId: string, { values = false } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    // An inherited override (or its older name, CF_API_BASE_URL, which this one wins over) cannot send the requests
    // elsewhere.
    CLOUDFLARE_API_BASE_URL: API,
    // Its debug log, which it also writes to disk, leaves out request bodies, the values among them.
    WRANGLER_LOG_SANITIZE: "true",
    // No debug lines among the JSON its commands print.
    WRANGLER_LOG: "log",
  };
  delete env["CF_API_BASE_URL"];
  if (values) {
    // An error from the API, which can quote what was sent, is logged there as it is.
    env["WRANGLER_WRITE_LOGS"] = "false";
  }
  return env;
}

// The repository's wrangler with args on the account, input (if any) on its stdin, its output kept for the caller; or,
// shown, its output on this process's. env adds to its environment.
export async function wrangler(
  args: readonly string[],
  accountId: string,
  {
    input,
    output = "keep",
    cwd = SERVER,
    env = {},
  }: { input?: string | undefined; output?: "keep" | "show"; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<Outcome> {
  const [program, base] = wranglerCommand();
  return run("wrangler", program, [...base, ...args], {
    cwd,
    env: { ...wranglerEnv(accountId, { values: input !== undefined }), ...env },
    input,
    output,
    timeoutMs: waitMs,
  });
}

// Whether a wrangler call succeeded: exit 0 within its wait.
export function succeeded(outcome: Outcome): boolean {
  return outcome.code === 0 && !outcome.timedOut;
}

// Why a wrangler call did not succeed.
export function stopped(what: string): string {
  return `wrangler ${what} did not finish within ${Math.round(waitMs / 1000)} s and was stopped`;
}

export function exited(outcome: Outcome): string {
  return `exit ${outcome.code ?? "by a signal"}`;
}

// The outcome of a wrangler call that gets no value when it did not succeed: what it printed, then the reason.
export function failed(what: string, outcome: Outcome): Refusal {
  for (const line of `${outcome.stdout}${outcome.stderr}`.split("\n")) {
    if (line.trim() !== "") {
      printError(`  ${line}`);
    }
  }
  return new Refusal(outcome.timedOut ? stopped(what) : `wrangler ${what} failed (${exited(outcome)})`);
}

// What wrangler answers as JSON, read with a schema.
export function answerOf<S extends v.GenericSchema>(what: string, schema: S, text: string): v.InferOutput<S> {
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

// A wrangler read on the account that answers JSON, refused when it does not succeed or answers in another shape.
export async function wranglerJson<S extends v.GenericSchema>(
  what: string,
  args: readonly string[],
  accountId: string,
  schema: S,
): Promise<v.InferOutput<S>> {
  const outcome = await wrangler(args, accountId);
  if (!succeeded(outcome)) {
    throw failed(what, outcome);
  }
  return answerOf(what, schema, outcome.stdout);
}

// `whoami --json`'s accounts.
const WhoamiAnswer = v.object({ accounts: v.array(v.object({ id: v.string(), name: v.optional(v.string()) })) });

// The account's name, from the accounts the login reaches.
export async function accountName(accountId: string): Promise<string> {
  const answered = await wranglerJson("whoami", ["whoami", "--json", ...TOP_LEVEL], accountId, WhoamiAnswer);
  const found = answered.accounts.find((entry) => entry.id === accountId);
  if (found === undefined) {
    throw new Refusal(
      `wrangler's login does not reach the account in ${TARGET_ENV} (pnpm --dir packages/server exec wrangler whoami)`,
    );
  }
  return found.name ?? "unnamed";
}

// One line from stdin within the bound (the wait unless given), null when stdin ends or the bound passes. stdin is
// paused afterwards, not closed: a later question reads it again, and a program run in the foreground meanwhile reads
// the terminal alone.
export async function ask(question: string, boundMs = waitMs): Promise<string | null> {
  const stdinHandle: { ref?: () => void; unref?: () => void } = process.stdin;
  process.stdout.write(question);
  const line = await new Promise<string | null>((resolve) => {
    let text = "";
    const finish = (value: string | null) => {
      clearTimeout(timer);
      process.stdin.off("data", onData).off("end", onEnd).off("error", onEnd);
      process.stdin.pause();
      // A paused pipe or terminal would still keep this process alive (a file has nothing to hold it).
      stdinHandle.unref?.();
      resolve(value);
    };
    const onData = (chunk: string) => {
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline !== -1) {
        finish(text.slice(0, newline).replace(/\r$/, ""));
      }
    };
    const onEnd = () => finish(null);
    const timer = setTimeout(() => finish(null), boundMs);
    if (process.stdin.readableEnded) {
      finish(null);
      return;
    }
    process.stdin.setEncoding("utf8").on("data", onData).once("end", onEnd).once("error", onEnd);
    stdinHandle.ref?.();
    process.stdin.resume();
  });
  if (line === null) {
    process.stdout.write("\n");
  }
  return line;
}

// A [y/N] question: yes only on y or yes.
export async function answer(question: string, boundMs = waitMs): Promise<boolean> {
  const line = await ask(question, boundMs);
  return line !== null && /^\s*y(es)?\s*$/i.test(line);
}

// A command's body: a refusal's lines printed after the command's name, and its exit code (1 for anything else).
export async function runCommand(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    // Only a refusal's own lines: another error's message may quote what it read.
    const lines = error instanceof Refusal ? error.lines : [`failed (${errorCode(error)})`];
    for (const line of lines) {
      printError(`${name}: ${line}`);
    }
    process.exitCode = error instanceof Refusal ? error.exitCode : EXIT_REFUSED;
  }
}
