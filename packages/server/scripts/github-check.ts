// A manual check of the GitHub App (`pnpm run check:github <owner>/<repo>#<number>` in packages/server): reads
// GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_INSTALLATION_ID from the environment (the package script loads
// packages/server/.dev.vars, which `pnpm run dev-vars write` in packages/cli writes; a variable already set wins),
// mints an installation token and reads the pull request twice through the production client. It never prints the key
// or a token. Exits 1 with the reason when the configuration is missing or invalid, or when a check did not behave as
// reconciliation needs. Not part of the Worker: wrangler bundles only what src/index.ts imports.

import { canonicalPrRef } from "@prq/protocol";

import { readGithubAppConfig } from "../src/config.ts";
import { checkGithub } from "./github-report.ts";

function fail(message: string): never {
  console.error(`github check: ${message}`);
  process.exit(1);
}

const config = readGithubAppConfig(process.env);
if (config === null) {
  fail("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are not set (packages/server/.dev.vars)");
}
if (!config.ok) {
  fail(`the App configuration is invalid: ${config.issues.join("; ")}`);
}
const installation = process.env["GITHUB_INSTALLATION_ID"] ?? "";
if (!/^[1-9][0-9]*$/.test(installation)) {
  fail("GITHUB_INSTALLATION_ID is not a numeric installation ID");
}
const target = /^([^/\s]+)\/([^#\s]+)#([1-9][0-9]*)$/.exec(process.argv.at(-1) ?? "");
if (target === null) {
  fail("name the pull request as <owner>/<repo>#<number>");
}
const [, owner = "", repo = "", number = ""] = target;
const ok = await checkGithub(
  config.config,
  Number(installation),
  canonicalPrRef({ owner, repo, number: Number(number) }),
  (line) => console.log(line),
);
process.exitCode = ok ? 0 : 1;
