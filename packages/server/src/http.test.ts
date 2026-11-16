import { ErrorResponse, PRQ_VERSION_HEADER } from "@prq/protocol";
import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import packageJson from "../package.json";
import { noStore, notFound, onError, prqVersion } from "./http.ts";
import app from "./index.ts";
import {
  accessToken,
  captureLogs,
  envFor,
  freshTeamDomain,
  keyFailures,
  request,
  runKey,
  serveKeys,
} from "./test/access.ts";
import { SERVER_VERSION } from "./version.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

// /agents/hub/other: a name the Agents route refuses.
const PATHS = ["/cli/wait", "/api/pr/octo/demo/1", "/agents/hub/other", "/webhook", "/unknown"];

// A WebSocket upgrade as a route returns it.
function upgradeResponse(): Response {
  const [client, server] = Object.values(new WebSocketPair());
  server?.accept();
  return new Response(null, { status: 101, webSocket: client ?? null });
}

// Both headers where they apply: no-store everywhere, the version on /cli/* only.
function expectHeaders(res: Response, path: string): void {
  expect({
    path,
    cacheControl: res.headers.get("Cache-Control"),
    version: res.headers.get(PRQ_VERSION_HEADER),
  }).toEqual({
    path,
    cacheControl: "no-store",
    version: path.startsWith("/cli/") ? SERVER_VERSION : null,
  });
}

describe("headers on every response", () => {
  it.for(PATHS)("401 at %s", async (path) => {
    captureLogs();
    const res = await exports.default.fetch(request(path));
    expect(res.status).toBe(401);
    expect(v.parse(ErrorResponse, await res.json()).error).toBe("unauthorized");
    expectHeaders(res, path);
  });

  it.for(PATHS)("404 at %s", async (path) => {
    const key = await runKey();
    serveKeys(env.ACCESS_TEAM_DOMAIN, key);
    const res = await exports.default.fetch(request(path, await accessToken(key)));
    expect(res.status).toBe(404);
    expect(v.parse(ErrorResponse, await res.json()).error).toBe("not_found");
    expectHeaders(res, path);
  });

  it.for(PATHS)("503 at %s", async (path) => {
    const teamDomain = freshTeamDomain();
    const key = await runKey();
    serveKeys(teamDomain, key).fail(keyFailures["a 500"]!);
    captureLogs();
    const res = await app.fetch(request(path, await accessToken(key, { iss: teamDomain })), envFor(teamDomain));
    expect(res.status).toBe(503);
    expect(v.parse(ErrorResponse, await res.json()).error).toBe("unavailable");
    expectHeaders(res, path);
  });

  it.for(PATHS)("500 at %s", async (path) => {
    captureLogs();
    const res = await app.fetch(request(path), { ...env, ACCESS_AUD: "" });
    expect(res.status).toBe(500);
    expect(v.parse(ErrorResponse, await res.json()).error).toBe("internal");
    expectHeaders(res, path);
  });

  // Beside the Agents endpoints (below), no route answers yet, so these run the same middleware and handlers on a
  // probe app.
  describe("responses from routes", () => {
    const probe = new Hono();
    probe.use(noStore);
    probe.use("/cli/*", prqVersion);
    probe.get("/cli/ok", (c) => c.json({ ok: true }));
    probe.get("/api/ok", (c) => c.json({ ok: true }));
    // Response.redirect has immutable headers, as responses from fetch and Durable Object stubs do.
    probe.get("/api/immutable", () => Response.redirect("https://prq.example/elsewhere", 302));
    probe.get("/cli/throws", () => {
      throw new Error("ACCESS_AUD is secret-audience-value");
    });
    probe.get("/agents/socket", upgradeResponse);
    probe.get("/cli/socket", upgradeResponse);
    probe.notFound(notFound);
    probe.onError(onError);

    it.for(["/cli/ok", "/api/ok"])("200 at %s", async (path) => {
      const res = await probe.fetch(request(path));
      expect(res.status).toBe(200);
      expectHeaders(res, path);
    });

    it("copies a response whose headers are immutable", async () => {
      expect(() => Response.redirect("https://prq.example/", 302).headers.set("X", "1")).toThrow(TypeError);
      const res = await probe.fetch(request("/api/immutable"));
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://prq.example/elsewhere");
      expectHeaders(res, "/api/immutable");
    });

    it("answers a thrown error with 500 and logs its name, not its message", async () => {
      const logs = captureLogs();
      const res = await probe.fetch(request("/cli/throws"));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal" });
      expectHeaders(res, "/cli/throws");
      expect(logs).toEqual([
        {
          level: "error",
          entry: { event: "prq.request.failed", method: "GET", path: "/cli/throws", error: "Error" },
        },
      ]);
      expect(JSON.stringify(logs)).not.toContain("secret-audience-value");
    });

    // An upgrade passes as it is: copying it would drop its socket. /cli/* never upgrades (only /agents/* does), so
    // the version is never left off a /cli/* response.
    it.for(["/agents/socket", "/cli/socket"])("passes a WebSocket upgrade at %s through untouched", async (path) => {
      const res = await probe.fetch(request(path));
      expect(res.status).toBe(101);
      expect(res.webSocket).not.toBeNull();
      expect({ cacheControl: res.headers.get("Cache-Control"), version: res.headers.get(PRQ_VERSION_HEADER) }).toEqual({
        cacheControl: null,
        version: null,
      });
      res.webSocket?.accept();
      res.webSocket?.close();
    });
  });
});

describe("agents endpoints", () => {
  // The stub's response has immutable headers, so no-store arrives only through the copy.
  it("serves a session's stored history behind Access, with no-store", async () => {
    captureLogs();
    const path = "/agents/pr-session/octo~http~1/get-messages";
    const denied = await exports.default.fetch(request(path));
    expect(denied.status).toBe(401);
    expectHeaders(denied, path);

    const key = await runKey();
    serveKeys(env.ACCESS_TEAM_DOMAIN, key);
    const res = await exports.default.fetch(request(path, await accessToken(key)));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual([]);
    expectHeaders(res, path);
  });
});

it("version source", () => {
  expect(SERVER_VERSION).toBe(`v${packageJson.version}`);
});
