// The settings and the output of a manual check with the GitHub App, and a model for the checks that run one
// (check:workspace, check:compaction; check:skills needs the App alone): read from packages/server/.dev.vars (`pnpm run
// dev-vars write`; src/test/dev-vars.ts), and nothing else configures them. The model (MODEL_BASE_URL, MODEL_API_KEY,
// MODEL_ID, MODEL_CONTEXT_TOKENS), the App (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY in PKCS#8) and the installation the
// webhook names (GITHUB_INSTALLATION_ID, read by these checks only). Its output never holds the API key, the private
// key, a JWT or a token. Exits 1 with the reason when the settings are missing or a step did not hold.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig, parseEnv } from "node:util";

import { canonicalPrRef, type PrRef } from "@prq/protocol";

import type { GithubApp } from "./reconcile.ts";
import type { GithubAppSettings, ModelSettings } from "./worker.ts";

const DEV_VARS = fileURLToPath(new URL("../../../server/.dev.vars", import.meta.url));
const APP_NAMES = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"] as const;
const NAMES = [
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_ID",
  "MODEL_CONTEXT_TOKENS",
  ...APP_NAMES,
  "GITHUB_INSTALLATION_ID",
] as const;
// GitHub's token formats, and a JWT.
const TOKEN = /\bgh[opsur]_[A-Za-z0-9_]+/g;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;

// The values of a check's options, as parseArgs gives them.
type Values<O extends ParseArgsOptionsConfig> = ReturnType<
  typeof parseArgs<{ options: O; allowPositionals: true }>
>["values"];

// An option's value a check does not take, thrown before the check starts anything: reported with the usage, as
// parseArgs's own errors are.
export class UsageError extends Error {}

export type AppCheck<O extends ParseArgsOptionsConfig = ParseArgsOptionsConfig> = (
  settings: { app: GithubApp; model: ModelSettings },
  pr: PrRef,
  print: (line: string) => void,
  values: Values<O>,
) => Promise<boolean>;

function failer(name: string): (reason: string) => never {
  return (reason) => {
    process.stderr.write(`${name} check: ${reason}\n`);
    process.exit(1);
  };
}

// The named settings of packages/server/.dev.vars, each one set, the App's ID a number.
async function readSettings<const N extends string>(
  names: readonly N[],
  fail: (reason: string) => never,
): Promise<(variable: N) => string> {
  let text: string;
  try {
    text = await readFile(DEV_VARS, "utf8");
  } catch {
    fail(`no packages/server/.dev.vars to read ${names.join(", ")} from`);
  }
  const vars = parseEnv(text);
  const missing = names.filter((variable) => (vars[variable] ?? "") === "");
  if (missing.length > 0) {
    fail(`packages/server/.dev.vars does not set ${missing.join(", ")}`);
  }
  if (!/^[1-9][0-9]*$/.test(vars["GITHUB_APP_ID"] ?? "")) {
    fail("GITHUB_APP_ID is a number");
  }
  return (variable) => vars[variable] ?? "";
}

// A print that writes every line without the private key (whole, or any line of it), the API key, a token or a JWT; a
// line still holding the API key's first characters is withheld.
function redactingPrint(privateKey: string, apiKey: string | null): (line: string) => void {
  const keyLines = privateKey
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 16);
  return (line) => {
    let redacted = line.replaceAll(privateKey, "[redacted]");
    if (apiKey !== null) {
      redacted = redacted.replaceAll(apiKey, "[redacted]");
    }
    for (const keyLine of keyLines) {
      redacted = redacted.replaceAll(keyLine, "[redacted]");
    }
    redacted = redacted.replace(TOKEN, "[redacted]").replace(JWT, "[redacted]");
    const withheld = apiKey !== null && redacted.includes(apiKey.slice(0, 8));
    process.stdout.write(`${withheld ? "[a line holding part of the key was withheld]" : redacted}\n`);
  };
}

// A pull request as a check's argument names it, <owner>/<repo>#<number>; null for anything else.
export function prArgument(arg: string | undefined): PrRef | null {
  const target = /^([^/\s]+)\/([^#\s]+)#([1-9][0-9]*)$/.exec(arg ?? "");
  if (target === null) {
    return null;
  }
  const [, owner = "", repo = "", number = ""] = target;
  return canonicalPrRef({ owner, repo, number: Number(number) });
}

// Runs a check named `name` that needs the GitHub App alone, with the App of packages/server/.dev.vars, and sets the
// exit code. The check reads its own arguments, before it calls this.
export async function runGithubAppCheck(
  name: string,
  check: (app: GithubAppSettings, print: (line: string) => void) => Promise<boolean>,
): Promise<void> {
  const fail: (reason: string) => never = failer(name);
  const value = await readSettings(APP_NAMES, fail);
  const app = { GITHUB_APP_ID: value("GITHUB_APP_ID"), GITHUB_APP_PRIVATE_KEY: value("GITHUB_APP_PRIVATE_KEY") };
  const print = redactingPrint(app.GITHUB_APP_PRIVATE_KEY, null);
  try {
    process.exitCode = (await check(app, print)) ? 0 : 1;
  } catch (error) {
    print(`${name} check: failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

// Runs a check named `name` against the pull request its one argument names, besides the check's `options` (each a flag
// or an option with a value), with the settings of packages/server/.dev.vars, and sets the exit code.
export async function runAppCheck<const O extends ParseArgsOptionsConfig>(
  name: string,
  check: AppCheck<O>,
  options: O,
): Promise<void> {
  const fail: (reason: string) => never = failer(name);
  const usage = Object.entries(options)
    .map(
      ([option, { type }]) => `[--${option}${type === "string" ? ` <${option.split("-").at(-1) ?? "value"}>` : ""}] `,
    )
    .join("");
  // A "--" before the arguments (as some package managers pass it) is not an argument.
  let parsed: { values: Values<O>; positionals: string[] };
  try {
    parsed = parseArgs({ args: process.argv.slice(2).filter((arg) => arg !== "--"), options, allowPositionals: true });
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}; usage: check:${name} ${usage}<owner>/<repo>#<number>`,
    );
  }
  const { values, positionals } = parsed;
  const pr = positionals.length === 1 ? prArgument(positionals[0]) : null;
  if (pr === null) {
    fail(`usage: check:${name} ${usage}<owner>/<repo>#<number>`);
  }

  const value = await readSettings(NAMES, fail);
  if (!/^[1-9][0-9]*$/.test(value("GITHUB_INSTALLATION_ID"))) {
    fail("GITHUB_APP_ID and GITHUB_INSTALLATION_ID are numbers");
  }
  const apiKey = value("MODEL_API_KEY");
  const privateKey = value("GITHUB_APP_PRIVATE_KEY");
  const print = redactingPrint(privateKey, apiKey);

  try {
    const ok = await check(
      {
        app: {
          settings: { GITHUB_APP_ID: value("GITHUB_APP_ID"), GITHUB_APP_PRIVATE_KEY: privateKey },
          installationId: Number(value("GITHUB_INSTALLATION_ID")),
        },
        model: {
          MODEL_BASE_URL: value("MODEL_BASE_URL"),
          MODEL_API_KEY: apiKey,
          MODEL_ID: value("MODEL_ID"),
          MODEL_CONTEXT_TOKENS: value("MODEL_CONTEXT_TOKENS"),
        },
      },
      pr,
      print,
      values,
    );
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      fail(`${error.message}; usage: check:${name} ${usage}<owner>/<repo>#<number>`);
    }
    print(`${name} check: failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
