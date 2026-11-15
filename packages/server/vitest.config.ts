// workerd: suites that must run inside the Workers runtime (the GitHub libraries, doc check 5).
import { generateKeyPairSync } from "node:crypto";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway App key made per run. GitHub hands out PKCS#1 PEM ("BEGIN RSA PRIVATE KEY"); PKCS#8 is the other form.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_APP_KEY_PKCS1: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
          TEST_APP_KEY_PKCS8: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          TEST_APP_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      },
    }),
  ],
  test: { name: "workerd", include: ["test/workerd/**/*.test.ts"] },
});
