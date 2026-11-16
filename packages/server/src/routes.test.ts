import { exports } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";

import app from "./index.ts";
import { captureLogs, request } from "./test/access.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

// Each route the app registers, middleware included, with its parameters filled in. A route a later change mounts
// outside the Access check answers it without a token and fails this test.
it("every route needs Access", async () => {
  captureLogs();
  const routes = app.routes.filter((route) => !/^\/webhook(?:\/|$)/.test(route.path));
  expect(routes.length).toBeGreaterThan(0);

  for (const route of routes) {
    const path = route.path.replace(/:[^/]+/g, "1").replace(/\*/g, "1");
    const method = route.method === "ALL" ? "GET" : route.method;
    const res = await exports.default.fetch(request(path, undefined, { method }));
    expect({ route: `${method} ${route.path}`, status: res.status }).toEqual({
      route: `${method} ${route.path}`,
      status: 401,
    });
  }
});
