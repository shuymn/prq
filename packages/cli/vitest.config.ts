import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // A canary that fails the run if a test changed the repository the tests run in; then the prq binary, compiled
    // once per run for the end-to-end tests to run.
    globalSetup: ["src/test/canary.ts", "src/test/build.ts"],
    // The end-to-end files start the Worker (seconds, bundling it) and run the CLI against it with real waits.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
