// A manual check of the cloud workspace with Docker (`pnpm run check:workspace [--browser] <owner>/<repo>#<number>` in
// packages/cli; src/test/workspace.ts), on a pull request of a public repository the GitHub App is installed on, with
// the settings of packages/server/.dev.vars (src/test/app-check.ts).

import { runAppCheck } from "./app-check.ts";
import { checkWorkspace } from "./workspace.ts";

await runAppCheck("workspace", checkWorkspace, { browser: { type: "boolean" } });
