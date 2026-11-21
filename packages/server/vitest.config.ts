import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // The Access signing key for this run; tests serve its public half as the team's key set (src/test/access.ts).
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  // The GitHub App's key for tests that give a session the App (src/test/github.ts), PKCS#8 as the secret is stored.
  const appKey = await generateKeyPair("RS256", { extractable: true });
  return {
    test: {
      // A failed client test's screenshot, beside the browser check's (packages/cli/test-output/ui).
      attachmentsDir: "test-output/client",
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  // .example never resolves, so a key fetch the tests do not serve cannot reach the network.
                  ACCESS_TEAM_DOMAIN: "https://team.prq.example",
                  ACCESS_AUD: "prq-test-audience",
                  TEST_ACCESS_JWK: JSON.stringify(await exportJWK(privateKey)),
                  // The secret of GitHub's documented signature example, which src/webhook.test.ts checks against.
                  WEBHOOK_SECRET: "It's a Secret to Everybody",
                  HOST_GITHUB_ID: "1001",
                  // No model, whatever .dev.vars holds (wrangler loads it, and it may hold a provider's key for a manual
                  // check): empty reads as not configured, so no test reaches a provider. Tests that need a model give
                  // the session one.
                  MODEL_BASE_URL: "",
                  MODEL_API_KEY: "",
                  MODEL_ID: "",
                  MODEL_CONTEXT_TOKENS: "",
                  MODEL_REASONING_EFFORT: "",
                  // No GitHub App either, so no test reaches GitHub; tests that need the App give the session one.
                  GITHUB_APP_ID: "",
                  GITHUB_APP_PRIVATE_KEY: "",
                  TEST_GITHUB_APP_KEY: await exportPKCS8(appKey.privateKey),
                },
              },
            }),
          ],
          test: {
            name: "workerd",
            include: ["src/**/*.test.ts"],
            // The web UI runs in the browser, not in the Worker.
            exclude: ["src/**/*.node.test.ts", "src/client/**"],
            setupFiles: ["src/test/setup.ts"],
            // The Worker serves the web UI's build: the run stops first, saying how to build it, when it is missing.
            globalSetup: ["../cli/src/test/client-build.ts"],
          },
        },
        {
          // The cloud workspace's git procedure with the machine's git, against file:// repositories in the OS temp
          // directory, through the CLI's git fixture; the CLI's canary fails the run if the repository changed. The web
          // UI's build: its tokens, its output, the style check and the favicon. And the scripts' own tests: the
          // secrets command against a stand-in for wrangler.
          test: {
            name: "node",
            include: ["src/**/*.node.test.ts", "build/**/*.node.test.ts", "scripts/**/*.node.test.ts"],
            environment: "node",
            globalSetup: ["../cli/src/test/canary.ts"],
            // Real git processes: room for a slow CI runner, as the CLI's git tests have.
            testTimeout: 30_000,
            hookTimeout: 30_000,
          },
        },
        {
          // The web UI in the machine's Chrome (Vitest's browser mode through playwright; no browser is downloaded):
          // its components with the design tokens, its reads against a fetch the test controls, and the gallery. The
          // UI's build configuration gives it its root (src/client), plugins and defines.
          extends: "./vite.config.ts",
          // Optimized before the first test file loads: found during a run, Vite reloads the page under the tests.
          optimizeDeps: { include: ["@cloudflare/ai-chat/react", "agents/react"] },
          test: {
            name: "client",
            include: ["src/client/**/*.test.{ts,tsx}"],
            setupFiles: ["src/client/test/setup.ts"],
            browser: {
              enabled: true,
              headless: true,
              provider: playwright({ launchOptions: { channel: "chrome" } }),
              instances: [{ browser: "chromium" as const }],
              // A desktop window, where the list is a table (the panel's layout starts below design/tokens.json's
              // narrow breakpoint).
              viewport: { width: 1280, height: 800 },
            },
          },
        },
      ],
    },
  };
});
