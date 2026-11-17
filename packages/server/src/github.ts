import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";
import { type PrRef, Sha } from "@prq/protocol";
import githubAppJwt from "universal-github-app-jwt";
import * as v from "valibot";

import type { GithubAppConfig } from "./config.ts";
import { withTimeout } from "./wait.ts";

// The GitHub App's API calls: installation tokens through @octokit/auth-app and REST reads through @octokit/request.

// How long one call to GitHub may take: a token's minting as a whole, and each HTTP exchange with its response read.
export const GITHUB_CALL_MS = 10_000;

// The REST API version every request names.
const API_VERSION = "2022-11-28";

// One HTTP exchange with GitHub, its response read whole, within GITHUB_CALL_MS. At the bound the request is aborted
// and the call rejects at once, whether or not the request honours the abort; @octokit/request reports the rejection
// as a RequestError with status 500. Every ending aborts the exchange's signal, which a finished one ignores.
async function boundedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const bound = new AbortController();
  const signal = init?.signal ? AbortSignal.any([init.signal, bound.signal]) : bound.signal;
  const exchange = async () => {
    const response = await fetch(input, { ...init, signal });
    return new Response(response.body === null ? null : await response.arrayBuffer(), response);
  };
  try {
    return await withTimeout(exchange(), GITHUB_CALL_MS, "a GitHub request");
  } finally {
    bound.abort();
  }
}

const github = request.defaults({
  headers: { "x-github-api-version": API_VERSION },
  request: { fetch: boundedFetch },
});

// The two fields reconciliation reads of a pull request: its head, and GitHub's time of the state the answer shows.
const PullRequest = v.object({
  head: v.object({ sha: Sha }),
  updated_at: v.pipe(v.string(), v.isoTimestamp(), v.transform(Date.parse)),
});

// A pull request's state as GitHub answered it: one snapshot, its head as of updatedAt (epoch ms, whole seconds).
export type PullRequestState = { headSha: string; updatedAt: number };

export interface GithubClient {
  // GitHub's pull request, read once with the installation's token.
  pullRequest(installationId: number, pr: PrRef): Promise<PullRequestState>;
  // The installation's token, minted within GITHUB_CALL_MS or taken from the cache.
  installationToken(installationId: number): Promise<string>;
}

function createClient(config: GithubAppConfig): GithubClient {
  // auth-app keeps each installation's token until a minute before it expires, and joins concurrent mints of one
  // installation in a module-wide entry that stays until that mint ends. The App's JWT is signed through its
  // `createJwt` option, by universal-github-app-jwt as auth-app would (with GitHub's clock difference) but within
  // GITHUB_CALL_MS, so a signing that never finishes ends that mint, and its entry, too.
  const auth = createAppAuth({
    appId: config.GITHUB_APP_ID,
    createJwt: async (appId, timeDifference) => {
      const now = timeDifference === undefined ? {} : { now: Math.floor(Date.now() / 1000) + timeDifference };
      const signing = githubAppJwt({ id: appId, privateKey: config.GITHUB_APP_PRIVATE_KEY, ...now });
      const signed = await withTimeout(signing, GITHUB_CALL_MS, "the App's JWT");
      return { jwt: signed.token, expiresAt: new Date(signed.expiration * 1000).toISOString() };
    },
    request: github,
  });
  const token = async (installationId: number) => {
    const minted = auth({ type: "installation", installationId });
    return (await withTimeout(minted, GITHUB_CALL_MS, "the installation token")).token;
  };
  return {
    installationToken: token,
    pullRequest: async (installationId, pr) => {
      const response = await github("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.number,
        headers: { authorization: `token ${await token(installationId)}` },
      });
      const parsed = v.parse(PullRequest, response.data);
      return { headSha: parsed.head.sha, updatedAt: parsed.updated_at };
    },
  };
}

const StatusError = v.object({ status: v.number() });

// The HTTP status a failed GitHub call carries: @octokit/request's RequestError has GitHub's (500 for a network failure
// or a request ended at the bound); any other failure (the token's bound, an answer not in the expected shape) has none.
export function githubStatus(error: unknown): number | null {
  return error instanceof Error && v.is(StatusError, error) ? error.status : null;
}

const clients = new WeakMap<object, GithubClient>();

// One client per env object, so once per isolate in production, with its token cache.
export function githubFor(env: object, config: GithubAppConfig): GithubClient {
  let client = clients.get(env);
  if (client === undefined) {
    client = createClient(config);
    clients.set(env, client);
  }
  return client;
}
