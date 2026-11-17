// Git for the tests, safe by construction. Every fixture git command goes through FixtureGit, which runs git only on
// paths inside one fixture root (a fresh temporary directory outside every repository) and with an environment built
// from nothing: no variable of the test process reaches git, so a GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE that a hook
// set cannot send a command to the real repository, and the developer's config, identity, signing and hooks never apply.
// Identity comes only from GIT_AUTHOR_* and GIT_COMMITTER_*; no fixture writes user.* or global or system config.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { PrRef } from "@prq/protocol";

const run = promisify(execFile);

// A fresh directory in the OS temp directory, as the file system resolves it, checked to be outside every repository.
export async function fixtureRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  // git's own discovery from the root, with no ceiling and no variable that names a repository.
  const found = await run("git", ["-C", root, "rev-parse", "--absolute-git-dir"], {
    env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).then(
    ({ stdout }) => stdout.trim(),
    () => null,
  );
  if (found !== null) {
    throw new Error(`the fixture root ${root} is inside the repository ${found}`);
  }
  return root;
}

// The environment of every git a test runs, the CLI's included, and nothing else: the isolated config, HOME and
// XDG_CONFIG_HOME in the root, discovery stopped at the root, a fixed identity, no prompt.
export function gitEnv(root: string): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: dirname(root),
    GIT_AUTHOR_NAME: "prq test",
    GIT_AUTHOR_EMAIL: "prq-test@example.com",
    GIT_COMMITTER_NAME: "prq test",
    GIT_COMMITTER_EMAIL: "prq-test@example.com",
    GIT_TERMINAL_PROMPT: "0",
  };
}

// Options that would point a command at another repository than its -C directory.
const ELSEWHERE = /^(?:-C|--git-dir(?:=.*)?|--work-tree(?:=.*)?|--namespace(?:=.*)?)$/;

// git's options before the subcommand that take the next argument as their value.
const GLOBAL_WITH_VALUE = new Set(["-c", "--config-env", "--attr-source"]);

// The subcommand: the first argument after git's own options.
function subcommand(args: readonly string[]): string | undefined {
  let index = 0;
  while (args[index]?.startsWith("-") === true) {
    index += GLOBAL_WITH_VALUE.has(args[index] ?? "") ? 2 : 1;
  }
  return args[index];
}

