// vitest's global setup: compiles the prq binary with the package's build script (Bun, from mise.toml) once per run, so
// the end-to-end tests run the artifact that ships rather than its source.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  execFileSync("pnpm", ["run", "build"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: "pipe" });
}
