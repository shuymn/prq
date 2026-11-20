// What the setup's steps run: a program within its bound, gh among them (in the tests, a stand-in), and the GitHub
// App's token.

import githubAppJwt from "universal-github-app-jwt";

import { fixture } from "./fixture.ts";
import { type Outcome, Refusal, run, waitMs } from "./operations.ts";
import { KEY_FILE } from "./worker-secrets.ts";

// Only the tests' fixture sets the program run in gh's place.
const ghProgram = fixture.gh ?? "gh";

export function duration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A program's environment: this process's, which holds gh's login, and (in the tests) what their stand-ins read.
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...fixture.childEnv };
}

export type CallOptions = {
  output?: "keep" | "show";
  foreground?: boolean;
  timeoutMs?: number;
  // The program's whole environment, in place of childEnv().
  env?: NodeJS.ProcessEnv;
};

// A program in cwd within its bound, refused when it cannot start or does not finish.
export async function call(
  name: string,
  program: string,
  args: readonly string[],
  cwd: string,
  { output = "keep", foreground = false, timeoutMs = waitMs, env = childEnv() }: CallOptions = {},
): Promise<Outcome> {
  const outcome = await run(name, program, args, { cwd, env, output, foreground, timeoutMs });
  if (outcome.timedOut) {
    throw new Refusal(`${name} did not finish within ${duration(timeoutMs)} and was stopped`);
  }
  return outcome;
}

// The App's token (a JWT) from its ID and private key.
export async function appJwt({ appId, key }: { appId: string; key: string }): Promise<string> {
  try {
    const { token } = await githubAppJwt({ id: Number(appId), privateKey: key });
    return token;
  } catch {
    throw new Refusal(`${KEY_FILE} does not make the App's token (an RSA private key is needed)`);
  }
}

export function gh(args: readonly string[], cwd: string, timeoutMs = waitMs): Promise<Outcome> {
  return call(`gh ${args[0] ?? ""}`, ghProgram, args, cwd, { timeoutMs });
}
