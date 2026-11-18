// Writes, reports and removes packages/server/.dev.vars, the settings the manual checks read (check:workspace,
// check:compaction and check:cloud here; check:provider, check:github and check:tools in packages/server), from the
// owner's secrets directory, ~/.config/prq:
//
//   model.env                        KEY=VALUE lines, each passed through (MODEL_BASE_URL, MODEL_API_KEY, MODEL_ID,
//                                    MODEL_CONTEXT_TOKENS; packages/server/src/env.d.ts)
//   github-app/app.json              its id as GITHUB_APP_ID, its installation_id as GITHUB_INSTALLATION_ID
//   github-app/private-key.pk8.pem   as it is, as GITHUB_APP_PRIVATE_KEY
//
// The App's other fields and its webhook secret are not written: no check reads them there (the Worker gets its webhook
// secret from the check, src/test/worker.ts).
//
// In packages/cli, `pnpm run dev-vars write [--window <tokens>]` writes the file (--window sets MODEL_CONTEXT_TOKENS),
// `status` names the expected variables it sets, and `remove` deletes it. No command line names the file or the
// secrets directory, and nothing printed holds a value, the window aside, or a line of a secret file, an error
// included: an error names the file or the variable.
//
// Each value is written between single quotes, which both parsers that read the file take as they are, newlines
// included, with no escape or expansion: wrangler's (dotenv 16.3.1's parse, bundled in wrangler-dist/cli.js) and
// Node's (util.parseEnv, which the checks here use, and --env-file, which packages/server's use). Refused: a value
// holding a single quote, a carriage return (dotenv reads \r\n as \n) or a NUL (--env-file ends the value there), and
// one ending in a backslash (dotenv takes the closing quote as escaped and the next line into the value).

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const SERVER = "packages/server";
const TARGET = `${SERVER}/.dev.vars`;
// An unfinished write's file, beside the target so a rename replaces it whole; .gitignore's .dev.vars.* covers it.
const TEMPORARY = ".dev.vars.tmp-";
const MODEL = ["MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_ID", "MODEL_CONTEXT_TOKENS"] as const;
const APP = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_INSTALLATION_ID"];
const EXPECTED = [...MODEL, ...APP];
const NUMBER = /^[1-9][0-9]*$/;
const USAGE = "usage: dev-vars write [--window <tokens>] | status | remove";
// All git gets of this process's environment: what it needs to find itself, and the owner's config, which may name more
// ignore rules. Nothing else, since Node's child-process diagnostics (NODE_DEBUG=child_process) print a child's
// environment, and none of the variables that would point git at another repository.
const GIT_ENVIRONMENT = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CEILING_DIRECTORIES",
];

// Only for tests: a secrets directory and a repository of their own.
const secrets = process.env["PRQ_DEV_VARS_SECRETS"] ?? join(homedir(), ".config", "prq");
const root = process.env["PRQ_DEV_VARS_REPOSITORY"] ?? fileURLToPath(new URL("../../../../", import.meta.url));
const target = join(root, TARGET);

// A refusal: its message names a file or a variable, never a value.
class Refusal extends Error {}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown error";
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function readSecret(name: string): Promise<string> {
  try {
    return await readFile(join(secrets, name), "utf8");
  } catch (error) {
    const code = errorCode(error);
    throw new Refusal(code === "ENOENT" ? `the secrets directory has no ${name}` : `could not read ${name} (${code})`);
  }
}

// The variables to write, in order: model.env's, the window, then the App's.
async function settings(window: string | undefined): Promise<Map<string, string>> {
  const model = parseEnv(await readSecret("model.env"));
  const app = await readSecret("github-app/app.json");
  const key = await readSecret("github-app/private-key.pk8.pem");

  const vars = new Map<string, string>();
  for (const [name, value] of Object.entries(model)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Refusal("model.env has a variable name a .dev.vars cannot hold");
    }
    if (APP.includes(name)) {
      throw new Refusal(`model.env sets ${name}, which github-app/ gives`);
    }
    vars.set(name, value ?? "");
  }
  if (window !== undefined) {
    vars.set("MODEL_CONTEXT_TOKENS", window);
  }
  const missing = MODEL.filter((name) => (vars.get(name) ?? "") === "");
  if (missing.length > 0) {
    throw new Refusal(`model.env does not set ${missing.join(", ")}`);
  }
  if (!NUMBER.test(vars.get("MODEL_CONTEXT_TOKENS") ?? "")) {
    throw new Refusal("MODEL_CONTEXT_TOKENS in model.env is not a whole number of tokens");
  }

  let json: unknown;
  try {
    json = JSON.parse(app);
  } catch {
    throw new Refusal("github-app/app.json is not JSON");
  }
  const field = (name: string): string => {
    const value: unknown =
      typeof json === "object" && json !== null ? Object.getOwnPropertyDescriptor(json, name)?.value : undefined;
    const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
    if (!NUMBER.test(text)) {
      throw new Refusal(`github-app/app.json has no numeric ${name}`);
    }
    return text;
  };
  if (key.trim() === "") {
    throw new Refusal("github-app/private-key.pk8.pem is empty");
  }
  vars.set("GITHUB_APP_ID", field("id"));
  vars.set("GITHUB_APP_PRIVATE_KEY", key);
  vars.set("GITHUB_INSTALLATION_ID", field("installation_id"));

  for (const [name, value] of vars) {
    if (/['\r\0]/.test(value)) {
      throw new Refusal(
        `${name} holds a single quote, a carriage return or a NUL, which ${TARGET} cannot hold as it is`,
      );
    }
    if (value.endsWith("\\")) {
      throw new Refusal(`${name} ends with a backslash, which ${TARGET} cannot hold as it is`);
    }
  }
  return vars;
}