// What in args may name a path: the value of every --option=value, and every other argument that looks like a path
// (absolute, a file URL, holding a /, . or ..). That covers an option's path given as the next argument (--file <path>)
// too: one that does not look like a path resolves inside the directory git runs in.
function pathsIn(args: readonly string[]): string[] {
  const paths: string[] = [];
  for (const arg of args) {
    const value = /^--[^=]+=(.*)$/s.exec(arg)?.[1];
    if (value !== undefined) {
      paths.push(value);
    } else if (arg.includes("/") || arg === "." || arg === "..") {
      paths.push(arg);
    }
  }
  return paths.map((path) => path.replace(/^file:\/\//, ""));
}

export class FixtureGit {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly #noHooks: string;

  private constructor(root: string) {
    this.root = root;
    this.env = gitEnv(root);
    this.#noHooks = join(root, "no-hooks");
  }

  // The isolated global config, in a root from fixtureRoot: no signing, hooks from an empty directory, url.insteadOf
  // rewrites (to: from).
  static async create(root: string, insteadOf: Readonly<Record<string, string>> = {}): Promise<FixtureGit> {
    const fixture = new FixtureGit(root);
    await mkdir(fixture.#noHooks, { recursive: true });
    const config = [
      "[init]",
      "\tdefaultBranch = main",
      "[commit]",
      "\tgpgsign = false",
      "[tag]",
      "\tgpgsign = false",
      "[core]",
      `\thooksPath = ${fixture.#noHooks}`,
      // Submodules from local paths, for the fixture that has one.
      '[protocol "file"]',
      "\tallow = always",
      ...Object.entries(insteadOf).flatMap(([to, from]) => [`[url "${to}"]`, `\tinsteadOf = ${from}`]),
      "",
    ];
    await writeFile(join(root, "gitconfig"), config.join("\n"));
    return fixture;
  }

  // git -C dir args, checked before git runs: dir, and every path in args (pathsIn) resolved against dir, must be
  // inside the root; no option may name another repository; no config write may be global, system or of user.*. Not a
  // parser of git's arguments: a guard against a test's mistake, with the canary (canary.ts) behind it. No hook runs.
  async git(dir: string, ...args: string[]): Promise<string> {
    const cwd = await realpath(dir);
    await this.#assertInside(dir, cwd);
    const elsewhere = args.find((arg) => ELSEWHERE.test(arg));
    if (elsewhere !== undefined) {
      throw new Error(`a fixture git command may not pass ${elsewhere}`);
    }
    for (const path of pathsIn(args)) {
      await this.#assertInside(path, resolve(cwd, path));
    }
    if (subcommand(args) === "config" && args.some((arg) => /^(?:--global|--system|user\..*)$/i.test(arg))) {
      throw new Error(`a fixture may not run git ${args.join(" ")}`);
    }
    const { stdout } = await run("git", ["-C", dir, "-c", `core.hooksPath=${this.#noHooks}`, ...args], {
      env: this.env,
    });
    return stdout.trim();
  }

  // A new repository at path, checked to be its own: its top level (a bare one's git directory) is path.
  async init(path: string, { bare = false } = {}): Promise<void> {
    await mkdir(path, { recursive: true });
    await this.git(path, "init", "--quiet", ...(bare ? ["--bare"] : []));
    await this.#assertOwnRepository(path, bare);
  }

  // A clone of url at path, checked the same way.
  async clone(url: string, path: string): Promise<void> {
    await this.git(dirname(path), "clone", "--quiet", url, path);
    await this.#assertOwnRepository(path, false);
  }

  async #assertOwnRepository(path: string, bare: boolean): Promise<void> {
    const commonDir = await this.git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const top = bare ? path : await this.git(path, "rev-parse", "--path-format=absolute", "--show-toplevel");
    if (top !== path || commonDir !== (bare ? path : join(path, ".git"))) {
      throw new Error(`git at ${path} found the repository ${top} (${commonDir}), not its own`);
    }
  }

  async #assertInside(what: string, resolved: string): Promise<void> {
    // Through the existing part of the path, as the file system resolves it.
    let existing = resolved;
    let rest = "";
    for (;;) {
      try {
        existing = await realpath(existing);
        break;
      } catch {
        rest = join(basename(existing), rest);
        existing = dirname(existing);
      }
    }
    const full = join(existing, rest);
    if (full !== this.root && !full.startsWith(`${this.root}${sep}`)) {
      throw new Error(`a fixture git command names ${what}, outside the fixture root ${this.root}`);
    }
  }
}

// Repositories for the checkout tests, in a root from fixtureRoot: a bare origin.git with main and the pull request's
// refs/pull/<n>/head, and the host's clone under a clone root as <owner>/<repo>, whose origin is the GitHub URL as a
// host's would be, rewritten to the bare repository by url.insteadOf in the isolated global config.
export type Repo = {
  fixture: FixtureGit;
  // What the CLI under test needs on top of gitEnv: the clone root.
  env: Record<string, string>;
  url: string;
  bare: string;
  clone: string;
  // The commit main points at, the pull request's base.
  base: string;
  git(dir: string, ...args: string[]): Promise<string>;
  // The paths of the worktrees the clone registers, its own first.
  worktrees(): Promise<string[]>;
  // A commit on top of main holding the files and symlinks, made the pull request's head in origin.git.
  head(label: string, files?: Record<string, string>, symlinks?: Record<string, string>): Promise<string>;
};

export async function makeRepo(root: string, pr: PrRef): Promise<Repo> {
  const repos = join(root, "repos");
  const bare = join(repos, "origin.git");
  const seed = join(repos, "seed");
  const roots = join(repos, "roots");
  const clone = join(roots, pr.owner, pr.repo);
  const url = `https://github.com/${pr.owner}/${pr.repo}.git`;
  const fixture = await FixtureGit.create(root, { [`file://${bare}`]: url });
  const git = (dir: string, ...args: string[]) => fixture.git(dir, ...args);
  await fixture.init(bare, { bare: true });
  await fixture.init(seed);
  await writeFile(join(seed, "README.md"), "a widget\n");
  await git(seed, "add", "README.md");
  await git(seed, "commit", "--quiet", "-m", "base");
  await git(seed, "push", "--quiet", bare, "HEAD:refs/heads/main");
  const base = await git(seed, "rev-parse", "HEAD");
  await mkdir(join(roots, pr.owner), { recursive: true });
  await fixture.clone(url, clone);

  return {
    fixture,
    env: { PRQ_CLONE_ROOTS: roots },
    url,
    bare,
    clone,
    base,
    git,
    async worktrees() {
      const listed = await git(clone, "worktree", "list", "--porcelain");
      return listed
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length));
    },
    async head(label, files = {}, symlinks = {}) {
      await git(seed, "checkout", "--quiet", "--detach", base);
      await writeFile(join(seed, "change.txt"), `${label}\n`);
      for (const [path, content] of Object.entries(files)) {
        await mkdir(join(seed, path, ".."), { recursive: true });
        await writeFile(join(seed, path), content);
      }
      for (const [path, target] of Object.entries(symlinks)) {
        await mkdir(join(seed, path, ".."), { recursive: true });
        await symlink(target, join(seed, path));
      }
      await git(seed, "add", "--all");
      await git(seed, "commit", "--quiet", "-m", label);
      await git(seed, "push", "--quiet", "--force", bare, `HEAD:refs/pull/${pr.number}/head`);
      return git(seed, "rev-parse", "HEAD");
    },
  };
}
