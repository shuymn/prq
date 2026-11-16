import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { exportJWK, generateKeyPair } from "jose";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // The Access signing key for this run; tests serve its public half as the team's key set (src/test/access.ts).
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return {
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
          },
        },
      }),
    ],
    test: {
      include: ["src/**/*.test.ts"],
      setupFiles: ["src/test/setup.ts"],
    },
  };
});
