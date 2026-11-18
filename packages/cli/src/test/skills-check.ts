// A manual check of skills (`pnpm run check:skills [<owner>/<repo>#<number>]` in packages/cli; src/test/skills.ts),
// against real GitHub with the GitHub App of packages/server/.dev.vars (src/test/app-check.ts). Without an argument it
// needs the App alone, no model and no Docker: the Worker runs in wrangler's local runtime with containers off, and
// its turns' model is scripted here. With a pull request of a public repository the App is installed on, it then runs
// the smoke with the model of .dev.vars at the window it sets (the provider's real one), with Docker.

import { runAppCheck, runGithubAppCheck } from "./app-check.ts";
import { checkSkills } from "./skills.ts";

if (process.argv.slice(2).some((arg) => arg !== "--")) {
  await runAppCheck(
    "skills",
    (settings, pr, print) => checkSkills(settings.app.settings, print, { ...settings, pr }),
    {},
  );
} else {
  await runGithubAppCheck("skills", (app, print) => checkSkills(app, print, null));
}
