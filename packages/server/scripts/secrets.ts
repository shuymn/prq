// The Worker's production secrets: `pnpm run secrets check|status|put` in packages/server. docs/operations.md
// describes the deploy directory's files, what each command checks and does, and what it never prints. The deploy
// directory's checks, the output's redaction and wrangler's process are operations.ts's.

import { createPublicKey } from "node:crypto";
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
import {
  account,
  accountName,
  answer,
  answerOf,
  checkConfigAccount,
  CONFIG,
  exited,
  failed,
  hide,
  onInterrupt,
  type Outcome,
  print,
  printError,
  readPrivate,
  Refusal,
  runCommand,
  stopped,
  succeeded,
  Unconfirmed,
  WORKER,
  WORKER_ENV,
  wrangler,
} from "./operations.ts";

const KEY = "GITHUB_APP_PRIVATE_KEY";
// What worker.env holds: every secret but the key, which has a file of its own.
const SCALARS = SECRET_NAMES.filter((name) => name !== KEY);
const KEY_FILE = "github-app.pk8.pem";
const USAGE = "usage: secrets check | status | put";
const STATUS_HINT = "`pnpm --dir packages/server run secrets status` (from the repository root)";

// The ten secrets, as the Worker reads them and in its order, refused unless each is set and nothing else is.
async function readSecrets(): Promise<Record<string, string>> {
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

// `secret list --format json`'s names.
const SecretList = v.array(v.object({ name: v.string() }));

// The names of the Worker's secrets; refused when the Worker cannot be read, a missing one included.
async function secretNames(accountId: string): Promise<string[]> {
  const outcome = await wrangler(
    ["secret", "list", "--format", "json", "--config", CONFIG, "--env", "", "--name", WORKER],
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
  onInterrupt(async (signal) => {
    printError(`secrets: stopped by ${signal}: wrangler secret bulk was running, and ${UNCONFIRMED}`);
  });
  const outcome = await wrangler(["secret", "bulk", "--config", CONFIG, "--env", "", "--name", WORKER], accountId, {
    input: JSON.stringify(values),
  });
  onInterrupt(null);
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
await runCommand("secrets", async () => {
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
});
