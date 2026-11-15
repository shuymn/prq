// Access JWT check. The prototype signs test JWTs with HS256 and a shared secret; production verifies Access's RS256
// JWTs with createRemoteJWKSet(<team>/cdn-cgi/access/certs) and the same issuer, audience and expiry checks.
import type { MiddlewareHandler } from "hono";
import { jwtVerify } from "jose";

export type AccessKind = "user" | "service";

export function access(required: AccessKind | "any"): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) return c.json({ error: "unauthorized", detail: "missing assertion" }, 401);
    let payload;
    try {
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(c.env.ACCESS_TEST_SECRET), {
        algorithms: ["HS256"],
        audience: c.env.ACCESS_AUD,
        issuer: c.env.ACCESS_ISS,
      }));
    } catch (e) {
      return c.json({ error: "unauthorized", detail: (e as Error).message }, 401);
    }
    // Access puts common_name (the client ID) in service-token JWTs and email in user JWTs.
    const kind: AccessKind = typeof payload["common_name"] === "string" ? "service" : "user";
    if (required !== "any" && kind !== required) {
      return c.json({ error: "unauthorized", detail: `requires a ${required} token` }, 403);
    }
    await next();
  };
}
