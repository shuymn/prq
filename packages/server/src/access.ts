import type { MiddlewareHandler } from "hono";
import {
  createRemoteJWKSet,
  customFetch,
  errors,
  type FetchImplementation,
  type JWTVerifyGetKey,
  jwtVerify,
  type RemoteJWKSetOptions,
} from "jose";
import * as v from "valibot";

import { readAccessConfig } from "./config.ts";
import { errorResponse } from "./http.ts";
import { log } from "./log.ts";

// The keys could not be obtained: the server cannot tell whether the token is good, so the caller must not read the
// answer as an authentication failure.
class KeysUnavailable extends Error {
  override readonly name = "KeysUnavailable";
}

function failureName(error: unknown): string {
  if (error instanceof errors.JOSEError) {
    return error.code;
  }
  return error instanceof Error ? error.name : typeof error;
}

// The fields jose matches a token's header against. jose skips an entry whose field has the wrong type, so a token
// signed with that key would read as naming an unknown key; a set with such an entry is refused as a whole instead.
const KeySetShape = v.object({
  keys: v.array(
    v.looseObject({
      kty: v.string(),
      kid: v.string(),
      alg: v.optional(v.string()),
      use: v.optional(v.string()),
      key_ops: v.optional(v.array(v.string())),
      ext: v.optional(v.boolean()),
    }),
  ),
});

const fetchKeySet: FetchImplementation = async (url, options) => {
  const response = await fetch(url, options);
  if (response.status !== 200) {
    return response;
  }
  const body: unknown = await response.json();
  if (!v.is(KeySetShape, body)) {
    throw new errors.JWKSInvalid("the key set has a malformed key");
  }
  return Response.json(body);
};

// Access's signing keys for a team, through jose's remote key set: cached for 10 minutes, refetched for an unknown key
// ID at most every 30 seconds, each fetch bounded by 5 seconds (tests pass shorter durations). A token naming a key the
// set does not hold is the token's fault. Any other failure to produce a key (network, timeout, a status other than
// 200, a malformed set, a key that cannot be imported) is the key set's: it is dropped, so the next request fetches
// again instead of reusing a set that cannot verify.
export function accessKeySet(teamDomain: string, options: RemoteJWKSetOptions = {}): JWTVerifyGetKey {
  const url = new URL("/cdn-cgi/access/certs", teamDomain);
  const load = () => createRemoteJWKSet(url, { ...options, [customFetch]: fetchKeySet });
  let remote = load();
  return async (protectedHeader, token) => {
    const used = remote;
    try {
      return await used(protectedHeader, token);
    } catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) {
        throw error;
      }
      // A concurrent request may already have replaced the set it failed with; keep that replacement.
      if (remote === used) {
        remote = load();
      }
      throw new KeysUnavailable(failureName(error), { cause: error });
    }
  };
}

// One key set per team domain per isolate, so its cache outlives the request.
const keySets = new Map<string, JWTVerifyGetKey>();

function isolateKeySet(teamDomain: string): JWTVerifyGetKey {
  let keySet = keySets.get(teamDomain);
  if (keySet === undefined) {
    keySet = accessKeySet(teamDomain);
    keySets.set(teamDomain, keySet);
  }
  return keySet;
}

// Every path but /webhook sits behind Cloudflare Access; this check refuses a request that reached the Worker without
// passing it (through a workers.dev address, for example). The caller is then the host, by browser or service token
// (docs/design.md, Authentication boundary).
export function access(
  keySetFor: (teamDomain: string) => JWTVerifyGetKey = isolateKeySet,
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const config = readAccessConfig(c.env);
    if (!config.ok) {
      log("prq.config.invalid", { issues: config.issues }, "error");
      return errorResponse(c, "internal", "the server is not configured");
    }
    const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience } = config.config;
    const token = c.req.header("Cf-Access-Jwt-Assertion");
    if (token === undefined) {
      log("prq.access.rejected", { path: c.req.path, reason: "missing" }, "warn");
      return errorResponse(c, "unauthorized", "missing Access token");
    }
    try {
      await jwtVerify(token, keySetFor(teamDomain), {
        algorithms: ["RS256"],
        issuer: teamDomain,
        audience,
        // jose checks exp only when the token has one.
        requiredClaims: ["exp"],
      });
    } catch (error) {
      if (error instanceof KeysUnavailable) {
        log("prq.access.keys_unavailable", { path: c.req.path, reason: error.message }, "error");
        return errorResponse(c, "unavailable", "Access keys are unavailable");
      }
      if (error instanceof errors.JOSEError) {
        const claim =
          error instanceof errors.JWTClaimValidationFailed || error instanceof errors.JWTExpired
            ? error.claim
            : undefined;
        log("prq.access.rejected", { path: c.req.path, reason: error.code, ...(claim && { claim }) }, "warn");
        return errorResponse(c, "unauthorized", "invalid Access token");
      }
      throw error;
    }
    return next();
  };
}
