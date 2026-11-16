import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { SignJWT, UnsecuredJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { access, accessKeySet } from "./access.ts";
import app from "./index.ts";
import {
  accessToken,
  captureLogs,
  envFor,
  freshTeamDomain,
  hangingKeyFetch,
  keyFailures,
  newKey,
  request,
  runKey,
  serveKeys,
  type KeyServer,
  type SigningKey,
} from "./test/access.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

// A token for the team domain a test serves keys for.
function tokenFor(teamDomain: string, key: SigningKey, claims = {}, without: readonly string[] = []) {
  return accessToken(key, { iss: teamDomain, ...claims }, without);
}

const now = () => Math.floor(Date.now() / 1000);
const claimFailed = (claim: string) => ({ reason: "ERR_JWT_CLAIM_VALIDATION_FAILED", claim });

describe("rejects each bad token", () => {
  type Case = {
    // Makes the token; keys serves the run key, and a case may serve others.
    token: (teamDomain: string, key: SigningKey, keys: KeyServer) => Promise<string | undefined>;
    // What the rejection log names: jose's error code, and the claim for a claim check.
    rejected: { reason: string; claim?: string };
  };
  const cases: Record<string, Case> = {
    "no token": { token: async () => undefined, rejected: { reason: "missing" } },
    "a malformed token": { token: async () => "not-a-jwt", rejected: { reason: "ERR_JWS_INVALID" } },
    "a token signed by another key": {
      token: async (teamDomain, key) => tokenFor(teamDomain, await newKey(key.kid)),
      rejected: { reason: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" },
    },
    "an HS256 token keyed with the public key": {
      token: async (teamDomain, key) =>
        new SignJWT({ iss: teamDomain, aud: env.ACCESS_AUD, exp: now() + 300 })
          .setProtectedHeader({ alg: "HS256", kid: key.kid })
          .sign(new TextEncoder().encode(JSON.stringify(key.publicJwk))),
      rejected: { reason: "ERR_JOSE_ALG_NOT_ALLOWED" },
    },
    "an RS384 token signed by a served RS384 key": {
      token: async (teamDomain, key, keys) => {
        const rs384 = await newKey("rs384-key", "RS384");
        keys.serve(key, rs384);
        return tokenFor(teamDomain, rs384);
      },
      rejected: { reason: "ERR_JOSE_ALG_NOT_ALLOWED" },
    },
    "an unsigned token (alg none)": {
      token: async (teamDomain) =>
        new UnsecuredJWT({ iss: teamDomain, aud: env.ACCESS_AUD, exp: now() + 300 }).encode(),
      rejected: { reason: "ERR_JOSE_ALG_NOT_ALLOWED" },
    },
    "a token without exp": {
      token: async (teamDomain, key) => tokenFor(teamDomain, key, {}, ["exp"]),
      rejected: claimFailed("exp"),
    },
    "an expired token": {
      token: async (teamDomain, key) => tokenFor(teamDomain, key, { exp: now() - 60 }),
      rejected: { reason: "ERR_JWT_EXPIRED", claim: "exp" },
    },
    "a token not yet valid": {
      token: async (teamDomain, key) => tokenFor(teamDomain, key, { nbf: now() + 3600 }),
      rejected: claimFailed("nbf"),
    },
    "a token for another audience": {
      token: async (teamDomain, key) => tokenFor(teamDomain, key, { aud: "another-app" }),
      rejected: claimFailed("aud"),
    },
    "a token from another issuer": {
      token: async (_, key) => tokenFor("https://other.prq.example", key),
      rejected: claimFailed("iss"),
    },
    "a token naming an unknown key ID": {
      token: async (teamDomain) => tokenFor(teamDomain, await newKey("unknown-key")),
      rejected: { reason: "ERR_JWKS_NO_MATCHING_KEY" },
    },
  };

  it.for(Object.entries(cases))("%s", async ([, { token: make, rejected }]) => {
    const teamDomain = freshTeamDomain();
    const key = await runKey();
    const keys = serveKeys(teamDomain, key);
    const logs = captureLogs();
    const token = await make(teamDomain, key, keys);

    const res = await app.fetch(request("/cli/claim", token, { method: "POST" }), envFor(teamDomain));

    // 401, not the 404 that any request past the check gets in this Worker: no route ran.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", detail: expect.any(String) });
    expect(logs).toContainEqual({
      level: "warn",
      entry: { event: "prq.access.rejected", path: "/cli/claim", ...rejected },
    });
    const tokenLogged = token !== undefined && JSON.stringify(logs).includes(token);
    expect(tokenLogged).toBe(false);
  });
});

it("passes a valid token", async () => {
  const teamDomain = freshTeamDomain();
  const key = await runKey();
  serveKeys(teamDomain, key);

  const res = await app.fetch(request("/cli/claim", await tokenFor(teamDomain, key)), envFor(teamDomain));

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});

describe("key set reuse and refresh", () => {
  it("fetches the keys once for sequential requests, and not for an unknown key ID in the cooldown", async () => {
    const teamDomain = freshTeamDomain();
    const key = await runKey();
    const keys = serveKeys(teamDomain, key);

    for (let i = 0; i < 3; i += 1) {
      const res = await app.fetch(request("/api/x", await tokenFor(teamDomain, key)), envFor(teamDomain));
      expect(res.status).toBe(404);
    }
    expect(keys.fetches()).toBe(1);

    const rotated = await newKey("rotated-key");
    keys.serve(key, rotated);
    const res = await app.fetch(request("/api/x", await tokenFor(teamDomain, rotated)), envFor(teamDomain));
    expect(res.status).toBe(401);
    expect(keys.fetches()).toBe(1);
  });

  it("refetches for an unknown key ID after the cooldown and accepts the new key", async () => {
    const teamDomain = freshTeamDomain();
    const key = await runKey();
    const rotated = await newKey("rotated-key");
    const keys = serveKeys(teamDomain, key);
    const keySet = accessKeySet(teamDomain, { cooldownDuration: 100 });
    const probe = new Hono<{ Bindings: Env }>().use(access(() => keySet)).all("*", (c) => c.text("ran"));
    const send = async (signer: SigningKey) =>
      probe.fetch(request("/api/x", await tokenFor(teamDomain, signer)), envFor(teamDomain));

    expect((await send(key)).status).toBe(200);
    keys.serve(key, rotated);
    expect((await send(rotated)).status).toBe(401);
    expect(keys.fetches()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await send(rotated)).status).toBe(200);
    expect(keys.fetches()).toBe(2);
  });
});

describe("key fetch failure", () => {
  it.for(Object.entries(keyFailures))("answers 503 for %s, then fetches again", async ([, failure]) => {
    const teamDomain = freshTeamDomain();
    const key = await runKey();
    const keys = serveKeys(teamDomain, key);
    keys.fail(failure);
    const logs = captureLogs();
    const token = await tokenFor(teamDomain, key);

    const failed = await app.fetch(request("/cli/wait", token), envFor(teamDomain));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "unavailable", detail: expect.any(String) });
    expect(logs).toContainEqual({
      level: "error",
      entry: expect.objectContaining({ event: "prq.access.keys_unavailable" }),
    });

    keys.serve(key);
    const passed = await app.fetch(request("/cli/wait", token), envFor(teamDomain));
    expect(passed.status).toBe(404);
    expect(keys.fetches()).toBe(2);
  });

  it("answers 503 when the fetch times out, then fetches again", async () => {
    const teamDomain = freshTeamDomain();
    const key = await runKey();
    const keys = serveKeys(teamDomain, key);
    keys.fail(hangingKeyFetch);
    const keySet = accessKeySet(teamDomain, { timeoutDuration: 50 });
    const probe = new Hono<{ Bindings: Env }>().use(access(() => keySet)).all("*", (c) => c.text("ran"));
    const token = await tokenFor(teamDomain, key);
    captureLogs();

    const failed = await probe.fetch(request("/cli/wait", token), envFor(teamDomain));
    expect(failed.status).toBe(503);

    keys.serve(key);
    const passed = await probe.fetch(request("/cli/wait", token), envFor(teamDomain));
    expect(passed.status).toBe(200);
    expect(keys.fetches()).toBe(2);
  });
});
