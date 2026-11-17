// A manual check of the cloud workspace with Docker (`pnpm run check:workspace <owner>/<repo>#<number>` in
// packages/cli; src/test/workspace.ts), on a pull request of a public repository the GitHub App is installed on. The
// settings come from packages/server/.dev.vars, and nothing else configures them: the model (MODEL_BASE_URL,
// MODEL_API_KEY, MODEL_ID, MODEL_CONTEXT_TOKENS), the App (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY in PKCS#8) and the
// installation the webhook names (GITHUB_INSTALLATION_ID, read by this check only). It never prints the API key, the
// private key, a JWT or a token. Exits 1 with the reason when the settings are missing or a step did not hold.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { canonicalPrRef } from "@prq/protocol";

import { checkWorkspace } from "./workspace.ts";

const DEV_VARS = fileURLToPath(new URL("../../../server/.dev.vars", import.meta.url));
const NAMES = [
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_ID",
  "MODEL_CONTEXT_TOKENS",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_INSTALLATION_ID",
] as const;
// GitHub's token formats, and a JWT.
const TOKEN = /\bgh[opsur]_[A-Za-z0-9_]+/g;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;

function fail(reason: string): never {
  process.stderr.write(`workspace check: ${reason}\n`);
  process.exit(1);
}

// A "--" before the argument (as some package managers pass it) is not an argument.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const target = args.length === 1 ? /^([^/\s]+)\/([^#\s]+)#([1-9][0-9]*)$/.exec(args[0] ?? "") : null;
if (target === null) {
  fail("usage: check:workspace <owner>/<repo>#<number>");
}
const [, owner = "", repo = "", number = ""] = target;

let text: string;
try {
  text = await readFile(DEV_VARS, "utf8");
} catch {
  fail(`no packages/server/.dev.vars to read ${NAMES.join(", ")} from`);
}
const vars = parseEnv(text);
const missing = NAMES.filter((name) => (vars[name] ?? "") === "");
if (missing.length > 0) {
  fail(`packages/server/.dev.vars does not set ${missing.join(", ")}`);
}
const value = (name: (typeof NAMES)[number]) => vars[name] ?? "";
if (!/^[1-9][0-9]*$/.test(value("GITHUB_APP_ID")) || !/^[1-9][0-9]*$/.test(value("GITHUB_INSTALLATION_ID"))) {
  fail("GITHUB_APP_ID and GITHUB_INSTALLATION_ID are numbers");
}

const apiKey = value("MODEL_API_KEY");
const privateKey = value("GITHUB_APP_PRIVATE_KEY");
const keyLines = privateKey
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length >= 16);
// Every line without the API key, the private key (whole, or any line of it), a token or a JWT; a line still holding
// the API key's first characters is withheld.
const print = (line: string) => {
  let redacted = line.replaceAll(apiKey, "[redacted]").replaceAll(privateKey, "[redacted]");
  for (const keyLine of keyLines) {
    redacted = redacted.replaceAll(keyLine, "[redacted]");
  }
  redacted = redacted.replace(TOKEN, "[redacted]").replace(JWT, "[redacted]");
  process.stdout.write(
    `${redacted.includes(apiKey.slice(0, 8)) ? "[a line holding part of the key was withheld]" : redacted}\n`,
  );
};

try {
  const ok = await checkWorkspace(
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
    canonicalPrRef({ owner, repo, number: Number(number) }),
    print,
  );
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  print(`workspace check: failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
