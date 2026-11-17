// A manual check of head reconciliation through the Worker (`pnpm run check:reconcile <owner>/<repo>#<number>` in
// packages/cli; src/test/reconcile.ts). It reads the GitHub App from the environment (GITHUB_APP_ID,
// GITHUB_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY in PKCS#8) or, for each one not set there, from
// ~/.config/prq/github-app/ (app.json's `id` and `installation_id`, private-key.pk8.pem), and nothing else configures
// one. It reads one pull request through the App's installation, and never prints the key, a JWT or a token. Exits 1
// with the reason when the App's settings are missing or the session did not end at GitHub's head.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { canonicalPrRef } from "@prq/protocol";
import * as v from "valibot";

import { checkReconcile } from "./reconcile.ts";

const APP_DIR = join(homedir(), ".config", "prq", "github-app");
const AppFile = v.looseObject({
  id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  installation_id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
// GitHub's token formats, and a JWT.
const TOKEN = /\bgh[opsur]_[A-Za-z0-9_]+/g;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;

function fail(reason: string): never {
  process.stderr.write(`reconcile check: ${reason}\n`);
  process.exit(1);
}

// A "--" before the argument (as some package managers pass it) is not an argument.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const target = args.length === 1 ? /^([^/\s]+)\/([^#\s]+)#([1-9][0-9]*)$/.exec(args[0] ?? "") : null;
if (target === null) {
  fail("usage: check:reconcile <owner>/<repo>#<number>");
}
const [, owner = "", repo = "", number = ""] = target;

const env = (name: string) => {
  const value = process.env[name] ?? "";
  return value === "" ? null : value;
};

// The file's text, or null when it cannot be read.
async function read(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

let appFile: v.InferOutput<typeof AppFile> | undefined;
async function fromAppFile(): Promise<v.InferOutput<typeof AppFile>> {
  const path = join(APP_DIR, "app.json");
  if (appFile === undefined) {
    const text = await read(path);
    const parsed = text === null ? null : v.safeParse(v.pipe(v.string(), v.parseJson(), AppFile), text);
    if (parsed?.success !== true) {
      fail(`set GITHUB_APP_ID and GITHUB_INSTALLATION_ID, or give ${path} its id and installation_id`);
    }
    appFile = parsed.output;
  }
  return appFile;
}

const appId = env("GITHUB_APP_ID") ?? String((await fromAppFile()).id);
const installation = env("GITHUB_INSTALLATION_ID") ?? String((await fromAppFile()).installation_id);
if (!/^[1-9][0-9]*$/.test(appId) || !/^[1-9][0-9]*$/.test(installation)) {
  fail("the App ID and the installation ID are numbers");
}
const KEY_FILE = join(APP_DIR, "private-key.pk8.pem");
const key = env("GITHUB_APP_PRIVATE_KEY") ?? (await read(KEY_FILE));
if (key === null) {
  fail(`set GITHUB_APP_PRIVATE_KEY, or put the App's PKCS#8 key in ${KEY_FILE}`);
}

// Every line without the key (whole, or any line of it), a token or a JWT.
const keyLines = key
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length >= 16);
const print = (line: string) => {
  let redacted = line.replaceAll(key, "[redacted]");
  for (const keyLine of keyLines) {
    redacted = redacted.replaceAll(keyLine, "[redacted]");
  }
  process.stdout.write(`${redacted.replace(TOKEN, "[redacted]").replace(JWT, "[redacted]")}\n`);
};

try {
  const ok = await checkReconcile(
    { settings: { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: key }, installationId: Number(installation) },
    canonicalPrRef({ owner, repo, number: Number(number) }),
    print,
  );
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  print(`reconcile check: failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
