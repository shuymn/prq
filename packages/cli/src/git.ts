import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

import { CliError, EXIT } from "./errors.ts";

// How long prq waits for git. A fetch or a worktree add depends on the repository's size and the network: up to
// GIT_LONG_MS, under the 30 minutes Claude Code gives a background command. A local query: GIT_QUICK_MS.
export const GIT_LONG_MS = 25 * 60_000;
export const GIT_QUICK_MS = 60_000;

// How long git has to exit after SIGTERM (it removes its lock files then) before it is killed.
const KILL_GRACE_MS = 5_000;

// The process groups of the git calls running. Each git runs in a group of its own, with the programs it starts (a
// filter such as Git LFS's, a credential helper, ssh), so stopping the group stops them all; a signal to prq does not
// reach a group of its own, so prq passes SIGINT, SIGTERM and SIGHUP on to the groups, then ends by the signal.
const groups = new Set<number>();
let forwarding = false;

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group has ended.
  }
}

function forwardSignals(): void {
  if (forwarding) {
    return;
  }
  forwarding = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      for (const pid of groups) {
        signalGroup(pid, "SIGTERM");
      }
      // The listener is gone, so this ends prq as the signal would have.
      process.kill(process.pid, signal);
    });
  }
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
    forwardSignals();
    const child = spawn(this.#binary, ["-C", dir, "-c", `core.hooksPath=${this.#hooks}`, ...args], {
      env: this.#env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const { pid } = child;
    if (pid !== undefined) {
      groups.add(pid);
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const what = args.slice(0, 2).join(" ");
    return new Promise((resolve, reject) => {
      let timedOut = false;
      let kill: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        if (pid !== undefined) {
          signalGroup(pid, "SIGTERM");
          kill = setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_GRACE_MS);
        }
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        clearTimeout(kill);
        if (pid !== undefined) {
          groups.delete(pid);
          // What of a stopped git's group outlived it and closed its output.
          if (timedOut) {
            signalGroup(pid, "SIGKILL");
          }
        }
      };
      child.on("error", (error) => {
        done();
        reject(new CliError(EXIT.error, `git could not run: ${error.message}`));
      });
      child.on("close", (code) => {
        done();
        if (timedOut) {
          reject(new GitTimeout(what, timeoutMs));
        } else {
          resolve({ code: code ?? 1, stdout, stderr });
        }
      });
    });
  }
}
