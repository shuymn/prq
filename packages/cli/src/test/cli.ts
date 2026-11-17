// The real CLI as a child process: the prq binary the package's build compiles (src/test/build.ts runs it before the
// tests), with an environment of its own: nothing from the developer's environment but PATH, a temporary HOME and state
// root, and the stand-in Access as the Worker's URL.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The build script's --outfile (package.json).
const BINARY = fileURLToPath(new URL("../../dist/prq", import.meta.url));

export type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

export type Running = {
  child: ChildProcess;
  // Settles once the process exited and its output closed.
  exited: Promise<Exit>;
  // Kills it with SIGKILL and waits for its exit.
  kill(): Promise<Exit>;
};

export function startCli(args: readonly string[], env: Readonly<Record<string, string>>, cwd: string): Running {
  const child = spawn(BINARY, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<Exit>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return {
    child,
    exited,
    kill() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      return exited;
    },
  };
}

// The one JSON line a command printed on stdout.
export function result(exit: Exit): unknown {
  const lines = exit.stdout.split("\n").filter((line) => line !== "");
  if (lines.length !== 1 || lines[0] === undefined) {
    throw new Error(`expected one line on stdout, got ${JSON.stringify(exit.stdout)} (stderr ${exit.stderr})`);
  }
  return JSON.parse(lines[0]);
}

// The stderr lines, without the trailing newline.
export function stderrLines(exit: Exit): string[] {
  return exit.stderr.split("\n").filter((line) => line !== "");
}
