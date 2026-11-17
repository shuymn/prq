// A manual end-to-end check of the cloud agent (`pnpm run check:cloud` in packages/cli; src/test/cloud.ts): the model
// settings come from packages/server/.dev.vars, and nothing else configures one. With --invalid-model, the model ID is
// replaced by one no provider has, and the check passes when the job fails with the provider's refusal. It never prints
// the API key. Exits 1 with the reason when the settings are missing or the job did not end as expected.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { checkCloud } from "./cloud.ts";
import type { ModelSettings } from "./worker.ts";

const DEV_VARS = fileURLToPath(new URL("../../../server/.dev.vars", import.meta.url));
const NAMES = ["MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_ID", "MODEL_CONTEXT_TOKENS"] as const;
const INVALID_MODEL_ID = "prq-check-no-such-model";

function fail(reason: string): never {
  process.stderr.write(`cloud check: ${reason}\n`);
  process.exit(1);
}

// A "--" before the flag (as some package managers pass it) is not an argument.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.some((arg) => arg !== "--invalid-model")) {
  fail("usage: check:cloud [--invalid-model]");
}
const invalidModel = args.includes("--invalid-model");

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
const settings: ModelSettings = {
  MODEL_BASE_URL: vars["MODEL_BASE_URL"] ?? "",
  MODEL_API_KEY: vars["MODEL_API_KEY"] ?? "",
  MODEL_ID: vars["MODEL_ID"] ?? "",
  MODEL_CONTEXT_TOKENS: vars["MODEL_CONTEXT_TOKENS"] ?? "",
};
const model = invalidModel ? { ...settings, MODEL_ID: INVALID_MODEL_ID } : settings;

const key = settings.MODEL_API_KEY;
// Every line without the key; a line still holding its first characters is withheld.
const print = (line: string) => {
  const redacted = line.replaceAll(key, "[redacted]");
  process.stdout.write(
    `${redacted.includes(key.slice(0, 8)) ? "[a line holding part of the key was withheld]" : redacted}\n`,
  );
};

try {
  process.exitCode = (await checkCloud(model, invalidModel, print)) ? 0 : 1;
} catch (error) {
  print(`cloud check: failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
