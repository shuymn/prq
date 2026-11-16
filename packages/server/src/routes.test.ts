import { exports } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";

import app from "./index.ts";
import { captureLogs, request } from "./test/access.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

// The one request that bypasses Access (docs/design.md, Authentication boundary).
const isWebhook = (method: string, path: string) => method === "POST" && path === "/webhook";

// Each route the app registers, middleware included, with its parameters filled in, under every method: a handler can
// answer some methods only. A route a later change mounts outside the Access check answers without a token and fails
// this test.
it("every route needs Access", async () => {
  captureLogs();
  expect(app.routes.length).toBeGreaterThan(0);

  for (const route of app.routes) {
    const path = route.path.replace(/:[^/]+/g, "1").replace(/\*/g, "1");
    for (const method of METHODS.filter((candidate) => !isWebhook(candidate, path))) {
      const res = await exports.default.fetch(request(path, undefined, { method }));
      expect({ route: `${method} ${path}`, status: res.status }).toEqual({ route: `${method} ${path}`, status: 401 });
    }
  }
});
