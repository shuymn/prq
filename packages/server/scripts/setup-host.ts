// The host's setup steps that need no account: directory, model and check, which setup.ts runs in this order when no
// step is named. What each checks, asks and writes is docs/operations.md's (Setup, steps 2, 7 and 8). Values are asked
// at a prompt that does not echo (askSecret) and written through writePrivate; nothing printed holds one.

import * as v from "valibot";

import { fixture } from "./fixture.ts";
import {
  ACCESS_ENV,
  answerOf,
  askSecret,
  DEPLOY_DIRECTORY,
  ENV_NAMES,
  print,
  privateDirectory,
  readEnvFile,
  readTarget,
  TARGET_ENV,
  Refusal,
  waitMs,
  WORKER_ENV,
  writable,
  writePrivate,
} from "./operations.ts";
import { checkSecrets } from "./worker-secrets.ts";

export const HOST_STEPS = ["directory", "model", "check"] as const;
export type HostStep = (typeof HOST_STEPS)[number];
// The steps each needs done first: a step that stops stops these.
export const NEEDS: Readonly<Record<HostStep, readonly HostStep[]>> = {
  directory: [],
  model: ["directory"],
  check: ["directory", "model"],
};

// DeepSeek's API, which the stored MODEL_BASE_URL must name before the stored key is sent to it, the page its keys are
// made on, and the model lines written with a new key.
const DEEPSEEK = "https://api.deepseek.com";
const DEEPSEEK_KEYS = "https://platform.deepseek.com/api_keys";
const MODEL_DEFAULTS = { MODEL_ID: "deepseek-flash", MODEL_CONTEXT_TOKENS: "1048576" };
const MODELS_LIST = "DeepSeek's models list";
// Only the tests' fixture reads the models list elsewhere.
const modelsOrigin = fixture.modelApi ?? DEEPSEEK;

async function directoryStep(): Promise<void> {
  const made = await privateDirectory({ make: true });
  print(made ? `directory: created ${DEPLOY_DIRECTORY} (0700)` : `directory: ${DEPLOY_DIRECTORY}: pass`);
  print("directory: done");
}

const Models = v.object({ data: v.array(v.object({ id: v.string() })) });

// Whether DeepSeek takes the key (false only when it answers 401 or 403); refused when it takes the key but does not
// list the model.
async function keyWorks(key: string, modelId: string): Promise<boolean> {
  let response;
  try {
    response = await fetch(`${modelsOrigin}/models`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(waitMs),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "no answer in time" : "no connection";
    throw new Refusal(`could not reach ${MODELS_LIST} (${reason})`);
  }
  if (response.status === 401 || response.status === 403) {
    return false;
  }
  if (!response.ok) {
    throw new Refusal(`${MODELS_LIST} answered HTTP ${response.status}`);
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw new Refusal(`${MODELS_LIST} did not answer JSON`);
  }
  if (!answerOf(MODELS_LIST, Models, text).data.some((model) => model.id === modelId)) {
    throw new Refusal(`DeepSeek does not list the model ${modelId} for the key; nothing was written`);
  }
  return true;
}

async function modelStep(): Promise<void> {
  const stored = (await readEnvFile(WORKER_ENV)) ?? new Map<string, string>();
  const base = stored.get("MODEL_BASE_URL");
  if (base !== undefined && base !== DEEPSEEK) {
    print(`model: skipped (MODEL_BASE_URL names another provider than ${DEEPSEEK}: this step checks nothing)`);
    return;
  }
  let key = stored.get("MODEL_API_KEY");
  if (base === undefined && key !== undefined) {
    throw new Refusal(
      `${WORKER_ENV} sets MODEL_API_KEY without MODEL_BASE_URL, so the key's provider is not known: it was sent nowhere`,
    );
  }
  const modelId = stored.get("MODEL_ID") ?? MODEL_DEFAULTS.MODEL_ID;
  if (key !== undefined && !(await keyWorks(key, modelId))) {
    print(`model: DeepSeek refuses the MODEL_API_KEY in ${WORKER_ENV}`);
    key = undefined;
  }
  if (key === undefined) {
    print(`model: create a key for prq's deployment alone, with prepaid credit or a spend limit: ${DEEPSEEK_KEYS}`);
    key = await askSecret("DeepSeek API key (not shown): ");
    if (!writable(key)) {
      throw new Refusal("the key is not one line of printable characters without spaces; nothing was sent");
    }
    if (!(await keyWorks(key, modelId))) {
      throw new Refusal("DeepSeek refused the key; nothing was written");
    }
  }
  print(`model: DeepSeek takes the key and lists ${modelId}`);
  const changed = await writePrivate(WORKER_ENV, {
    MODEL_BASE_URL: DEEPSEEK,
    MODEL_API_KEY: key,
    MODEL_ID: modelId,
    MODEL_CONTEXT_TOKENS: stored.get("MODEL_CONTEXT_TOKENS") ?? MODEL_DEFAULTS.MODEL_CONTEXT_TOKENS,
  });
  if (changed.length > 0) {
    print(`model: wrote ${changed.join(", ")} to ${WORKER_ENV}`);
  }
  print("model: done");
}

// A file's names against the ones it must hold exactly.
function namesIssues(file: string, found: readonly string[]): string[] {
  const expected = ENV_NAMES[file] ?? [];
  const missing = expected.filter((name) => !found.includes(name));
  const extra = found.filter((name) => !expected.includes(name)).length;
  return [
    ...(missing.length > 0 ? [`${file} does not set ${missing.join(", ")}`] : []),
    // Not named: a value pasted where a name goes reads as one.
    ...(extra > 0 ? [`${file} sets ${extra === 1 ? "a name" : `${extra} names`} besides ${expected.join(", ")}`] : []),
  ];
}

async function checkStep(): Promise<void> {
  await privateDirectory({ make: false });
  print("check: the directory and each file in it: the owner's alone, no access control list");
  // Read strictly (a name set twice, which parseEnv reads as its last value, is refused), then checked as secrets
  // check does; a missing file is secrets check's refusal.
  const worker = await readEnvFile(WORKER_ENV);
  const values = await checkSecrets(worker === null ? undefined : Object.fromEntries(worker));
  print(`check: ${WORKER_ENV} and the key: set ${Object.keys(values).join(", ")}; each passes the Worker's checks`);
  const issues: string[] = [];
  const target = await readEnvFile(TARGET_ENV);
  if (target === null) {
    issues.push(`the deploy directory has no ${TARGET_ENV}`);
  } else {
    issues.push(...namesIssues(TARGET_ENV, [...target.keys()]));
    // As the deploy reads it.
    await readTarget().catch((error: unknown) => {
      if (!(error instanceof Refusal)) {
        throw error;
      }
      issues.push(...error.lines);
    });
  }
  const access = await readEnvFile(ACCESS_ENV);
  if (access === null) {
    print(`check: ${ACCESS_ENV}: none yet`);
  } else {
    issues.push(...namesIssues(ACCESS_ENV, [...access.keys()]));
  }
  if (issues.length > 0) {
    throw new Refusal(...issues);
  }
  print(`check: ${TARGET_ENV}${access === null ? "" : ` and ${ACCESS_ENV}`}: exactly their names`);
  print("check: done");
}

export async function hostStep(step: HostStep): Promise<void> {
  switch (step) {
    case "directory":
      return directoryStep();
    case "model":
      return modelStep();
    case "check":
      return checkStep();
  }
}
