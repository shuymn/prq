// What the host's operations commands share (docs/operations.md): the private deploy directory, output that holds no
// value, an answer to a [y/N] question, a secret asked without echo, and wrangler run on the account.
//
// The deploy directory, ~/.config/prq/deploy, and every file read from it must be the owner's alone (no group or other
// permission bits), and neither may be a symbolic link. target.env names the account (CLOUDFLARE_ACCOUNT_ID). Where a
// command writes there (writePrivate()), the directory and the file are also checked for an access control list, which
// can let others read what the mode does not, and the file is written whole beside the old one, then renamed over it.
//
// Nothing printed holds a value read: every line printed through print() and printError() has each value hide() was
// given (as it is, as JSON escapes it, and each line of it) replaced, and a refusal names a file or a variable.
//
// A program runs with a bound on its time, in a process group of its own unless it runs in the foreground; a timeout,
// or a signal to this process, stops it with what it started (SIGTERM, then SIGKILL after a grace), and this process
// then ends as the signal would have ended it. A program in the foreground is stopped with every process its tree held
// at any signal sent, so one that left the tree after the first still gets SIGKILL; one that left before it is not
// found. What a program run in its own group left in that group when it failed is killed with it.
//
// A command whose programs ask the owner refuses an environment marked as CI (notInCi()). A command that reaches the
// account first refuses a terminal holding an override (refuseOverrides()), and wrangler
// runs with an environment built for it (wranglerEnv()) and an env file that holds nothing (NO_ENV_FILE). The tests
// reach their stand-ins through their own entry (test-entry.ts, fixture.ts), not through the environment.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, unlinkSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { isCI, name as ciName } from "ci-info";
import * as v from "valibot";

import { SECRET_NAMES } from "../src/config.ts";
import { fixture } from "./fixture.ts";

// The Worker's name in wrangler.jsonc.
export const WORKER = "prq";
export const WORKER_ENV = "worker.env";
export const TARGET_ENV = "target.env";
export const ACCESS_ENV = "access.env";
const NOT_INSTALLED = "wrangler is not installed: run pnpm install --frozen-lockfile in the repository";

const SERVER = fileURLToPath(new URL("..", import.meta.url));
// The production API, which every wrangler call is pinned to.
export const API = "https://api.cloudflare.com/client/v4";
// How long wrangler, or the answer to a question, is waited for.
const DEFAULT_WAIT_MS = 5 * 60_000;
// How long a program has to end after SIGTERM before SIGKILL.
const KILL_GRACE_MS = 5_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
// Exit codes: a refusal, or nothing written; and a write sent without an acknowledgement.
const EXIT_REFUSED = 1;
const EXIT_UNCONFIRMED = 2;

// Only the tests' fixture sets another deploy directory, a program run in wrangler's place, another wrangler
// configuration, or a shorter wait.
export const DEPLOY_DIRECTORY = fixture.directory ?? join(homedir(), ".config", "prq", "deploy");
const directory = DEPLOY_DIRECTORY;
const wranglerOverride = fixture.wrangler;
const CONFIG = fixture.wranglerConfig ?? join(SERVER, "wrangler.jsonc");
// The env file every wrangler call is given, which holds nothing: without one, wrangler loads .env and .env.local from
// its working directory into its environment at its start.
export const NO_ENV_FILE = "/dev/null";
// The repository's wrangler configuration at its top level, and no env file, for every call on the account.
export const TOP_LEVEL: readonly string[] = ["--config", CONFIG, "--env", "", "--env-file", NO_ENV_FILE];
export const waitMs = fixture.waitMs ?? DEFAULT_WAIT_MS;

