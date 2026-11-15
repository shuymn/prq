// The Sandbox suite: needs Docker and github.com, so it is not part of `pnpm test`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "sandbox", include: ["test/e2e/sandbox.e2e.test.ts"], hookTimeout: 300_000 },
});
