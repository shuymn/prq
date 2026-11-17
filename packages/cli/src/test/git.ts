// Git for the tests, safe by construction. A test runs git only through the named operations of FixtureGit and
// FixtureRepo, each of which builds its own arguments: there is no free-form git, so no option a test writes can send a
// command to another repository or another config file. The values a test passes (refs, commits, config keys) follow
// --end-of-options, where git cannot take them as options. A path is a name in the fixture root (a fresh temporary
// directory outside every repository), checked before git runs to resolve inside the root with every symlink followed.
// A repository is a FixtureRepo: FixtureGit makes each one at a name that does not exist yet, records its kind (a work
// tree with a .git directory, a bare repository, or a worktree whose .git file names a git directory), and before every
// git call checks each repository the call touches again: its .git entry is still of that kind, and the git directory
// and common directory git finds for it are inside the root. git runs with an environment built from nothing: no
// variable of the test process reaches it, so a GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE that a hook set cannot point
// it elsewhere, and the developer's config, identity, signing and hooks never apply. Identity comes only from
// GIT_AUTHOR_* and GIT_COMMITTER_*; no fixture writes user.* or global or system config.
//
// What this cannot stop: a test that writes git metadata by hand through fs (a .git file, a commondir, a config, a ref
// or an objects directory that leads elsewhere) can still aim git outside the root, between a check and the git call or
// where git follows what the checks do not read. The canary (canary.ts) guards the real repository against that.

import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
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

// What a repository's .git entry is when FixtureGit made it: a directory (a work tree's repository), none (a bare
// repository, its own git directory), or a file naming a git directory inside the root (a worktree, a submodule).
type Kind = "repository" | "bare" | "worktree";

const KINDS: Readonly<Record<Kind, string>> = {
  repository: "a work tree with a .git directory",
  bare: "a bare repository, with no .git entry",
  worktree: "a worktree whose .git file names a git directory",
};

// What a FixtureRepo reaches of its FixtureGit.
type Runner = {
  root: string;
  // The path of a name in the root, checked to resolve inside it.
  path(name: string): Promise<string>;
  // The same, for a name that must not exist yet: where git is to make a repository or worktree.
  fresh(name: string): Promise<string>;
  // A repository git made at a name, recorded with its kind.
  made(name: string, kind: Kind): FixtureRepo;
  // Each repository checked (FixtureGit.#check), then git in the first one with the arguments args makes of their
  // directories.
  git(repos: readonly FixtureRepo[], args: (dirs: string[]) => string[]): Promise<string>;
  // The same, null where git fails (not where a check does).
  gitOrNull(repos: readonly FixtureRepo[], args: (dirs: string[]) => string[]): Promise<string | null>;
};

export class FixtureGit {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly #noHooks: string;
  // The URL the isolated config rewrites to the repository at each name: a clone of that repository takes it as its
  // origin, as a host's clone has the GitHub URL.
  readonly #urls: ReadonlyMap<string, string>;
  // The repositories this fixture made, or was given by repo(), by name, with their kinds.
  readonly #made = new Map<string, Kind>();
  readonly #runner: Runner;