// What a terminal can hold that would send a command elsewhere than the account and Worker it names, or with other
// credentials than wrangler's login: the tests' own settings (PRQ_DEPLOY_*, which no production entry reads), and what
// the pinned wrangler (4.161.0) reads for the account, the credentials, the Worker's name and configuration
// environment (the WRANGLER_CI_* family among them), the API, its headers and the image registry, and the OAuth login
// (its URLs, client, environment and auth domain).
const OVERRIDES = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_EMAIL",
  "CLOUDFLARE_AUTH_PROFILE",
  "CLOUDFLARE_ENV",
  "CLOUDFLARE_API_BASE_URL",
  "CF_API_BASE_URL",
  "CLOUDFLARE_COMPLIANCE_REGION",
  "CLOUDFLARE_API_HEADERS",
  "CLOUDFLARE_CONTAINER_REGISTRY",
  "CLOUDFLARE_CLIENT_ID",
  "WRANGLER_CLIENT_ID",
  "WRANGLER_AUTH_DOMAIN",
  "WRANGLER_AUTH_URL",
  "WRANGLER_TOKEN_URL",
  "WRANGLER_REVOKE_URL",
  "WRANGLER_API_ENVIRONMENT",
  "WRANGLER_CF_AUTHORIZATION_TOKEN",
];
const OVERRIDE_PREFIXES = ["PRQ_DEPLOY_", "WRANGLER_CI_"];

// Refused before any wrangler call or read of a credential: a terminal that holds an override, named (never its value).
export function refuseOverrides(): void {
  const found = Object.keys(process.env)
    .filter((name) => OVERRIDES.includes(name) || OVERRIDE_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .toSorted();
  if (found.length > 0) {
    throw new Refusal(
      `the environment sets ${found.join(", ")}, which would send this command elsewhere than target.env's account and the Worker ${WORKER}, or with other credentials than wrangler's login: unset ${found.length === 1 ? "it" : "them"} (docs/operations.md, The deploy command)`,
    );
  }
}

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

// Refused in an environment ci-info marks as CI, naming what marks it, and why the command runs from the owner's
// terminal alone (reason): a command whose programs ask the owner, which take CI as nobody to ask.
export function notInCi(reason: string): void {
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
    `the environment marks this run as CI (${marks.size > 0 ? [...marks].join(", ") : `the variables of ${ciName ?? "a CI service"}`}), ${reason}`,
  );
}

// What wrangler's environment keeps of this process's: what a program needs to run here (the paths, the user, the
// shell, the temp directory, the locale and the terminal), the directories wrangler keeps its login in (XDG_*), and the
// Docker settings the image's build and push take. Nothing else reaches wrangler, so a variable that would redirect it
// and is missing from OVERRIDES does not either.
const KEPT = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "WRANGLER_DOCKER_BIN",
  "WRANGLER_DOCKER_HOST",
];
const KEPT_PREFIXES = ["LC_", "XDG_", "DOCKER_"];

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

// Values hide() was given that are not secrets and that a command shows (an account ID, a hostname), as they are and
// as JSON escapes them.
export function reveal(values: Iterable<string>): void {
  const shown = new Set([...values].flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]));
  hidden = hidden.filter((text) => !shown.has(text));
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

export function mode(bits: number): string {
  return `0${(bits & 0o777).toString(8)}`;
}

