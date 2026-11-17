// A manual check of the cloud agent's provider (`pnpm run check:provider` in packages/server): reads MODEL_* from
// the environment (the package script loads packages/server/.dev.vars), builds the production model and prints what
// the provider does with streaming, usage and caching, a tool call, toolChoice "none" and a context-length refusal.
// It never prints the API key. Exits 1 with the reason when the configuration is missing or invalid, or when a check
// did not behave as a cloud turn needs. Not part of the Worker: wrangler bundles only what src/index.ts imports.

import { readModelConfig } from "../src/config.ts";
import { checkProvider } from "./provider-report.ts";

const config = readModelConfig(process.env);
if (config === null) {
  console.error(
    "provider check: MODEL_BASE_URL, MODEL_API_KEY, MODEL_ID and MODEL_CONTEXT_TOKENS are not set (packages/server/.dev.vars)",
  );
  process.exit(1);
}
if (!config.ok) {
  console.error(`provider check: the model configuration is invalid: ${config.issues.join("; ")}`);
  process.exit(1);
}
const ok = await checkProvider(config.config, (line) => console.log(line));
process.exitCode = ok ? 0 : 1;