  private constructor(root: string, rewrites: Readonly<Record<string, string>>) {
    this.root = root;
    this.env = gitEnv(root);
    this.#noHooks = join(root, "no-hooks");
    this.#urls = new Map(Object.entries(rewrites).map(([url, name]) => [normalize(name), url]));
    this.#runner = {
      root,
      path: async (name) => this.#path(name),
      fresh: async (name) => this.#fresh(name),
      made: (name, kind) => this.#record(name, kind),
      git: async (repos, args) => {
        const dirs = await this.#check(repos);
        return this.#git(dirs[0] ?? this.root, args(dirs));
      },
      gitOrNull: async (repos, args) => {
        const dirs = await this.#check(repos);
        return this.#git(dirs[0] ?? this.root, args(dirs)).catch(() => null);
      },
    };
  }

  // The isolated global config, in a root from fixtureRoot: no signing, hooks from an empty directory, and a URL
  // rewritten to the repository a name in the root holds (url: name).
  static async create(root: string, rewrites: Readonly<Record<string, string>> = {}): Promise<FixtureGit> {
    const fixture = new FixtureGit(root, rewrites);
    const urls = await Promise.all(
      Object.entries(rewrites).map(async ([url, name]) => [
        `[url "file://${await fixture.#path(name)}"]`,
        `\tinsteadOf = ${url}`,
      ]),
    );
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
      ...urls.flat(),
      "",
    ];
    await writeFile(join(root, "gitconfig"), config.join("\n"));
    return fixture;
  }

  // The repository at a name: one this fixture made, else a worktree another program made there (prq's), expected to
  // have a .git file naming a git directory inside the root. Checked as each operation runs.
  repo(name: string): FixtureRepo {
    return this.#record(name, this.#made.get(normalize(name)) ?? "worktree");
  }

  // A new repository at a name that does not exist yet, checked to be its own: its top level (a bare one's git
  // directory) is there.
  async init(name: string, { bare = false } = {}): Promise<FixtureRepo> {
    const path = await this.#fresh(name);
    await this.#git(this.root, ["init", "--quiet", ...(bare ? ["--bare"] : []), "--end-of-options", path]);
    await this.#assertOwnRepository(path, bare);
    return this.#record(name, bare ? "bare" : "repository");
  }

  // A clone of from at a name that does not exist yet, checked the same way. Its origin is then the URL the isolated
  // config rewrites to from, if there is one, as a host's clone has the GitHub URL.
  async clone(from: FixtureRepo, name: string): Promise<FixtureRepo> {
    const path = await this.#fresh(name);
    const [source = ""] = await this.#check([from]);
    await this.#git(this.root, ["clone", "--quiet", "--end-of-options", source, path]);
    await this.#assertOwnRepository(path, false);
    const clone = this.#record(name, "repository");
    const url = this.#urls.get(from.name);
    if (url !== undefined) {
      const [dir = ""] = await this.#check([clone]);
      await this.#git(dir, ["remote", "set-url", "--end-of-options", "origin", url]);
    }
    return clone;
  }

  // The variables the installed git lists as local to a repository.
  async localEnvVars(): Promise<string[]> {
    return (await this.#git(this.root, ["rev-parse", "--local-env-vars"])).split("\n");
  }

  // The one place git runs: in dir, already checked, with the fixture's environment and no hooks.
  async #git(dir: string, args: string[]): Promise<string> {
    const { stdout } = await run("git", ["-C", dir, "-c", `core.hooksPath=${this.#noHooks}`, ...args], {
      env: this.env,
    });
    return stdout.trim();
  }

  // The directories of repositories, each once its .git entry is checked to be of the kind recorded for it, and the
  // git directory and common directory git finds for it to be inside the root. Run before every git call on them.
  async #check(repos: readonly FixtureRepo[]): Promise<string[]> {
    const dirs: string[] = [];
    for (const repo of repos) {
      dirs.push(await this.#checkOne(repo));
    }
    return dirs;
  }

  async #checkOne(repo: FixtureRepo): Promise<string> {
    const kind = this.#made.get(repo.name);
    if (kind === undefined) {
      throw new Error(`${repo.name} is not a repository of this fixture`);
    }
    const dir = await this.#path(repo.name);
    const dotGit = join(dir, ".git");
    const entry = await lstat(dotGit).catch(() => null);
    const shaped = {
      repository: entry?.isDirectory() === true,
      bare: entry === null && (await lstat(dir)).isDirectory(),
      worktree: entry?.isFile() === true,
    }[kind];
    if (!shaped) {
      throw new Error(`${repo.name} is not ${KINDS[kind]}, as the fixture made it`);
    }
    if (kind === "worktree") {
      const named = /^gitdir: (.+)\n?$/.exec(await readFile(dotGit, "utf8"))?.[1] ?? "";
      const target = await this.#resolved(resolve(dir, named));
      if (named === "" || !this.#inside(target)) {
        throw new Error(`the .git file of ${repo.name} names ${target}, outside the fixture root ${this.root}`);
      }
    }
    const found = await this.#git(dir, [
      "rev-parse",
      "--path-format=absolute",
      "--absolute-git-dir",
      "--git-common-dir",
    ]);
    for (const location of found.split("\n")) {
      const resolved = await this.#resolved(location);
      if (!this.#inside(resolved)) {
        throw new Error(
          `git places a git directory of ${repo.name} at ${resolved}, outside the fixture root ${this.root}`,
        );
      }
    }
    return dir;
  }

  #record(name: string, kind: Kind): FixtureRepo {
    const key = normalize(name);
    this.#made.set(key, kind);
    return new FixtureRepo(this.#runner, key);
  }

  async #assertOwnRepository(path: string, bare: boolean): Promise<void> {
    const commonDir = await this.#git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const top = bare ? path : await this.#git(path, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    if (top !== path || commonDir !== (bare ? path : join(path, ".git"))) {
      throw new Error(`git at ${path} found the repository ${top} (${commonDir}), not its own`);
    }
  }

  // A name is a path relative to the root without .. segments; it is checked through the existing part of its path,
  // as the file system resolves it, to be inside the root.
  async #path(name: string): Promise<string> {
    if (isAbsolute(name) || name.split(sep).includes("..")) {
      throw new Error(`a fixture path is a name in the fixture root ${this.root}, not ${name}`);
    }
    const path = await this.#resolved(join(this.root, name));
    if (!this.#inside(path)) {
      throw new Error(
        `a fixture git command names ${name}, which resolves to ${path}, outside the fixture root ${this.root}`,
      );
    }
    return path;
  }

  async #fresh(name: string): Promise<string> {
    const path = await this.#path(name);
    const exists = await lstat(path).then(
      () => true,
      () => false,
    );
    if (exists) {
      throw new Error(`${name} already exists; the fixture makes a repository only at a new name`);
    }
    return path;
  }

  // A path as the file system resolves the part of it that exists.
  async #resolved(path: string): Promise<string> {
    let existing = path;
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
    return join(existing, rest);
  }

  #inside(path: string): boolean {
    return path === this.root || path.startsWith(`${this.root}${sep}`);
  }
}

