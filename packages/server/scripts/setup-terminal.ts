// The GitHub App step's tests' terminal: a run of the scripts' test entry in a pseudo-terminal from the machine's
// python3 (as the deploy's tests get one), where prompts are answered in the order the output shows them.

import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_ENTRY = fileURLToPath(new URL("test-entry.ts", import.meta.url));

const IN_TERMINAL = [
  "import os, pty, sys",
  "os.umask(0o022)",
  "code = os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:]))",
  "sys.exit(code if code >= 0 else 128 - code)",
].join("\n");

// What to type once the output shows a prompt: the text as typed (a reply ends with "\r"), or what a function gives
// then.
export type Turn = [string, string | (() => Promise<string> | string)];

type TerminalRun = {
  // The fixture file and the entry's arguments after it.
  fixture: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  turns?: readonly Turn[];
  // Sent to the setup's own process once the output shows this prompt.
  signalAt?: [string, NodeJS.Signals] | undefined;
};

type Result = { code: number | null; output: string };

// macOS checks python3 on its first run, which can take seconds.
export async function warmTerminal(): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile("python3", ["-I", "-S", "-c", "pass"], { timeout: 60_000 }, () => resolve());
  });
}

// The setup's node process, found by its fixture file among its arguments.
function setupPid(file: string): number {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", timeout: 10_000 }).stdout ?? "";
  for (const line of listed.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match?.[2]?.startsWith(process.execPath) === true && match[2].includes(file)) {
      return Number(match[1]);
    }
  }
  throw new Error("the setup's process was not found");
}

// The run, its child added to started (for the suite to stop), its output with CRLF read as LF.
export async function inTerminal(
  { fixture, args, cwd, env, turns = [], signalAt }: TerminalRun,
  started: ChildProcess[],
): Promise<Result> {
  const argv = ["python3", "-I", "-S", "-c", IN_TERMINAL, process.execPath, TEST_ENTRY, fixture, ...args];
  const child = spawn(argv[0] ?? "", argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  started.push(child);
  let output = "";
  let from = 0;
  let turn = 0;
  let busy = false;
  let signalled = false;
  const advance = async () => {
    if (busy) {
      return;
    }
    busy = true;
    for (;;) {
      const next = turns[turn];
      const at = next === undefined ? -1 : output.indexOf(next[0], from);
      if (next === undefined || at === -1) {
        break;
      }
      from = at + next[0].length;
      turn += 1;
      child.stdin.write(typeof next[1] === "string" ? next[1] : await next[1]());
    }
    busy = false;
  };
  const read = (chunk: string) => {
    output += chunk;
    void advance();
    if (signalAt !== undefined && !signalled && output.includes(signalAt[0])) {
      signalled = true;
      process.kill(setupPid(fixture), signalAt[1]);
    }
  };
  child.stdout.setEncoding("utf8").on("data", read);
  child.stderr.setEncoding("utf8").on("data", read);
  const result = await new Promise<Result>((resolve) => {
    child.on("close", (code) => resolve({ code, output: output.replaceAll("\r\n", "\n") }));
  });
  child.stdin.destroy();
  return result;
}
