// e2e: Node-side suites against a real `wrangler dev` (one per file, fresh storage) and the real prq CLI.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "e2e",
    include: ["test/e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 90_000,
    // Each file starts its own wrangler dev; keep the machine load predictable.
    maxWorkers: 2,
  },
});
