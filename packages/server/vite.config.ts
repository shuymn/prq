// The web UI's build (`pnpm run build`): src/client into dist/client, which wrangler.jsonc serves as Workers Static
// Assets. The tests and the local stack run the Worker against this output, so the root `test` script builds first.

import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { fontPreloadPlugin, headersPlugin } from "./build/static-assets.ts";
import { tokensPlugin } from "./build/tokens.ts";
import { SERVER_VERSION } from "./src/version.ts";

const CLIENT_OUT_DIR = fileURLToPath(new URL("dist/client", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("src/client", import.meta.url)),
  // The version this build shows next to the product name (src/client/env.d.ts), the server's own.
  define: { __PRQ_VERSION__: JSON.stringify(SERVER_VERSION) },
  plugins: [react(), tokensPlugin(), headersPlugin(), fontPreloadPlugin("inter-latin-400-normal.woff2")],
  build: {
    outDir: CLIENT_OUT_DIR,
    emptyOutDir: true,
    // The latest stable Chrome only (docs/decisions.md).
    target: "esnext",
    // No inline script: the CSP allows scripts from the origin alone.
    modulePreload: { polyfill: false },
    // No data: URL in place of an emitted file: the CSP takes fonts from the origin alone, and every emitted file
    // gets its immutable rule.
    assetsInlineLimit: 0,
  },
});