// A repository at a name in a fixture root, and what the tests do with it in git. A name an operation takes for a path
// is in the fixture root (worktreeAdd's), or in the repository's work tree (add's files); another repository it reads
// or writes (push's, fetchPull's, submoduleAdd's) is a FixtureRepo, checked as this one is.
export class FixtureRepo {
  readonly name: string;
  // Its path, for the file system and the CLI under test.
  readonly path: string;
  readonly #fixture: Runner;

  constructor(fixture: Runner, name: string) {
    this.#fixture = fixture;
    this.name = name;
    this.path = join(fixture.root, name);
  }

  async #git(...args: string[]): Promise<string> {
    return this.#fixture.git([this], () => args);
  }

  // Reads.

  // Every ref with its commit.
  async refs(): Promise<string> {
    return this.#git("for-each-ref", "--format=%(refname) %(objectname)");
  }

  async headCommit(): Promise<string> {
    return this.#git("rev-parse", "--verify", "HEAD");
  }

  // The branch HEAD is on, null when it is detached.
  async branch(): Promise<string | null> {
    return this.#fixture.gitOrNull([this], () => ["symbolic-ref", "--quiet", "HEAD"]);
  }

  async gitDir(): Promise<string> {
    return this.#git("rev-parse", "--absolute-git-dir");
  }

  async configGet(key: string): Promise<string | null> {
    return this.#fixture.gitOrNull([this], () => ["config", "--get", "--end-of-options", key]);
  }

  // git status --porcelain --ignored; it refreshes the index's stat data.
  async status(): Promise<string> {
    return this.#git("status", "--porcelain", "--ignored");
  }

  async worktreeList(): Promise<string> {
    return this.#git("worktree", "list", "--porcelain");
  }

  // The paths of the worktrees the repository registers, its own first.
  async worktrees(): Promise<string[]> {
    return (await this.worktreeList())
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  }

  // Writes.

  // Stages files, names in the work tree.
  async add(...files: string[]): Promise<void> {
    for (const file of files) {
      await this.#fixture.path(join(this.name, file));
    }
    await this.#git("add", "--", ...files);
  }

  async commit(message: string, { allowEmpty = false } = {}): Promise<void> {
    await this.#git("commit", "--quiet", ...(allowEmpty ? ["--allow-empty"] : []), "-m", message);
  }

  async push(to: FixtureRepo, refspec: string, { force = false } = {}): Promise<void> {
    await this.#fixture.git([this, to], ([, target = ""]) => [
      "push",
      "--quiet",
      ...(force ? ["--force"] : []),
      "--end-of-options",
      target,
      refspec,
    ]);
  }

  async updateRef(ref: string, target: string): Promise<void> {
    await this.#git("update-ref", "--end-of-options", ref, target);
  }

  async tag(name: string, target: string): Promise<void> {
    await this.#git("tag", "--end-of-options", name, target);
  }

  // A key in the repository's own config. Not user.*, whose identity no fixture sets, nor core.worktree, which would
  // move the work tree out of the root.
  async configSet(key: string, value: string, { add = false } = {}): Promise<void> {
    if (/^(?:user\..*|core\.worktree)$/i.test(key)) {
      throw new Error(`a fixture may not set ${key}`);
    }
    await this.#git("config", ...(add ? ["--add"] : []), "--end-of-options", key, value);
  }

  // A remote at a GitHub URL, which no fixture fetches from.
  async remoteAdd(name: string, url: string): Promise<void> {
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:)/.test(url)) {
      throw new Error(`a fixture remote is a GitHub URL, not ${url}`);
    }
    await this.#git("remote", "add", "--end-of-options", name, url);
  }

  async remoteRename(from: string, to: string): Promise<void> {
    await this.#git("remote", "rename", "--end-of-options", from, to);
  }

  // The repository from, as a submodule at a name in the work tree that does not exist yet.
  async submoduleAdd(from: FixtureRepo, name: string): Promise<FixtureRepo> {
    const path = join(this.name, name);
    await this.#fixture.fresh(path);
    await this.#fixture.git([this, from], ([, source = ""]) => [
      "submodule",
      "--quiet",
      "add",
      "--",
      `file://${source}`,
      name,
    ]);
    return this.#fixture.made(path, "worktree");
  }

  // from's pull/<number>/head, into FETCH_HEAD.
  async fetchPull(from: FixtureRepo, number: number): Promise<void> {
    await this.#fixture.git([this, from], ([, source = ""]) => [
      "fetch",
      "--quiet",
      "--end-of-options",
      source,
      `pull/${number}/head`,
    ]);
  }

  async checkoutDetach(commit: string): Promise<void> {
    await this.#git("checkout", "--quiet", "--detach", "--end-of-options", commit);
  }

  async switchCreate(branch: string, commit: string): Promise<void> {
    await this.#git("switch", "--quiet", "-c", branch, "--end-of-options", commit);
  }

  async skipWorktree(file: string): Promise<void> {
    await this.#fixture.path(join(this.name, file));
    await this.#git("update-index", "--skip-worktree", "--end-of-options", file);
  }

  // A detached worktree of commit at a name in the root that does not exist yet.
  async worktreeAdd(name: string, commit = "HEAD"): Promise<FixtureRepo> {
    const path = await this.#fixture.fresh(name);
    await this.#git("worktree", "add", "--quiet", "--detach", "--end-of-options", path, commit);
    return this.#fixture.made(name, "worktree");
  }

  async worktreeRemove(worktree: FixtureRepo): Promise<void> {
    await this.#fixture.git([this, worktree], ([, path = ""]) => ["worktree", "remove", "--end-of-options", path]);
  }

  async worktreeLock(worktree: FixtureRepo): Promise<void> {
    await this.#fixture.git([this, worktree], ([, path = ""]) => ["worktree", "lock", "--end-of-options", path]);
  }
}

