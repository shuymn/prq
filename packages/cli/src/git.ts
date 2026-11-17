import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

import { CliError, EXIT } from "./errors.ts";

// How long prq waits for git. A fetch or a worktree add depends on the repository's size and the network: up to
// GIT_LONG_MS, under the 30 minutes Claude Code gives a background command. A local query: GIT_QUICK_MS.
export const GIT_LONG_MS = 25 * 60_000;
export const GIT_QUICK_MS = 60_000;

// How long git has to exit after SIGTERM (it removes its lock files then) before it is killed.
const KILL_GRACE_MS = 5_000;

// The git calls running, each in a process group of its own with the programs it starts (a filter such as Git LFS's, a
// credential helper, ssh), so stopping the group stops them all. A signal to prq does not reach a group of its own, so
// prq passes SIGINT, SIGTERM and SIGHUP on to each group as they came, stops each as a timeout does (stopGroup), and
// then ends by the signal. Until then no git call settles and none starts, so the command neither goes on nor prints.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const running = new Set<{ stop(signal: NodeJS.Signals): Promise<void> }>();
const listeners = new Map(SIGNALS.map((signal) => [signal, () => end(signal)]));
let listening = false;
let ending: NodeJS.Signals | null = null;

function listen(): void {
  if (!listening) {
    listening = true;
    for (const [signal, listener] of listeners) {
      process.on(signal, listener);
    }
  }
}

function end(signal: NodeJS.Signals): void {
  if (ending !== null) {
    return;
  }
  ending = signal;
  void Promise.all([...running].map(async (git) => git.stop(signal))).then(() => {
    // With the listeners gone, this ends prq as the signal would have.
    for (const [name, listener] of listeners) {
      process.off(name, listener);
    }
    process.kill(process.pid, signal);
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group has ended.
  }
}

// Stops a git's group: signal to the group, which then has KILL_GRACE_MS to end and close git's output, then SIGKILL to
// what is left of it (a program that ignored the signal, or outlived git); settles once git itself has exited.
async function stopGroup(pid: number, signal: NodeJS.Signals, closed: Promise<void>, exited: Promise<void>) {
  signalGroup(pid, signal);
  let grace: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([closed, new Promise((resolve) => (grace = setTimeout(resolve, KILL_GRACE_MS)))]);
  clearTimeout(grace);
  signalGroup(pid, "SIGKILL");
  await exited;
}

export type GitResult = { code: number; stdout: string; stderr: string };

// A git call that did not end within its timeout; git was stopped.
export class GitTimeout extends CliError {
  constructor(what: string, timeoutMs: number) {
    super(EXIT.error, `git ${what} did not finish within ${timeoutMs / 1000} s`);
  }
}

// The variables that point git at a repository other than the one -C names, which a hook that runs prq (or runs the AI
// that does) has set for its own repository: git's own list of them (git rev-parse --local-env-vars), which git clears
// itself when it runs a command in another repository, and GIT_NAMESPACE.
export const REPOSITORY_VARIABLES: ReadonlySet<string> = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
]);

// The host's git, as every prq git call runs it: on the repository -C names and no other (the variables above are
// dropped), with the host's config (filters such as Git LFS, credentials), but with none of the repository's hooks
// (core.hooksPath names an empty directory prq owns), and never asking for input (GIT_TERMINAL_PROMPT=0), since the AI
// that runs prq cannot answer.
export class Git {
  readonly #hooks: string;
  readonly #binary: string;
  readonly #env: Record<string, string>;

  private constructor(hooks: string, binary: string, env: Readonly<Record<string, string | undefined>>) {
    this.#hooks = hooks;
    this.#binary = binary;
    this.#env = {};
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined && !REPOSITORY_VARIABLES.has(name)) {
        this.#env[name] = value;
      }
    }
    this.#env["GIT_TERMINAL_PROMPT"] = "0";
  }

  // hooks: the empty directory. A test gives another program in git's place, or the environment git starts from.
  static async create(
    hooks: string,
    { binary = "git", env = process.env }: { binary?: string; env?: Readonly<Record<string, string | undefined>> } = {},
  ): Promise<Git> {
    await mkdir(hooks, { recursive: true, mode: 0o700 });
    return new Git(hooks, binary, env);
  }

  // git -C dir args: its exit code and output. A git that cannot start, or does not end within timeoutMs, ends the
  // command; one that does not end is stopped with every program it started.
  run(dir: string, args: readonly string[], timeoutMs: number): Promise<GitResult> {
    if (ending !== null) {
      return new Promise(() => {});
    }
    listen();
    const child = spawn(this.#binary, ["-C", dir, "-c", `core.hooksPath=${this.#hooks}`, ...args], {
      env: this.#env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const what = args.slice(0, 2).join(" ");
    const settled = (event: "exit" | "close") =>
      new Promise<void>((resolve) => {
        child.once(event, () => resolve()).once("error", () => resolve());
      });
    const [exited, closed] = [settled("exit"), settled("close")];
    return new Promise((resolve, reject) => {
      let stopping: Promise<void> | null = null;
      const call = {
        stop: async (signal: NodeJS.Signals) => {
          const { pid } = child;
          stopping ??= pid === undefined ? exited : stopGroup(pid, signal, closed, exited);
          return stopping;
        },
      };
      running.add(call);
      const timer = setTimeout(() => {
        void call.stop("SIGTERM").then(() => {
          running.delete(call);
          if (ending === null) {
            reject(new GitTimeout(what, timeoutMs));
          }
        });
      }, timeoutMs);
      // A git stopped, by its timeout or a signal to prq (which stops every git running), settles as that stop does.
      const finish = (settle: () => void) => {
        if (stopping === null) {
          clearTimeout(timer);
          running.delete(call);
          settle();
        }
      };
      child.on("error", (error) => {
        finish(() => reject(new CliError(EXIT.error, `git could not run: ${error.message}`)));
      });
      child.on("close", (code) => {
        finish(() => resolve({ code: code ?? 1, stdout, stderr }));
      });
    });
  }
}
