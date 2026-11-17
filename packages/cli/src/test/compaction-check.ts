// A manual check of context compaction with Docker (`pnpm run check:compaction <owner>/<repo>#<number>` in
// packages/cli; src/test/compaction.ts), on a pull request of a public repository the GitHub App is installed on, with
// the settings of packages/server/.dev.vars (src/test/app-check.ts) and a small window there (MODEL_CONTEXT_TOKENS, such
// as 20000), so a few questions pass it.

import { runAppCheck } from "./app-check.ts";
import { checkCompaction } from "./compaction.ts";

await runAppCheck("compaction", checkCompaction);
