// vitest's global setup: a canary over the repository the tests run in. At setup it records the repository's refs, HEAD,
// worktrees, config, index and the user's identity; at teardown it records them again and fails the run on any
// difference, since no test may write to the repository. Its own git reads only, with an environment of PATH and the
// user's HOME alone, so a GIT_DIR in the test process's environment cannot point it elsewhere.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const PACKAGE = fileURLToPath(new URL("../..", import.meta.url));

function env(): Record<string, string> {
  const home = process.env["HOME"] ?? "";
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] ?? join(home, ".config"),
  };
}

// git's output, or null where it fails (a key that is not set).
async function git(dir: string, ...args: string[]): Promise<string | null> {
  return run("git", ["-C", dir, ...args], { env: env() }).then(
    ({ stdout }) => stdout,
    () => null,
  );
}

async function hash(path: string | null): Promise<string> {
  if (path === null) {
    return "no path";
  }
  return readFile(path.trim()).then(
    (bytes) => createHash("sha256").update(bytes).digest("hex"),
    () => "missing",
  );
}

type Snapshot = Record<string, string | null>;

async function snapshot(top: string): Promise<Snapshot> {
  const gitPath = (name: string) => git(top, "rev-parse", "--path-format=absolute", "--git-path", name);
  const { HOME: home = "", XDG_CONFIG_HOME: xdg = "" } = env();
  return {
    refs: await git(top, "for-each-ref", "--format=%(refname) %(objectname)"),
    head: await git(top, "rev-parse", "--symbolic-full-name", "HEAD", "HEAD"),
    worktrees: await git(top, "worktree", "list", "--porcelain"),
    config: await hash(await gitPath("config")),
    worktreeConfig: await hash(await gitPath("config.worktree")),
    index: await hash(await gitPath("index")),
    userName: await git(top, "config", "--get", "user.name"),
    userEmail: await git(top, "config", "--get", "user.email"),
    globalConfig: await hash(join(home, ".gitconfig")),
    xdgConfig: await hash(join(xdg, "git", "config")),
  };
}

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  const top = (await git(PACKAGE, "rev-parse", "--show-toplevel"))?.trim();
  if (top === undefined) {
    // Not in a repository: nothing to guard.
    return undefined;
  }
  const before = await snapshot(top);
  return async () => {
    const after = await snapshot(top);
    const changed = Object.keys(before).filter((key) => before[key] !== after[key]);
    if (changed.length > 0) {
      const details = changed.map((key) => `${key}:\n${difference(before[key] ?? null, after[key] ?? null)}`);
      throw new Error(`the tests changed the repository ${top}: ${changed.join(", ")}\n${details.join("\n")}`);
    }
  };
}

function lines(value: string | null): string[] {
  return (value ?? "(failed)").split("\n").filter((line) => line !== "");
}

// The lines only one side has, marked - (before) and + (after).
function difference(before: string | null, after: string | null): string {
  const [old, now] = [lines(before), lines(after)];
  return [
    ...old.filter((line) => !now.includes(line)).map((line) => `  - ${line}`),
    ...now.filter((line) => !old.includes(line)).map((line) => `  + ${line}`),
  ].join("\n");
}
