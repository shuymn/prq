// A manual check of context compaction with Docker (`pnpm run check:compaction [options] <owner>/<repo>#<number>` in
// packages/cli; src/test/compaction.ts), on a pull request of a public repository the GitHub App is installed on, with
// the settings of packages/server/.dev.vars (src/test/app-check.ts) and a small window there (MODEL_CONTEXT_TOKENS, such
// as 20000), so a few questions pass it. `--japanese` asks its questions in Japanese, so the summaries are written for a
// Japanese conversation; English otherwise. `--analysis-prompt <text>` and `--answer-prompt <text>` save the host's
// prompts before the analysis (two different texts, so each request can be told to hold only its own).

import { runAppCheck } from "./app-check.ts";
import { checkCompaction, ENGLISH, JAPANESE } from "./compaction.ts";

await runAppCheck(
  "compaction",
  (settings, pr, print, values) =>
    checkCompaction(settings, pr, print, values.japanese === true ? JAPANESE : ENGLISH, {
      analysis: values["analysis-prompt"] ?? "",
      answer: values["answer-prompt"] ?? "",
    }),
  { japanese: { type: "boolean" }, "analysis-prompt": { type: "string" }, "answer-prompt": { type: "string" } },
);
