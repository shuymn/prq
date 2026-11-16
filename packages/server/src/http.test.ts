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

const PATHS = ["/cli/wait", "/api/pr/octo/demo/1", "/agents/hub/hub", "/webhook", "/unknown"];

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

  // No route answers 200 yet, so these run the same middleware and handlers on a probe app.
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
    probe.get("/agents/socket", () => {
      const [client, server] = Object.values(new WebSocketPair());
      server?.accept();
      return new Response(null, { status: 101, webSocket: client ?? null });
    });
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

    it("passes a WebSocket upgrade through with its socket", async () => {
      const res = await probe.fetch(request("/agents/socket"));
      expect(res.status).toBe(101);
      expect(res.webSocket).not.toBeNull();
      expect(res.headers.get("Cache-Control")).toBeNull();
      res.webSocket?.accept();
      res.webSocket?.close();
    });
  });
});

it("version source", () => {
  expect(SERVER_VERSION).toBe(`v${packageJson.version}`);
});
