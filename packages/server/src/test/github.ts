// GitHub's API for the GitHub App's calls: a globalThis.fetch spy answers the installation token request and the pull
// request reads with what a test queues, and records each request with its signal. Any other GitHub URL fails the
// request; other fetches keep the implementation installed before. Sessions read the App's configuration from env,
// which a test sets on the live instance.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";

import type { PrSession } from "../pr-session/index.ts";

const API = "https://api.github.com";

// The App as a test configures it: its ID and the run's PKCS#8 key (vitest.config.ts).
export function appEnv(): { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: string } {
  const key: unknown = Reflect.get(env, "TEST_GITHUB_APP_KEY");
  if (typeof key !== "string") {
    throw new TypeError("TEST_GITHUB_APP_KEY is not set (vitest.config.ts)");
  }
  return { GITHUB_APP_ID: "4242", GITHUB_APP_PRIVATE_KEY: key };
}

// The installation token the served API mints.
export const TEST_TOKEN = "installation-token-for-tests";

// The session reads the App's configuration from now on. The instance keeps it until it is reset.
export async function useGithubApp(stub: DurableObjectStub<PrSession>): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    Reflect.set(instance, "env", { ...env, ...appEnv() });
  });
}

export type GithubReply = (signal: AbortSignal | undefined) => Promise<Response>;

type GithubRequest = { method: string; path: string; authorization: string | null; signal: AbortSignal | undefined };

export type GithubApi = {
  // Every request served, in order.
  readonly requests: GithubRequest[];
  // The token requests and the pull request reads among them.
  tokens(): GithubRequest[];
  reads(): GithubRequest[];
  // Replies for the next pull request reads, in order.
  reply(...replies: GithubReply[]): void;
  // The reply to token requests from now on (a minted token unless set).
  tokenReply(reply: GithubReply): void;
};

// A pull request as GitHub answers it: its head and the time of the state the answer shows.
export function pull(headSha: string, updatedAt: number): GithubReply {
  const body = {
    number: 1,
    head: { sha: headSha },
    updated_at: new Date(updatedAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  return async () => Response.json(body);
}

export function failure(status: number, message = "failure"): GithubReply {
  return async () => Response.json({ message }, { status });
}

// A reply that settles only when its signal aborts it.
export const hanging: GithubReply = (signal) =>
  new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });

function minted(): GithubReply {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  return async () =>
    Response.json(
      { token: TEST_TOKEN, expires_at: expiresAt, permissions: { pull_requests: "read" }, repository_selection: "all" },
      { status: 201 },
    );
}

const TOKEN_PATH = /^\/app\/installations\/[0-9]+\/access_tokens$/;
const PULL_PATH = /^\/repos\/[^/]+\/[^/]+\/pulls\/[0-9]+$/;

export function serveGithub(): GithubApi {
  const requests: GithubRequest[] = [];
  const replies: GithubReply[] = [];
  let tokenReply: GithubReply | undefined;
  const spy = vi.isMockFunction(globalThis.fetch) ? vi.mocked(globalThis.fetch) : vi.spyOn(globalThis, "fetch");
  const earlier = spy.getMockImplementation();
  spy.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== API) {
      if (earlier === undefined) {
        throw new Error(`unexpected fetch: ${request.url}`);
      }
      return earlier(input, init);
    }
    const signal = init?.signal ?? undefined;
    const served = {
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get("authorization"),
      signal,
    };
    if (request.method === "POST" && TOKEN_PATH.test(url.pathname)) {
      requests.push(served);
      return (tokenReply ?? minted())(signal);
    }
    if (request.method === "GET" && PULL_PATH.test(url.pathname)) {
      requests.push(served);
      const reply = replies.shift();
      if (reply === undefined) {
        throw new Error("no reply left for this pull request read");
      }
      return reply(signal);
    }
    throw new Error(`unexpected GitHub request: ${request.method} ${request.url}`);
  });
  return {
    requests,
    tokens: () => requests.filter((request) => request.method === "POST"),
    reads: () => requests.filter((request) => request.method === "GET"),
    reply: (...added) => {
      replies.push(...added);
    },
    tokenReply: (reply) => {
      tokenReply = reply;
    },
  };
}
