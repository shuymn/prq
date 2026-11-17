// The check of scripts/github-check.ts: the production GitHub client (githubFor, with its bounds) mints an
// installation token and reads a pull request twice, the second time with the token it kept. It prints each request's
// method, path and status, never a header or a body, and every line goes through redaction: the key, every credential
// a request carried (the App's JWT, the installation token), and anything in a GitHub token's format.

import type { PrRef } from "@prq/protocol";

import type { GithubAppConfig } from "../src/config.ts";
import { githubFor, githubStatus } from "../src/github.ts";

// GitHub's token formats (installation, user, OAuth, refresh, server-to-server).
const TOKEN = /\bgh[opsur]_[A-Za-z0-9_]+/g;
const TOKEN_PATH = /^\/app\/installations\/[0-9]+\/access_tokens$/;

function redact(line: string, secrets: Iterable<string>): string {
  let redacted = line;
  for (const secret of secrets) {
    redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted.replace(TOKEN, "[redacted]");
}

function describe(error: unknown): string {
  const status = githubStatus(error);
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return status === null ? message : `HTTP ${status}, ${message}`;
}

export async function checkGithub(
  config: GithubAppConfig,
  installationId: number,
  pr: PrRef,
  print: (line: string) => void,
): Promise<boolean> {
  // The key, and each request's credential by value, before any upstream text is printed.
  const secrets = new Set([config.GITHUB_APP_PRIVATE_KEY]);
  const say = (line: string) => print(redact(line, secrets));
  const paths: string[] = [];
  const passThrough = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const credential = (request.headers.get("authorization") ?? "").replace(/^\S+\s+/, "");
    if (credential !== "") {
      secrets.add(credential);
    }
    const { pathname } = new URL(request.url);
    paths.push(pathname);
    try {
      const response = await passThrough(input, init);
      say(`  ${request.method} ${pathname}: ${response.status}`);
      return response;
    } catch (error) {
      say(`  ${request.method} ${pathname}: failed (${describe(error)})`);
      throw error;
    }
  };
  try {
    say(`App ${config.GITHUB_APP_ID}, installation ${installationId}, ${pr.owner}/${pr.repo}#${pr.number}`);
    const github = githubFor({}, config);
    for (const read of [1, 2]) {
      const started = Date.now();
      try {
        const answer = await github.pullRequest(installationId, pr);
        const updatedAt = new Date(answer.updatedAt).toISOString();
        say(`read ${read}: head ${answer.headSha}, updated_at ${updatedAt} (${Date.now() - started} ms)`);
      } catch (error) {
        say(`read ${read}: failed (${describe(error)})`);
        say("NOT as expected");
        return false;
      }
    }
    const tokens = paths.filter((path) => TOKEN_PATH.test(path)).length;
    say(`token requests: ${tokens} (the second read reuses the first read's token)`);
    const ok = tokens === 1;
    say(ok ? "as expected" : "NOT as expected");
    return ok;
  } finally {
    globalThis.fetch = passThrough;
  }
}
