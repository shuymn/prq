// A manual check of the cloud agent's tool loop (`pnpm run check:tools` in packages/server): reads MODEL_* from the
// environment (the package script loads packages/server/.dev.vars), builds the production model, and runs the
// production turn's tools, stopWhen and room over an in-memory repository of a base and a head, with a window small
// enough that the tools are withdrawn. It prints each step, the answer and the usage, never the API key. Exits 1 unless
// the answer is not blank and the turn finished with `stop`. Not part of the Worker: wrangler bundles only what
// src/index.ts imports.

import { readModelConfig } from "../src/config.ts";
import { createModel } from "../src/pr-session/model.ts";
import { checkTools } from "./tools-report.ts";

const config = readModelConfig(process.env);
if (config === null) {
  console.error(
    "tools check: MODEL_BASE_URL, MODEL_API_KEY, MODEL_ID and MODEL_CONTEXT_TOKENS are not set (packages/server/.dev.vars)",
  );
  process.exit(1);
}
if (!config.ok) {
  console.error(`tools check: the model configuration is invalid: ${config.issues.join("; ")}`);
  process.exit(1);
}
const ok = await checkTools(createModel(config.config), (line) => console.log(line), {
  secret: config.config.MODEL_API_KEY,
});
process.exitCode = ok ? 0 : 1;
