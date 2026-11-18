import { decodeJwt } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readGithubAppConfig } from "./config.ts";
import { GITHUB_CALL_MS, githubFor, githubStatus } from "./github.ts";
import { appEnv, failure, hanging, pull, serveGithub, tokenFor } from "./test/github.ts";
import { until } from "./test/provider.ts";
import { tracked } from "./test/session.ts";
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

// A read's outcome, tracked without waiting for it: its answer, or the error it failed with.
function outcome(github: ReturnType<typeof client>, installationId: number) {
  return tracked(github.pullRequest(installationId, PR).catch((error: unknown) => error));
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
      ["/repos/octo/widgets/pulls/7", `token ${tokenFor(5)}`],
      ["/repos/octo/widgets/pulls/7", `token ${tokenFor(5)}`],
      ["/repos/octo/widgets/pulls/7", `token ${tokenFor(6)}`],
    ]);
  });

  it("ends a token request that does not answer at the bound, aborting it, and mints anew on the next call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const api = serveGithub();
    api.tokenReply(hanging);
    const github = client();

    const call = outcome(github, 11);
    await until(() => api.tokens().length === 1, "the token request");
    await vi.advanceTimersByTimeAsync(GITHUB_CALL_MS - 1);
    expect(call.settled()).toBe(false);
    expect(api.tokens()[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => call.settled(), "the call's end");
    expect(String(await call.promise)).toMatch(/took over 10000 ms/);
    expect(api.tokens()[0]?.signal?.aborted).toBe(true);
    expect(api.reads()).toEqual([]);

    // The aborted request no longer stands for the installation's token: the next call mints one.
    api.tokenReply(async () => failure(503)(undefined));
    const next = outcome(github, 11);
    await until(() => next.settled(), "the next call's end");
    expect(api.tokens()).toHaveLength(2);
    expect(githubStatus(await next.promise)).toBe(503);
  });
  it("ends a mint whose signing does not finish at the bound, and mints anew on the next call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const api = serveGithub();
    api.reply(pull(sha("A"), AT));
    const signing = vi.spyOn(crypto.subtle, "sign").mockReturnValue(new Promise(() => undefined));
    const github = client();

    const call = outcome(github, 15);
    await until(() => signing.mock.calls.length === 1, "the signing");
    await vi.advanceTimersByTimeAsync(GITHUB_CALL_MS - 1);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => call.settled(), "the call's end");
    expect(String(await call.promise)).toMatch(/the installation token took over 10000 ms/);
    expect(api.requests).toEqual([]);

    // The hung signing no longer stands for the installation's token, which auth-app shares among concurrent mints of
    // one installation: once signing works, the next call mints one.
    signing.mockRestore();
    const next = outcome(github, 15);
    // It needs no timer, unless it waits on the hung signing: then the bound ends it.
    for (let waited = 0; !next.settled() && waited < 1000; waited += 20) {
      await scheduler.wait(20);
    }
    await vi.advanceTimersByTimeAsync(GITHUB_CALL_MS);
    await until(() => next.settled(), "the next call's end");
    expect(await next.promise).toEqual({ headSha: sha("A"), updatedAt: AT });
    expect(api.tokens().map((request) => request.path)).toEqual(["/app/installations/15/access_tokens"]);
  });
});

describe("pull request reads", () => {
  it("ends a read that does not answer at the bound, aborting it, as a failure with status 500", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const api = serveGithub();
    api.reply(hanging);
    const github = client();

    const call = outcome(github, 12);
    await until(() => api.reads().length === 1, "the read");
    await vi.advanceTimersByTimeAsync(GITHUB_CALL_MS - 1);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => call.settled(), "the read's end");
    expect(api.reads()[0]?.signal?.aborted).toBe(true);
    expect(githubStatus(await call.promise)).toBe(500);
  });

  it("ends a read whose body does not finish at the bound, though the request ignores its abort", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const api = serveGithub();
    api.reply(async () => new Response(new ReadableStream({ start: () => undefined }), { status: 200 }));
    const github = client();

    const call = outcome(github, 13);
    await until(() => api.reads().length === 1, "the read");
    await vi.advanceTimersByTimeAsync(GITHUB_CALL_MS);
    await until(() => call.settled(), "the read's end");
    expect(githubStatus(await call.promise)).toBe(500);
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
