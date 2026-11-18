// A manual check of skills (`pnpm run check:skills [--local <owner>/<repo>#<number> | <owner>/<repo>#<number>]` in
// packages/cli; src/test/skills.ts), against real GitHub with the GitHub App of packages/server/.dev.vars
// (src/test/app-check.ts). Without an argument it needs the App alone, no model and no Docker: the Worker runs in
// wrangler's local runtime with containers off, and its turns' model is scripted here. With --local and a pull request
// of a public repository, it then runs the compiled prq as a local agent on that pull request (src/test/skill-local.ts),
// still with the App alone. With a pull request of a public repository the App is installed on, it then runs the scripts
// step and the smoke with the model of .dev.vars at the window it sets (the provider's real one), with Docker.

import { prArgument, runAppCheck, runGithubAppCheck } from "./app-check.ts";
import { checkSkills } from "./skills.ts";

const args = process.argv.slice(2).filter((arg) => arg !== "--");

if (args.length === 0 || args[0] === "--local") {
  // No argument, or --local and a pull request; anything else ends here, before the settings are read.
  const local = args.length === 2 ? prArgument(args[1]) : null;
  if (args.length > 0 && local === null) {
    process.stderr.write(
      "skills check: usage: check:skills [--local <owner>/<repo>#<number> | <owner>/<repo>#<number>]\n",
    );
    process.exit(1);
  }
  await runGithubAppCheck("skills", (app, print) => checkSkills(app, print, { smoke: null, local }));
} else {
  await runAppCheck(
    "skills",
    (settings, pr, print) => checkSkills(settings.app.settings, print, { smoke: { ...settings, pr }, local: null }),
    {},
  );
}