// Whether git ignores a path of the repository.
async function ignored(path: string): Promise<boolean> {
  const env: Record<string, string> = {};
  for (const name of GIT_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", root, "check-ignore", "--quiet", "--", path], { env }, (error) => {
      if (error === null || error.code === 1) {
        resolve(error === null);
      } else {
        reject(new Refusal(`could not ask git whether it ignores ${TARGET}`));
      }
    });
  });
}

async function write(window: string | undefined): Promise<void> {
  if (window !== undefined && !NUMBER.test(window)) {
    throw new Refusal("--window takes a whole number of tokens");
  }
  // Written in full to a file of its own, readable by the owner alone, then renamed over the target: git ignores both.
  const temporaryName = `${TEMPORARY}${randomBytes(8).toString("hex")}`;
  const temporary = join(root, SERVER, temporaryName);
  if (!(await ignored(TARGET))) {
    throw new Refusal(`git does not ignore ${TARGET}, so it is not written`);
  }
  if (!(await ignored(`${SERVER}/${temporaryName}`))) {
    throw new Refusal(`git does not ignore the temporary file beside ${TARGET}, so it is not written`);
  }
  const vars = await settings(window);
  const text = [...vars].map(([name, value]) => `${name}='${value}'\n`).join("");

  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.chmod(0o600);
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  print(`wrote ${TARGET} (mode 0600)`);
  print(`variables: ${[...vars.keys()].join(", ")}`);
  print(
    `window: ${vars.get("MODEL_CONTEXT_TOKENS") ?? ""} tokens (${window === undefined ? "model.env" : "--window"})`,
  );
}

async function status(): Promise<void> {
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
    print(`no ${TARGET}`);
    return;
  }
  const vars = parseEnv(text);
  const set = EXPECTED.filter((name) => (vars[name] ?? "") !== "");
  print(`${TARGET} exists`);
  print(`sets: ${set.length > 0 ? set.join(", ") : "none of the expected variables"}`);
  const unset = EXPECTED.filter((name) => !set.includes(name));
  if (unset.length > 0) {
    print(`does not set: ${unset.join(", ")}`);
  }
}

async function remove(): Promise<void> {
  const existed = await unlink(target).then(
    () => true,
    (error: unknown) => {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
      return false;
    },
  );
  print(existed ? `removed ${TARGET}` : `no ${TARGET} to remove`);
  // A write that was stopped before its rename.
  for (const name of await readdir(join(root, SERVER))) {
    if (name.startsWith(TEMPORARY)) {
      await unlink(join(root, SERVER, name));
      print(`removed an unfinished write, ${SERVER}/${name}`);
    }
  }
}

// A "--" before the arguments (as some package managers pass it) is not an argument.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
let command: string | undefined;
let window: string | undefined;
try {
  const { values, positionals } = parseArgs({ args, options: { window: { type: "string" } }, allowPositionals: true });
  [command] = positionals;
  window = values.window;
  if (positionals.length !== 1 || (window !== undefined && command !== "write")) {
    command = undefined;
  }
} catch (error) {
  process.stderr.write(`dev-vars: ${error instanceof Error ? error.message : String(error)}; ${USAGE}\n`);
  process.exit(1);
}

try {
  switch (command) {
    case "write":
      await write(window);
      break;
    case "status":
      await status();
      break;
    case "remove":
      await remove();
      break;
    default:
      throw new Refusal(USAGE);
  }
} catch (error) {
  // Only a refusal's own message: another error's may quote what it read.
  process.stderr.write(`dev-vars: ${error instanceof Refusal ? error.message : `failed (${errorCode(error)})`}\n`);
  process.exitCode = 1;
}
