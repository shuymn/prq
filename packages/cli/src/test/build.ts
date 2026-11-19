// The package's build of prq (Bun, from mise.toml, compiles it into dist/prq), and vitest's global setup, which runs it
// once per run, so that the end-to-end tests run the artifact that ships rather than its source. The deployed checks'
// edge runs the same build in its own way (deployed-check.ts).

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BUILD = {
  command: "pnpm",
  args: ["run", "build"],
  cwd: fileURLToPath(new URL("../..", import.meta.url)),
} as const;

export default function setup(): void {
  execFileSync(BUILD.command, BUILD.args, { cwd: BUILD.cwd, stdio: "pipe" });
}
