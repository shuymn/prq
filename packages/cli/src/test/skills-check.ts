// A manual check of skill registration (`pnpm run check:skills` in packages/cli; src/test/skills.ts), against real
// GitHub with the GitHub App of packages/server/.dev.vars (src/test/app-check.ts). No model and no Docker: the Worker
// runs in wrangler's local runtime with containers off.

import { runGithubAppCheck } from "./app-check.ts";
import { checkSkills } from "./skills.ts";

await runGithubAppCheck("skills", checkSkills);