// Repositories for the checkout tests, in a root from fixtureRoot: a bare origin.git with main and the pull request's
// refs/pull/<n>/head, and the host's clone under a clone root as <owner>/<repo>, whose origin is the GitHub URL as a
// host's would be, rewritten to the bare repository by url.insteadOf in the isolated global config.
export type Repo = {
  fixture: FixtureGit;
  // What the CLI under test needs on top of gitEnv: the clone root.
  env: Record<string, string>;
  bare: FixtureRepo;
  clone: FixtureRepo;
  // The commit main points at, the pull request's base.
  base: string;
  // A commit on top of main holding the files and symlinks, made the pull request's head in origin.git.
  head(label: string, files?: Record<string, string>, symlinks?: Record<string, string>): Promise<string>;
};

export async function makeRepo(root: string, pr: PrRef): Promise<Repo> {
  const url = `https://github.com/${pr.owner}/${pr.repo}.git`;
  const fixture = await FixtureGit.create(root, { [url]: join("repos", "origin.git") });
  const bare = await fixture.init(join("repos", "origin.git"), { bare: true });
  const seed = await fixture.init(join("repos", "seed"));
  await writeFile(join(seed.path, "README.md"), "a widget\n");
  await seed.add("README.md");
  await seed.commit("base");
  await seed.push(bare, "HEAD:refs/heads/main");
  const base = await seed.headCommit();
  const clone = await fixture.clone(bare, join("repos", "roots", pr.owner, pr.repo));

  return {
    fixture,
    env: { PRQ_CLONE_ROOTS: join(root, "repos", "roots") },
    bare,
    clone,
    base,
    async head(label, files = {}, symlinks = {}) {
      await seed.checkoutDetach(base);
      await writeFile(join(seed.path, "change.txt"), `${label}\n`);
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(seed.path, path)), { recursive: true });
        await writeFile(join(seed.path, path), content);
      }
      for (const [path, target] of Object.entries(symlinks)) {
        await mkdir(dirname(join(seed.path, path)), { recursive: true });
        await symlink(target, join(seed.path, path));
      }
      await seed.add(".");
      await seed.commit(label);
      await seed.push(bare, `HEAD:refs/pull/${pr.number}/head`, { force: true });
      return seed.headCommit();
    },
  };
}

