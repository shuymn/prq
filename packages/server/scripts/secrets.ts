// The Worker's production secrets: `pnpm run secrets check|status|put` in packages/server. docs/operations.md
// describes the deploy directory's files, what each command checks and does, and what it never prints. The deploy
// directory's checks, the output's redaction and wrangler's process are operations.ts's; the check of the values is
// worker-secrets.ts's.

import * as v from "valibot";

import { SECRET_NAMES } from "../src/config.ts";
import {
  account,
  accountName,
  answer,
  checkConfigAccount,
  exited,
  onInterrupt,
  type Outcome,
  print,
  printError,
  refuseOverrides,
  Refusal,
  runCommand,
  stopped,
  succeeded,
  TOP_LEVEL,
  Unconfirmed,
  WORKER,
  wrangler,
  wranglerJson,
} from "./operations.ts";
import { checkSecrets } from "./worker-secrets.ts";

const USAGE = "usage: secrets check | status | put";
const STATUS_HINT = "`pnpm --dir packages/server run secrets status` (from the repository root)";

// `secret list --format json`'s names.
const SecretList = v.array(v.object({ name: v.string() }));

// The names of the Worker's secrets; refused when the Worker cannot be read, a missing one included.
async function secretNames(accountId: string): Promise<string[]> {
  const listed = await wranglerJson(
    "secret list",
    ["secret", "list", "--format", "json", ...TOP_LEVEL, "--name", WORKER],
    accountId,
    SecretList,
  );
  return listed.map((entry) => entry.name);
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
  const values = await checkSecrets();
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
  const outcome = await wrangler(["secret", "bulk", ...TOP_LEVEL, "--name", WORKER], accountId, {
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
      const values = await checkSecrets();
      print(`set: ${Object.keys(values).join(", ")}`);
      print("each passes the Worker's checks (src/config.ts), and the key signs an RS256 token that verifies");
      break;
    }
    case "status":
      refuseOverrides();
      await status();
      break;
    case "put":
      refuseOverrides();
      await put();
      break;
    default:
      throw new Refusal(USAGE);
  }
});
