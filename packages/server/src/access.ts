import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify, type RemoteJWKSetOptions } from "jose";

import { readConfig } from "./config.ts";
import { errorResponse } from "./http.ts";
import { log } from "./log.ts";

type AccessKeySet = ReturnType<typeof createRemoteJWKSet>;

// Access's signing keys for a team. jose caches them for 10 minutes and refetches for an unknown key ID at most every
// 30 seconds; a fetch times out after 5 seconds. Tests pass shorter durations.
export function accessKeySet(teamDomain: string, options?: RemoteJWKSetOptions): AccessKeySet {
  return createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain), options);
}

// One key set per team domain per isolate, so its cache outlives the request.
const keySets = new Map<string, AccessKeySet>();

function isolateKeySet(teamDomain: string): AccessKeySet {
  let keySet = keySets.get(teamDomain);
  if (keySet === undefined) {
    keySet = accessKeySet(teamDomain);
    keySets.set(teamDomain, keySet);
  }
  return keySet;
}

// The keys could not be obtained: the server cannot tell whether the token is good, so the caller must not read the
// answer as an authentication failure.
class KeysUnavailable extends Error {
  override readonly name = "KeysUnavailable";
}

// A token naming a key the set does not hold is the token's fault; any other failure to produce a key is the fetch's
// (network, timeout, a status other than 200, a malformed key set).
function keysOrUnavailable(keySet: AccessKeySet): JWTVerifyGetKey {
  return async (protectedHeader, token) => {
    try {
      return await keySet(protectedHeader, token);
    } catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) {
        throw error;
      }
      throw new KeysUnavailable(failureName(error), { cause: error });
    }
  };
}

function failureName(error: unknown): string {
  if (error instanceof errors.JOSEError) {
    return error.code;
  }
  return error instanceof Error ? error.name : typeof error;
}

// Every path but /webhook sits behind Cloudflare Access; this check refuses a request that reached the Worker without
// passing it (through a workers.dev address, for example). The caller is then the host, by browser or service token
// (docs/design.md, Authentication boundary).
export function access(
  keySetFor: (teamDomain: string) => AccessKeySet = isolateKeySet,
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const config = readConfig(c.env);
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
      await jwtVerify(token, keysOrUnavailable(keySetFor(teamDomain)), {
        algorithms: ["RS256"],
        issuer: teamDomain,
        audience,
        // jose checks exp only when the token has one.
        requiredClaims: ["exp"],
      });
    } catch (error) {
      if (error instanceof KeysUnavailable) {
        log("prq.access.keys_unavailable", { path: c.req.path, reason: error.message }, "error");
        return errorResponse(c, "unavailable", "Access keys could not be fetched");
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