// A smudge filter that does not end in time, as a stalled Git LFS download would be: a shell waiting on a sleep it
// started, each writing its pid to pids. A stubborn one ignores SIGINT, SIGTERM and SIGHUP, its sleep too, so only
// SIGKILL ends them, and the shell writes the name of each of those signals it gets to signals. Both keep git's stderr
// open, as a filter's output is, unless quiet: then git's output closes as soon as git exits. Configured in the clone
// as the required filter "slow"; files, committed, make a checkout run it.
export async function slowFilter(
  repo: Repo,
  { stubborn = false, quiet = false } = {},
): Promise<{ files: Record<string, string>; pids: string; signals: string }> {
  const pids = join(repo.fixture.root, "filter-pids");
  const signals = join(repo.fixture.root, "filter-signals");
  const filter = join(repo.fixture.root, "slow-filter");
  const names = ["INT", "TERM", "HUP"];
  const script = [
    "#!/bin/sh",
    ...(stubborn ? [`trap '' ${names.join(" ")}`] : []),
    ...(quiet ? ["exec 2>/dev/null"] : []),
    `echo $$ >> '${pids}'`,
    "sleep 20 &",
    `echo $! >> '${pids}'`,
    ...(stubborn ? names.map((name) => `trap 'echo ${name} >> "${signals}"' ${name}`) : []),
    // A signal the shell traps ends a wait early.
    "while kill -0 $! 2>/dev/null; do wait $!; done",
    "cat",
    "",
  ];
  await writeFile(filter, script.join("\n"));
  await chmod(filter, 0o755);
  await repo.clone.configSet("filter.slow.smudge", filter);
  await repo.clone.configSet("filter.slow.required", "true");
  return { files: { ".gitattributes": "large.bin filter=slow\n", "large.bin": "pointer\n" }, pids, signals };
}

// The processes of a pids file that are still running.
export async function liveProcesses(pids: string): Promise<number[]> {
  const listed = (await readFile(pids, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
  return listed.map(Number).filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}