// A path, not followed if it is a symbolic link, as kind says (a directory or a regular file), with no group or other
// permission bits; label names it in a refusal, and missing replaces the refusal of a path that does not exist.
async function checkEntry(path: string, label: string, kind: "directory" | "file", missing?: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    const code = errorCode(error);
    throw new Refusal(code === "ENOENT" && missing !== undefined ? missing : `could not read ${label} (${code})`);
  }
  if (info.isSymbolicLink()) {
    throw new Refusal(`${label} is a symbolic link`);
  }
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) {
    throw new Refusal(`${label} is not a ${kind === "directory" ? "directory" : "regular file"}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Refusal(
      `${label} is open to others than its owner (mode ${mode(info.mode)}): chmod ${kind === "directory" ? "700" : "600"} it`,
    );
  }
}

// The directory itself: the owner's alone by its permission bits.
function checkDirectory(): Promise<void> {
  return checkEntry(
    directory,
    "the deploy directory",
    "directory",
    "the deploy directory does not exist (docs/operations.md, Setup)",
  );
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

// The directory the user's state goes in: XDG_STATE_HOME when it is absolute, else ~/.local/state.
export function stateRoot(): string {
  const xdg = process.env["XDG_STATE_HOME"];
  return xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state");
}

// Refused when path (not followed if it is a symbolic link) has an access control list. macOS's ls lists its entries
// under the mode line with -e (its `+` after the mode gives way to the `@` of extended attributes, which most files
// carry); GNU ls marks it with a `+` after the mode.
async function refuseAcl(path: string): Promise<void> {
  const darwin = process.platform === "darwin";
  const outcome = await run("ls", "ls", [darwin ? "-lde" : "-ld", "--", path], {
    cwd: "/",
    env: { PATH: process.env["PATH"] ?? "/bin:/usr/bin", LC_ALL: "C" },
    output: "keep",
    timeoutMs: waitMs,
  });
  if (outcome.code !== 0 || outcome.timedOut) {
    throw new Refusal(`could not list the access control list of ${path} (ls ${exited(outcome)})`);
  }
  const [first = "", ...entries] = outcome.stdout.split("\n");
  if (darwin ? entries.some((line) => /^\s*\d+: /.test(line)) : (first.split(/\s/)[0] ?? "").endsWith("+")) {
    throw new Refusal(
      `${path} has an access control list, which can let others read it: ${darwin ? "chmod -N" : "setfacl -b"} it`,
    );
  }
}

// A file of the deploy directory, not followed if it is a symbolic link: a regular file with no group or other
// permission bits and no access control list.
async function checkPrivateFile(path: string): Promise<void> {
  await checkEntry(path, path, "file");
  await refuseAcl(path);
}

// The directory's missing ancestors, then the directory, each made 0700 whatever the umask.
async function makeDirectory(): Promise<void> {
  const missing: string[] = [];
  for (let each = directory; (await lstat(each).catch(() => null)) === null; each = dirname(each)) {
    missing.unshift(each);
  }
  for (const each of missing) {
    try {
      await mkdir(each, { mode: 0o700 });
      await chmod(each, 0o700);
    } catch (error) {
      throw new Refusal(`could not make ${each} (${errorCode(error)})`);
    }
  }
}

// The deploy directory, made (0700) when missing, then checked with each entry it holds; true when it was made.
export async function privateDirectory({ make }: { make: boolean }): Promise<boolean> {
  const made = make && (await lstat(directory).catch(() => null)) === null;
  if (made) {
    await makeDirectory();
  }
  await checkDirectory();
  await refuseAcl(directory);
  for (const entry of await readdir(directory)) {
    await checkPrivateFile(join(directory, entry));
  }
  return made;
}

// The names each file of the deploy directory sets: a refusal names one of these, and of any other only its line,
// since a value pasted where a name goes reads as a name.
export const ENV_NAMES: Readonly<Record<string, readonly string[]>> = {
  [WORKER_ENV]: SECRET_NAMES,
  [TARGET_ENV]: ["CLOUDFLARE_ACCOUNT_ID", "PRQ_HOST"],
  [ACCESS_ENV]: ["PRQ_URL", "PRQ_ACCESS_CLIENT_ID", "PRQ_ACCESS_CLIENT_SECRET"],
};

const NAME_LINE = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/;

// An env file's names and values as Node's parseEnv reads them, refused when a line is neither NAME=value, a comment
// nor empty (a value pasted on a line of its own), when this reading of a line's name and Node's differ, or when a
// name is set twice or to a value that spans lines. A refusal names the file, the line and a name the file sets, never
// any part of a value. Each value is hidden from output.
function envEntries(file: string, text: string): Map<string, string> {
  const parsed = parseEnv(text);
  hide(Object.values(parsed).filter((value) => value !== undefined));
  const known = ENV_NAMES[file] ?? [];
  const where = (name: string, index: number) => `${known.includes(name) ? `${name}, ` : ""}line ${index + 1}`;
  const lines = new Map<string, number>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    const name = NAME_LINE.exec(line)?.[1];
    if (name === undefined || !Object.hasOwn(parsed, name)) {
      // A line inside a value that spans lines is told apart below.
      if (Object.values(parsed).some((value) => value !== undefined && /[\r\n]/.test(value))) {
        break;
      }
      throw new Refusal(`line ${index + 1} of ${file} is not NAME=value, a comment or empty`);
    }
    const earlier = lines.get(name);
    if (earlier !== undefined) {
      throw new Refusal(`${file} sets a name twice (${where(name, earlier)} and line ${index + 1})`);
    }
    lines.set(name, index);
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (value !== undefined && /[\r\n]/.test(value)) {
      const index = lines.get(name);
      throw new Refusal(
        `${file} sets a value that spans lines (${index === undefined ? "a name not read as one" : where(name, index)})`,
      );
    }
    if (!lines.has(name)) {
      throw new Refusal(`${file} holds a line Node reads as a name this check does not`);
    }
  }
  return new Map([...lines.keys()].map((name): [string, string] => [name, parsed[name] ?? ""]));
}

// A file of the deploy directory as entries, its directory and itself checked; null when either is missing.
export async function readEnvFile(name: string): Promise<Map<string, string> | null> {
  const path = join(directory, name);
  if ((await lstat(directory).catch(() => null)) === null || (await lstat(path).catch(() => null)) === null) {
    return null;
  }
  await checkDirectory();
  await refuseAcl(directory);
  await checkPrivateFile(path);
  return envEntries(name, await readPrivate(name));
}

// Whether a value is written unquoted as one line that reads back as itself: printable ASCII without spaces.
export function writable(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value) && parseEnv(`V=${value}`)["V"] === value;
}

// The temporary file a write has not renamed yet, removed when a signal or an exit ends this process first.
let pendingTemp: string | null = null;

function discardTemp(): void {
  if (pendingTemp !== null) {
    try {
      unlinkSync(pendingTemp);
    } catch {
      // It is gone.
    }
    pendingTemp = null;
  }
}

// Only the tests' fixture holds a written temporary file before its rename, to stop the write there.
const holdMs = fixture.holdMs ?? 0;

// Sets names in a file of the deploy directory, the rest of it kept with its line endings: the directory made (0700)
// when missing; the file read and checked as envEntries does; a name it holds with another value replaced only on the
// owner's yes (neither value shown), a no stopping before anything is written (replace names those the owner already
// agreed to); then the whole file written to a new 0600 file beside it, renamed over it, and read back. The temporary
// file is removed on a failure, a signal or an exit before its rename. The names it changed, in the order given.
export async function writePrivate(
  name: string,
  values: Readonly<Record<string, string>>,
  { replace = [] }: { replace?: readonly string[] } = {},
): Promise<string[]> {
  hide(Object.values(values));
  for (const [key, value] of Object.entries(values)) {
    if (!writable(value)) {
      throw new Refusal(`the value for ${key} is not one line of printable characters without spaces`);
    }
  }
  await privateDirectory({ make: true });
  const path = join(directory, name);
  const exists = (await lstat(path).catch(() => null)) !== null;
  const text = exists ? await readPrivate(name) : "";
  const entries = envEntries(name, text);
  const changed: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const found = entries.get(key);
    if (found === value) {
      continue;
    }
    if (found !== undefined && !replace.includes(key) && !(await answer(`Replace ${key} in ${name}? [y/N] `))) {
      throw new Refusal(`kept ${key} in ${name}; nothing was written`);
    }
    changed.push(key);
  }
  if (changed.length === 0) {
    return [];
  }
  const ending = text.includes("\r\n") ? "\r\n" : "\n";
  // Each line with its own ending; a last line without one gets the file's.
  const lines =
    text === "" ? [] : text.split(/(?<=\n)/).map((line) => (line.endsWith("\n") ? line : `${line}${ending}`));
  const replaced = lines.map((line) => {
    const key = NAME_LINE.exec(line)?.[1];
    return key !== undefined && changed.includes(key)
      ? `${key}=${values[key] ?? ""}${line.endsWith("\r\n") ? "\r\n" : "\n"}`
      : line;
  });
  const added = changed.filter((key) => !entries.has(key)).map((key) => `${key}=${values[key] ?? ""}${ending}`);
  const temp = join(directory, `.${name}.${randomBytes(6).toString("hex")}`);
  const writeFailed = (what: string, error: unknown) => {
    discardTemp();
    return new Refusal(`could not ${what} ${name} in the deploy directory (${errorCode(error)}); it is as it was`);
  };
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    throw writeFailed("write", error);
  }
  pendingTemp = temp;
  try {
    await handle.chmod(0o600);
    await handle.writeFile([...replaced, ...added].join(""));
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    throw writeFailed("write", error);
  }
  await handle.close();
  if (holdMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }
  try {
    await rename(temp, path);
  } catch (error) {
    throw writeFailed("replace", error);
  }
  pendingTemp = null;
  const written = envEntries(name, await readPrivate(name));
  const differing = Object.keys(values).filter((key) => written.get(key) !== values[key]);
  if (differing.length > 0) {
    throw new Refusal(`${name} does not read back ${differing.join(", ")} as written`);
  }
  return changed;
}

// The terminal's mode restored, while a secret is asked in raw mode.
let restoreTerminal: (() => void) | null = null;

// A secret typed at the terminal without echo, within the bound: read in raw mode, which is restored on every exit
// (Enter, Ctrl-C, Ctrl-D, the bound, a signal, this process's exit). Refused when stdin is not a terminal or nothing
// was typed. Ctrl-C ends this process as SIGINT does. The value is hidden from output before anything else prints. An
// abort of signal ends the question as the bound does.
export async function askSecret(question: string, boundMs = waitMs, signal?: AbortSignal): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    throw new Refusal(`${question.replace(/[:\s]+$/, "")} is asked on a terminal, where it does not show`);
  }
  const stdinHandle: { ref?: () => void; unref?: () => void } = stdin;
  stdin.setRawMode(true);
  restoreTerminal = () => {
    stdin.setRawMode(false);
  };
  process.stdout.write(question);
  const typed = await new Promise<{ value: string } | "interrupted" | null>((resolve) => {
    let text = "";
    const finish = (value: { value: string } | "interrupted" | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onEnd);
      stdin.off("data", onData).off("end", onEnd).off("error", onEnd);
      restoreTerminal?.();
      restoreTerminal = null;
      stdin.pause();
      stdinHandle.unref?.();
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish({ value: text });
          return;
        }
        if (char === "\u0003") {
          finish("interrupted");
          return;
        }
        if (char === "\u0004") {
          finish(text === "" ? null : { value: text });
          return;
        }
        if (char === "\u007f" || char === "\b") {
          text = text.slice(0, -1);
        } else if (char === "\u0015") {
          text = "";
        } else if (char >= " ") {
          text += char;
        }
      }
    };
    const onEnd = () => finish(null);
    const timer = setTimeout(() => finish(null), boundMs);
    signal?.addEventListener("abort", onEnd);
    stdin.setEncoding("utf8").on("data", onData).once("end", onEnd).once("error", onEnd);
    stdinHandle.ref?.();
    stdin.resume();
  });
  if (typed === "interrupted") {
    // As SIGINT would end this process, which raw mode kept the terminal from sending.
    end("SIGINT");
    await new Promise(() => {});
  }
  if (typed === null || typed === "interrupted" || typed.value.trim() === "") {
    throw new Refusal(`nothing was entered at ${question.replace(/[:\s]+$/, "")}`);
  }
  hide([typed.value]);
  return typed.value;
}

// The account target.env names.
export async function account(): Promise<string> {
  const id = parseEnv(await readPrivate(TARGET_ENV))["CLOUDFLARE_ACCOUNT_ID"] ?? "";
  if (!/^[0-9a-f]{32}$/.test(id)) {
    throw new Refusal(`${TARGET_ENV} does not set CLOUDFLARE_ACCOUNT_ID to an account ID (32 hexadecimal digits)`);
  }
  return id;
}

// A hostname as prq is served at (PRQ_HOST), lowercase.
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

// target.env's account and hostname, as the deploy reads them.
export async function readTarget(): Promise<{ accountId: string; host: string }> {
  const accountId = await account();
  const host = (parseEnv(await readPrivate(TARGET_ENV))["PRQ_HOST"] ?? "").toLowerCase();
  if (!HOST.test(host)) {
    throw new Refusal(`${TARGET_ENV} does not set PRQ_HOST to a hostname (such as prq.example.com)`);
  }
  return { accountId, host };
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

function end(signal: NodeJS.Signals): void {
  if (ending) {
    return;
  }
  ending = true;
  restoreTerminal?.();
  restoreTerminal = null;
  discardTemp();
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
  restoreTerminal?.();
  discardTemp();
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

  // A program in the foreground is stopped with every process its tree held at any signal sent, so one that left the
  // tree after the first (its parent ended) still gets the last.
  const seen = new Set<number>();
  const signalAll = (signal: NodeJS.Signals) => {
    if (!foreground) {
      signalGroup(pid, signal);
      return;
    }
    for (const each of tree(pid)) {
      seen.add(each);
    }
    for (const each of seen) {
      try {
        process.kill(each, signal);
      } catch {
        // It has ended.
      }
    }
  };
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
  if (!foreground && code !== 0) {
    // What a program that failed left running in its group ends with it.
    signalGroup(pid, "SIGKILL");
  }
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

// wrangler's environment on the account, built from what KEPT keeps (and, in the tests, what their stand-ins read). A
// call given values on its stdin writes no log file.
export function wranglerEnv(accountId: string, { values = false } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => KEPT.includes(name) || KEPT_PREFIXES.some((prefix) => name.startsWith(prefix)),
    ),
  );
  Object.assign(env, fixture.childEnv, {
    // None before an account is chosen ("").
    ...(accountId === "" ? {} : { CLOUDFLARE_ACCOUNT_ID: accountId }),
    CLOUDFLARE_API_BASE_URL: API,
    // Its debug log, which it also writes to disk, leaves out request bodies, the values among them.
    WRANGLER_LOG_SANITIZE: "true",
    // No debug lines among the JSON its commands print.
    WRANGLER_LOG: "log",
  });
  if (values) {
    // An error from the API, which can quote what was sent, is logged there as it is.
    env["WRANGLER_WRITE_LOGS"] = "false";
  }
  return env;
}

// The repository's wrangler with args on the account ("" before one is chosen), input (if any) on its stdin, its output
// kept for the caller; or, shown, its output on this process's; or in the foreground, on the terminal, within
// timeoutMs. env adds to its environment.
export async function wrangler(
  args: readonly string[],
  accountId: string,
  {
    input,
    output = "keep",
    cwd = SERVER,
    env = {},
    foreground = false,
    timeoutMs = waitMs,
  }: {
    input?: string | undefined;
    output?: "keep" | "show";
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    foreground?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<Outcome> {
  const [program, base] = wranglerCommand();
  return run("wrangler", program, [...base, ...args], {
    cwd,
    env: { ...wranglerEnv(accountId, { values: input !== undefined }), ...env },
    input,
    output,
    timeoutMs,
    foreground,
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

// What a program answers as JSON, read with a schema; source names the call (such as "wrangler whoami").
export function answerOf<S extends v.GenericSchema>(source: string, schema: S, text: string): v.InferOutput<S> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Refusal(`${source} did not answer JSON`);
  }
  const parsed = v.safeParse(schema, json);
  if (!parsed.success) {
    throw new Refusal(`${source} did not answer in the shape this command reads`);
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
  return answerOf(`wrangler ${what}`, schema, outcome.stdout);
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
