import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readGithubAppConfig, readModelConfig } from "./config.ts";
import app from "./index.ts";
import { accessToken, captureLogs, envFor, freshTeamDomain, request, runKey, serveKeys } from "./test/access.ts";
import { appEnv } from "./test/github.ts";
import { MODEL_ENV, TEST_KEY } from "./test/provider.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function envWith(overrides: Record<string, unknown>, without: readonly string[] = []): object {
  const result: Record<string, unknown> = { ...env, ...overrides };
  for (const name of without) {
    delete result[name];
  }
  return result;
}

describe("fails closed", () => {
  it("refuses a request without ACCESS_AUD, even for a token without aud", async () => {
    const key = await runKey();
    const keys = serveKeys(env.ACCESS_TEAM_DOMAIN, key);
    const logs = captureLogs();

    const res = await app.fetch(
      request("/cli/claim", await accessToken(key, {}, ["aud"])),
      envWith({}, ["ACCESS_AUD"]),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal", detail: expect.any(String) });
    expect(logs).toContainEqual({
      level: "error",
      entry: { event: "prq.config.invalid", issues: ["ACCESS_AUD is missing"] },
    });
    expect(keys.fetches()).toBe(0);
  });

  const invalid: Record<string, [Record<string, unknown>, string[], string]> = {
    "an empty ACCESS_AUD": [{ ACCESS_AUD: "" }, [], "ACCESS_AUD is empty"],
    "no ACCESS_TEAM_DOMAIN": [{}, ["ACCESS_TEAM_DOMAIN"], "ACCESS_TEAM_DOMAIN is missing"],
    "an empty ACCESS_TEAM_DOMAIN": [{ ACCESS_TEAM_DOMAIN: "" }, [], "ACCESS_TEAM_DOMAIN is not an https origin"],
    "an http ACCESS_TEAM_DOMAIN": [
      { ACCESS_TEAM_DOMAIN: "http://secret-team.prq.example" },
      [],
      "ACCESS_TEAM_DOMAIN is not an https origin",
    ],
    "an ACCESS_TEAM_DOMAIN with a path": [
      { ACCESS_TEAM_DOMAIN: "https://secret-team.prq.example/" },
      [],
      "ACCESS_TEAM_DOMAIN is not an https origin",
    ],
  };

  it.for(Object.entries(invalid))("refuses a request with %s, naming it without its value", async ([, args]) => {
    const [overrides, without, issue] = args;
    const key = await runKey();
    serveKeys(env.ACCESS_TEAM_DOMAIN, key);
    const logs = captureLogs();

    const res = await app.fetch(request("/api/x", await accessToken(key)), envWith(overrides, without));

    expect(res.status).toBe(500);
    const [entry] = logs.filter((log) => log.entry["event"] === "prq.config.invalid");
    expect(entry?.level).toBe("error");
    expect(entry?.entry["issues"]).toEqual([expect.stringContaining(issue)]);
    expect(JSON.stringify(entry)).not.toContain("secret-team");
  });

  it("refuses a request without a token with 500, not 401", async () => {
    captureLogs();
    const res = await app.fetch(request("/api/x"), envWith({}, ["ACCESS_AUD"]));
    expect(res.status).toBe(500);
  });

  it("accepts a valid configuration", async () => {
    const teamDomain = freshTeamDomain();
    const key = await runKey();
    serveKeys(teamDomain, key);

    const res = await app.fetch(request("/api/x", await accessToken(key, { iss: teamDomain })), envFor(teamDomain));

    expect(res.status).toBe(404);
  });
});

describe("the model group", () => {
  it("is not configured while none of its variables is set, or each is empty", () => {
    // The tests' runtime sets each one empty (vitest.config.ts), so a .dev.vars holding a provider's key for a manual
    // check gives no test a model.
    expect([env.MODEL_BASE_URL, env.MODEL_API_KEY, env.MODEL_ID, env.MODEL_CONTEXT_TOKENS]).toEqual(["", "", "", ""]);
    expect(readModelConfig(env)).toBeNull();
    expect(
      readModelConfig({ MODEL_BASE_URL: "", MODEL_API_KEY: "", MODEL_ID: "", MODEL_CONTEXT_TOKENS: "" }),
    ).toBeNull();
  });

  it("accepts all four, the window as a number, from the floor up", () => {
    expect(readModelConfig({ ...MODEL_ENV })).toEqual({
      ok: true,
      config: { ...MODEL_ENV, MODEL_CONTEXT_TOKENS: 131_072 },
    });
    expect(readModelConfig({ ...MODEL_ENV, MODEL_CONTEXT_TOKENS: "16384" })).toMatchObject({
      ok: true,
      config: { MODEL_CONTEXT_TOKENS: 16_384 },
    });
  });

  const invalid: Record<string, [Record<string, unknown>, string[]]> = {
    "a window below the floor": [
      { ...MODEL_ENV, MODEL_CONTEXT_TOKENS: "16383" },
      ["MODEL_CONTEXT_TOKENS is below 16,384"],
    ],
    "a window that is not a whole number": [
      { ...MODEL_ENV, MODEL_CONTEXT_TOKENS: "131072.5" },
      ["MODEL_CONTEXT_TOKENS is not a whole number of tokens"],
    ],
    "a missing model": [
      { MODEL_BASE_URL: MODEL_ENV.MODEL_BASE_URL, MODEL_API_KEY: TEST_KEY, MODEL_CONTEXT_TOKENS: "131072" },
      ["MODEL_ID is missing"],
    ],
    "an empty key": [{ ...MODEL_ENV, MODEL_API_KEY: "" }, ["MODEL_API_KEY is empty"]],
    "an http base URL": [
      { ...MODEL_ENV, MODEL_BASE_URL: "http://provider.example/v1" },
      ["MODEL_BASE_URL is not an https URL"],
    ],
    "only the key": [
      { MODEL_API_KEY: TEST_KEY },
      ["MODEL_BASE_URL is missing", "MODEL_ID is missing", "MODEL_CONTEXT_TOKENS is missing"],
    ],
    // Empty reads as unset only when all four are empty, as the test runtime leaves them.
    "an empty key alone": [
      { MODEL_API_KEY: "" },
      ["MODEL_BASE_URL is missing", "MODEL_API_KEY is empty", "MODEL_ID is missing", "MODEL_CONTEXT_TOKENS is missing"],
    ],
    "two empty, two unset": [
      { MODEL_BASE_URL: "", MODEL_ID: "" },
      [
        "MODEL_BASE_URL is not an https URL",
        "MODEL_API_KEY is missing",
        "MODEL_ID is empty",
        "MODEL_CONTEXT_TOKENS is missing",
      ],
    ],
  };

  it.for(Object.entries(invalid))("refuses %s, naming the variables without their values", ([, [vars, issues]]) => {
    const result = readModelConfig(vars);
    expect(result).toEqual({ ok: false, issues });
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });
});

describe("the GitHub App group", () => {
  it("is not configured while neither variable is set, or both are empty", () => {
    // The tests' runtime sets both empty (vitest.config.ts), so a .dev.vars holding a real App gives no test GitHub.
    expect([env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY]).toEqual(["", ""]);
    expect(readGithubAppConfig(env)).toBeNull();
    expect(readGithubAppConfig({})).toBeNull();
  });

  it("accepts a numeric App ID and a PKCS#8 key", () => {
    const vars = appEnv();
    expect(readGithubAppConfig(vars)).toEqual({
      ok: true,
      config: { GITHUB_APP_ID: 4242, GITHUB_APP_PRIVATE_KEY: vars.GITHUB_APP_PRIVATE_KEY },
    });
  });

  const PKCS1 = "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n";
  const invalid: Record<string, [Record<string, unknown>, string[]]> = {
    "a PKCS#1 key, as GitHub issues it": [
      { GITHUB_APP_ID: "4242", GITHUB_APP_PRIVATE_KEY: PKCS1 },
      ["GITHUB_APP_PRIVATE_KEY is not a PKCS#8 private key (convert GitHub's key with openssl pkcs8 -topk8)"],
    ],
    "an App ID that is not a number": [
      { ...appEnv(), GITHUB_APP_ID: "prq" },
      ["GITHUB_APP_ID is not a numeric GitHub App ID"],
    ],
    "the key alone": [{ GITHUB_APP_PRIVATE_KEY: appEnv().GITHUB_APP_PRIVATE_KEY }, ["GITHUB_APP_ID is missing"]],
    "an empty ID beside a key": [
      { GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY: appEnv().GITHUB_APP_PRIVATE_KEY },
      ["GITHUB_APP_ID is not a numeric GitHub App ID"],
    ],
  };

  it.for(Object.entries(invalid))("refuses %s, naming the variables without their values", ([, [vars, issues]]) => {
    const result = readGithubAppConfig(vars);
    expect(result).toEqual({ ok: false, issues });
    expect(JSON.stringify(result)).not.toContain("MIIE");
  });
});
