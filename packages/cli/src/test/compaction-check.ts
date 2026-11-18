// A manual check of context compaction with Docker (`pnpm run check:compaction <owner>/<repo>#<number>` in
// packages/cli; src/test/compaction.ts), on a pull request of a public repository the GitHub App is installed on, with
// the settings of packages/server/.dev.vars (src/test/app-check.ts) and a small window there (MODEL_CONTEXT_TOKENS, such
// as 20000), so a few questions pass it. `--japanese` asks its questions in Japanese, so the summaries are written for a
// Japanese conversation; English otherwise.

import { runAppCheck } from "./app-check.ts";
import { checkCompaction, ENGLISH, JAPANESE } from "./compaction.ts";

const questions = process.argv.includes("--japanese") ? JAPANESE : ENGLISH;
await runAppCheck("compaction", (settings, pr, print) => checkCompaction(settings, pr, print, questions), [
  "--japanese",
]);
