// The Worker's secrets as the deploy directory holds them, checked as the Worker would read them: `secrets check`, and
// the setup's check step (docs/operations.md).

import { createPublicKey } from "node:crypto";
import { parseEnv } from "node:util";

import { jwtVerify } from "jose";
import githubAppJwt from "universal-github-app-jwt";

import {
  readAccessConfig,
  readGithubAppConfig,
  readModelConfig,
  readWebhookConfig,
  SECRET_NAMES,
} from "../src/config.ts";
import { hide, readPrivate, Refusal, WORKER_ENV } from "./operations.ts";

const KEY = "GITHUB_APP_PRIVATE_KEY";
// What worker.env holds: every secret but the key, which has a file of its own.
const SCALARS = SECRET_NAMES.filter((name) => name !== KEY);
export const KEY_FILE = "github-app.pk8.pem";

// The ten secrets, as the Worker reads them and in its order, refused unless each is set and nothing else is. worker.env
// as given (read by a stricter reader), else read here.
async function readSecrets(given?: Readonly<Record<string, string | undefined>>): Promise<Record<string, string>> {
  const vars = given ?? parseEnv(await readPrivate(WORKER_ENV));
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
export async function checkSecrets(
  vars?: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, string>> {
  const values = await readSecrets(vars);
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
