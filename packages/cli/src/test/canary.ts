// vitest's global setup: a canary over the repository the tests run in. At setup it records the repository's refs,
// HEAD, worktrees, config, index, hooks and the user's identity; at teardown it records them again and fails the run on
// any difference, since no test may write to the repository. Two kinds of change it lets pass, since what makes them
// is not a test and they write nothing a test could: refs under refs/t3/, where T3 Code saves its checkpoints while a
// run goes on, and the index's stat data, which any git status refreshes (the index is compared by its entries, their
// flags and its resolve-undo record). Its own git reads only, with an environment of PATH and the user's HOME alone, so
// a GIT_DIR in the test process's environment cannot point it elsewhere.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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

// Every entry under dir: its path, type, mode, and its bytes' hash or a symlink's target. Not following symlinks.
async function tree(dir: string | null): Promise<string> {
  if (dir === null) {
    return "no directory";
  }
  const entries = await readdir(dir, { recursive: true }).catch(() => null);
  if (entries === null) {
    return "missing";
  }
  const described = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry);
      const stats = await lstat(path);
      const content = stats.isSymbolicLink() ? `-> ${await readlink(path)}` : stats.isFile() ? await hash(path) : "";
      return `${relative(dir, path)} ${(stats.mode & 0o170777).toString(8)} ${content}`;
    }),
  );
  return described.toSorted().join("\n");
}

type Snapshot = Record<string, string | null>;

async function snapshot(top: string): Promise<Snapshot> {
  const gitPath = (name: string) => git(top, "rev-parse", "--path-format=absolute", "--git-path", name);
  const list = async (...args: string[]) => (await git(top, "ls-files", "-z", ...args))?.replaceAll("\0", "\n") ?? null;
  const commonDir = (await git(top, "rev-parse", "--path-format=absolute", "--git-common-dir"))?.trim();
  const hooksPath = (await git(top, "config", "--type=path", "--get", "core.hooksPath"))?.trim();
  const { HOME: home = "", XDG_CONFIG_HOME: xdg = "" } = env();
  const refs = await git(top, "for-each-ref", "--format=%(refname) %(objectname)");
  return {
    refs:
      refs
        ?.split("\n")
        .filter((line) => !line.startsWith("refs/t3/"))
        .join("\n") ?? null,
    head: await git(top, "rev-parse", "--symbolic-full-name", "HEAD", "HEAD"),
    worktrees: await git(top, "worktree", "list", "--porcelain"),
    config: await hash(await gitPath("config")),
    worktreeConfig: await hash(await gitPath("config.worktree")),
    indexEntries: await list("--stage"),
    indexFlags: await list("-v"),
    indexResolveUndo: await list("--resolve-undo"),
    hooks: await tree(commonDir === undefined ? null : join(commonDir, "hooks")),
    hooksPath: hooksPath === undefined ? "not set" : `${hooksPath}\n${await tree(resolve(top, hooksPath))}`,
    userName: await git(top, "config", "--get", "user.name"),
    userEmail: await git(top, "config", "--get", "user.email"),
    globalConfig: await hash(join(home, ".gitconfig")),
    xdgConfig: await hash(join(xdg, "git", "config")),
  };
}

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  const top = (await git(PACKAGE, "rev-parse", "--show-toplevel"))?.trim();
  // Not in a repository: nothing to guard.
  return top === undefined ? undefined : guard(top);
}

// Records the repository at top; the function returned fails when it changed since.
export async function guard(top: string): Promise<() => Promise<void>> {
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
