// The web UI's build, which the Worker serves as its static assets (packages/server/wrangler.jsonc `assets`). It is
// built once per test run (the root `test` script) and before the local stack and the owner's checks start; nothing
// that runs the Worker builds it. Without it the Worker would start and serve no UI, so whatever runs the Worker stops
// first, saying how to build it: startWorker (worker.ts) here, and the server's workerd test project through this
// module's default export, its vitest global setup (packages/server/vitest.config.ts).

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLIENT_INDEX = fileURLToPath(new URL("../../../server/dist/client/index.html", import.meta.url));

export function requireClientBuild(index: string = CLIENT_INDEX): void {
  if (!existsSync(index)) {
    throw new Error(`the web UI is not built (${index} is missing): run \`pnpm --filter @prq/server run build\` first`);
  }
}

export default function setup(): void {
  requireClientBuild();
}
