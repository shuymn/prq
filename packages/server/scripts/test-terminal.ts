// The operations scripts' tests run a command on a terminal of its own, from the machine's python3: its pty module runs
// the command on a pseudo-terminal, copies this side's stdin to it and its output here, and exits as it did. Each
// question the command asks (prompt matches its end) is answered in turn: with a text, or with what a function gives
// once it has done what the test does while the question is open.

import { type ChildProcess, spawn } from "node:child_process";

const IN_TERMINAL = [
  "import os, pty, sys",
  "code = os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:]))",
  "sys.exit(code if code >= 0 else 128 - code)",
].join("\n");

export type Answer = string | (() => Promise<string>);
export type TerminalResult = { code: number | null; signal: NodeJS.Signals | null; output: string };

export function runInTerminal(
  command: readonly string[],
  {
    cwd,
    env,
    terminal = true,
    answers = [],
    prompt,
  }: { cwd: string; env: NodeJS.ProcessEnv; terminal?: boolean; answers?: readonly Answer[]; prompt: RegExp },
): { child: ChildProcess; result: Promise<TerminalResult> } {
  const argv = terminal ? ["python3", "-I", "-S", "-c", IN_TERMINAL, ...command] : [...command];
  const child = spawn(argv[0] ?? "", argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let asked = 0;
  // The answers in order, each written once the one before it is.
  let answering = Promise.resolve();
  const read = (chunk: string) => {
    output += chunk;
    const questions = output.split(prompt).length - 1;
    while (asked < questions && asked < answers.length) {
      const each = answers[asked] ?? "";
      answering = answering.then(async () => {
        child.stdin?.write(`${typeof each === "string" ? each : await each()}\n`);
      });
      asked += 1;
    }
  };
  child.stdout?.setEncoding("utf8").on("data", read);
  child.stderr?.setEncoding("utf8").on("data", read);
  const result = new Promise<TerminalResult>((resolve) => {
    child.on("close", (code, signal) => {
      child.stdin?.destroy();
      resolve({ code, signal, output: output.replaceAll("\r\n", "\n") });
    });
  });
  return { child, result };
}
