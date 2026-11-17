import { decodeJwt } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readGithubAppConfig } from "./config.ts";
import { GITHUB_CALL_MS, githubFor, githubStatus } from "./github.ts";
import { appEnv, failure, hanging, pull, serveGithub, TEST_TOKEN } from "./test/github.ts";
import { until } from "./test/provider.ts";
import { sha } from "./test/webhook.ts";

// The GitHub App's client against the served API (src/test/github.ts): installation tokens, pull request reads, and
// the bound on each.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PR = { owner: "octo", repo: "widgets", number: 7 };
const AT = Date.UTC(2026, 10, 1, 0, 0, 1);

// A client of its own: one per env object, so each test starts with an empty token cache.
function client() {
  const config = readGithubAppConfig(appEnv());
  if (config?.ok !== true) {
    throw new Error("appEnv() is not a valid configuration");
  }
  return githubFor({}, config.config);
}

// A promise's state, without waiting for it.
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; error?: unknown } = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

describe("installation tokens", () => {
  it("mints a token once per client and installation, signed as the App, and reads with it", async () => {
    const api = serveGithub();
    api.reply(pull(sha("A"), AT), pull(sha("B"), AT + 1000), pull(sha("C"), AT + 2000));
    const github = client();

    expect(await github.pullRequest(5, PR)).toEqual({ headSha: sha("A"), updatedAt: AT });
    expect(await github.pullRequest(5, PR)).toEqual({ headSha: sha("B"), updatedAt: AT + 1000 });
    expect(api.tokens().map((request) => request.path)).toEqual(["/app/installations/5/access_tokens"]);
    // Another installation gets its own token.
    await github.pullRequest(6, PR);
    expect(api.tokens().map((request) => request.path)).toEqual([
      "/app/installations/5/access_tokens",
      "/app/installations/6/access_tokens",
    ]);

    const [token] = api.tokens();
    expect(token?.authorization).toMatch(/^bearer /);
    expect(decodeJwt(token?.authorization?.slice("bearer ".length) ?? "")).toMatchObject({ iss: 4242 });
    expect(api.reads().map((read) => [read.path, read.authorization])).toEqual([
      ["/repos/octo/widgets/pulls/7", `token ${TEST_TOKEN}`],
      ["/repos/octo/widgets/pulls/7", `token ${TEST_TOKEN}`],
      ["/repos/octo/widgets/pulls/7", `token ${TEST_TOKEN}`],
    ]);
  });

  it("ends a token request that does not answer at the bound, aborting it, and mints anew on the next call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const api = serveGithub();
    api.tokenReply(hanging);
    const github = client();

    const call = track(github.pullRequest(11, PR));
    await until(() => api.tokens().length === 1, "the token request");
    await vi.advanceTimersByTimeAsync(GITHUB_CALL_MS - 1);
    expect(call.settled).toBe(false);
    expect(api.tokens()[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => call.settled, "the call's end");
    expect(String(call.error)).toMatch(/took over 10000 ms/);
    expect(api.tokens()[0]?.signal?.aborted).toBe(true);
    expect(api.reads()).toEqual([]);

    // The aborted request no longer stands for the installation's token: the next call mints one.
    api.tokenReply(async () => failure(503)(undefined));
    const next = track(github.pullRequest(11, PR));
    await until(() => next.settled, "the next call's end");
    expect(api.tokens()).toHaveLength(2);
    expect(githubStatus(next.error)).toBe(503);
  });
});

describe("pull request reads", () => {
  it("ends a read that does not answer at the bound, aborting it, as a failure with status 500", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const api = serveGithub();
    api.reply(hanging);
    const github = client();

    const call = track(github.pullRequest(12, PR));
    await until(() => api.reads().length === 1, "the read");
    await vi.advanceTimersByTimeAsync(GITHUB_CALL_MS - 1);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => call.settled, "the read's end");
    expect(api.reads()[0]?.signal?.aborted).toBe(true);
    expect(githubStatus(call.error)).toBe(500);
  });

  it("ends a read whose body does not finish at the bound, though the request ignores its abort", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const api = serveGithub();
    api.reply(async () => new Response(new ReadableStream({ start: () => undefined }), { status: 200 }));
    const github = client();

    const call = track(github.pullRequest(13, PR));
    await until(() => api.reads().length === 1, "the read");
    await vi.advanceTimersByTimeAsync(GITHUB_CALL_MS);
    await until(() => call.settled, "the read's end");
    expect(githubStatus(call.error)).toBe(500);
  });

  it("names GitHub's status for a refusal, and none for an answer outside the expected shape", async () => {
    const api = serveGithub();
    api.reply(failure(404, "Not Found"), async () => Response.json({ head: { sha: "nope" } }));
    const github = client();

    const refused = await github.pullRequest(14, PR).catch((error: unknown) => error);
    expect(githubStatus(refused)).toBe(404);
    const malformed = await github.pullRequest(14, PR).catch((error: unknown) => error);
    expect(malformed).toBeInstanceOf(Error);
    expect(githubStatus(malformed)).toBeNull();
  });
});
