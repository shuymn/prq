import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import app from "./index.ts";
import { accessToken, captureLogs, envFor, freshTeamDomain, request, runKey, serveKeys } from "./test/access.ts";

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
