// The local stack (`pnpm run stack` in packages/cli; .claude/skills/verify-prq/SKILL.md), for an AI session that
// follows skills/prq/SKILL.md with the compiled prq. This process owns the stack's whole life: it takes SIGINT, SIGTERM
// and SIGHUP from its first line, makes the fixture root, and runs the rest (local-stack-child.ts: the Worker through
// wrangler's test harness, the stand-in for Access, the repository fixture and the control server) in a worker process
// of its own process group, because the harness's own handlers for those signals exit the process they run in. A
// terminal's Ctrl-C reaches this process alone. It stops on a signal or when the worker process ends (POST /stop, a
// failed start): it asks the worker process to stop over the IPC channel, which ends what that process started; ends
// what is left of its process group (workerd, esbuild), escalating from SIGTERM to SIGKILL; removes the fixture root;
// and prints `stopped`. Then it ends by the signal it got, or with the worker process's exit code.

import { type ChildProcess, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Endings } from "./endings.ts";
import { fixtureRoot } from "./git.ts";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
// How long the worker process has to stop itself: a step of its start in flight completes first.
const STOP_MS = 30_000;
// How long its process group has to end after SIGTERM before SIGKILL.
const KILL_GRACE_MS = 5_000;
const WORKER = fileURLToPath(new URL("./local-stack-child.ts", import.meta.url));

const say = (line: string) => process.stdout.write(`prq local stack: ${line}\n`);

const endings = new Endings();
let signal: NodeJS.Signals | null = null;
const listeners = new Map(
  SIGNALS.map((name) => [
    name,
    () => {
      signal ??= name;
      void finish(1);
    },
  ]),
);
for (const [name, listener] of listeners) {
  process.on(name, listener);
}

function signalGroup(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pid, name);
  } catch {
    // The group has ended.
  }
}

// Whether done settled within ms.
async function within(done: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([done.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

// Asks the worker process to stop, then ends what is left of its process group.
async function stopWorker(child: ChildProcess, exited: Promise<number>): Promise<void> {
  const { pid } = child;
  if (pid === undefined) {
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    if (child.connected) {
      child.send("stop");
    }
    if (!(await within(exited, STOP_MS))) {
      signalGroup(pid, "SIGTERM");
      if (!(await within(exited, KILL_GRACE_MS))) {
        signalGroup(pid, "SIGKILL");
        await exited;
      }
    }
  }
  // Whatever outlived the worker process in its group (a workerd, an esbuild).
  signalGroup(pid, "SIGKILL");
}

const startup = (async () => {
  const root = await fixtureRoot("prq-stack-");
  endings.add(() => rm(root, { recursive: true, force: true }));
  if (signal !== null) {
    return;
  }
  const child = spawn(process.execPath, [WORKER, root], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
  endings.add(() => stopWorker(child, exited));
  say(`starting in ${root}, the worker process ${child.pid ?? "(not started)"} in a process group of its own`);
  void exited.then((code) => finish(code));
})();

let finishing: Promise<void> | null = null;
function finish(code: number): Promise<void> {
  finishing ??= (async () => {
    const failed = await startup.then(
      () => false,
      (error: unknown) => {
        say(`the start failed: ${error instanceof Error ? error.message : String(error)}`);
        return true;
      },
    );
    say("stopping: the worker process and its process group, then the fixture root");
    const errors = await endings.run();
    for (const error of errors) {
      say(`an ending failed: ${String(error)}`);
    }
    process.stdout.write("prq local stack: stopped\n", () => {
      if (signal !== null) {
        for (const [name, listener] of listeners) {
          process.off(name, listener);
        }
        process.kill(process.pid, signal);
      } else {
        process.exitCode = failed || errors.length > 0 ? 1 : code;
      }
    });
  })();
  return finishing;
}

// A start that fails before the worker process exists ends here.
startup.catch(() => void finish(1));
