import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The end-to-end files start the Worker (seconds, bundling it) and run the CLI against it with real waits.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
