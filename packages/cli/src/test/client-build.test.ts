import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { requireClientBuild } from "./client-build.ts";
import { startWorker } from "./worker.ts";

// A built page that does not exist, in the OS temp directory.
const missing = () => join(tmpdir(), `prq-no-build-${randomBytes(6).toString("hex")}`, "index.html");

test("startWorker stops without the web UI's build, saying how to build it, before it starts anything", async () => {
  const fetchBefore = globalThis.fetch;
  await expect(startWorker({ clientIndex: missing() })).rejects.toThrow(
    "run `pnpm --filter @prq/server run build` first",
  );
  expect(globalThis.fetch).toBe(fetchBefore);
});

// The server's workerd project runs this same check as its global setup (packages/server/build/projects.node.test.ts).
test("the check passes once the page is built", () => {
  expect(() => requireClientBuild()).not.toThrow();
});
