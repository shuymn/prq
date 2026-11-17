import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { PrRef } from "@prq/protocol";

import { CliError, EXIT } from "./errors.ts";
import { GIT_LONG_MS, GIT_QUICK_MS, type Git } from "./git.ts";
import { matchingRemote } from "./remote.ts";

// The host's clone of a pull request's repository and the remote that names it.
export type Clone = { clone: string; remote: string };

// Where prq looks for the clone (docs/design.md, Local CLI): --clone, then the repository holding the working
// directory, then <root>/<owner>/<repo> and <root>/github.com/<owner>/<repo> for each root, the directory names matched
// without case. The first whose remote names the repository is the clone.
export type CloneSearch = { flag: string | undefined; cwd: string; roots: readonly string[] };

export async function findClone(git: Git, pr: PrRef, search: CloneSearch): Promise<Clone> {
  const candidates: { what: string; path: string | null }[] = [];
  if (search.flag !== undefined) {
    candidates.push({ what: "--clone", path: resolve(search.cwd, search.flag) });
  }
  candidates.push({ what: "the working directory", path: search.cwd });
  for (const root of search.roots) {
    for (const segments of [
      [pr.owner, pr.repo],
      ["github.com", pr.owner, pr.repo],
    ]) {
      candidates.push({ what: join(root, ...segments), path: await findDir(root, segments) });
    }
  }
  const tried: string[] = [];
  for (const { what, path } of candidates) {
    if (path === null) {
      tried.push(`${what} (missing)`);
      continue;
    }
    const clone = await mainWorktree(git, path);
    if (clone === null) {
      tried.push(`${what} (not a git repository)`);
      continue;
    }
    const remote = await remoteOf(git, clone, pr);
    if (remote === null) {
      tried.push(`${what} (no remote names ${pr.owner}/${pr.repo})`);
      continue;
    }
    return { clone, remote };
  }
  throw new CliError(
    EXIT.error,
    `no clone of ${pr.owner}/${pr.repo} found; tried ${tried.join(", ")}. Pass --clone <dir>, or set PRQ_CLONE_ROOTS ` +
      `to the directories that hold <owner>/<repo> clones`,
  );
}

// root/segments with each directory name matched without case: the exact name first. null when there is none.
async function findDir(root: string, segments: readonly string[]): Promise<string | null> {
  let dir = root;
  for (const segment of segments) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return null;
    }
    const name = names.includes(segment)
      ? segment
      : names.toSorted().find((entry) => entry.toLowerCase() === segment.toLowerCase());
    if (name === undefined) {
      return null;
    }
    dir = join(dir, name);
  }
  return dir;
}

// The main working tree of the repository holding path (its first listed worktree), or null outside a repository.
async function mainWorktree(git: Git, path: string): Promise<string | null> {
  const listed = await git.run(path, ["worktree", "list", "--porcelain"], GIT_QUICK_MS);
  const first = /^worktree (.+)$/m.exec(listed.stdout)?.[1];
  return listed.code === 0 && first !== undefined ? first : null;
}

// The clone's remote that names the repository, read from the remote URLs as configured.
export async function remoteOf(git: Git, clone: string, pr: PrRef): Promise<string | null> {
  const remotes = await git.run(clone, ["config", "--get-regexp", "^remote\\..*\\.url$"], GIT_QUICK_MS);
  return matchingRemote(remotes.stdout, pr);
}

// The fetch that leaves the host's clone as it was but for the objects it brings: no remote-tracking ref through a
// configured refspec (an empty --refmap), no FETCH_HEAD, no tags, no pruning, no submodules, no maintenance.
const FETCH = [
  "fetch",
  "--no-tags",
  "--no-write-fetch-head",
  "--refmap=",
  "--no-prune",
  "--no-recurse-submodules",
  "--no-auto-maintenance",
];

// Whether the clone has the commit, fetching each of refs from the remote in turn until it does. The last fetch's
// error is reported when none brings it.
export async function ensureCommit(
  git: Git,
  { clone, remote }: Clone,
  sha: string,
  refs: readonly string[],
): Promise<{ present: true } | { present: false; error: string }> {
  const present = async () => (await git.run(clone, ["cat-file", "-e", `${sha}^{commit}`], GIT_QUICK_MS)).code === 0;
  if (await present()) {
    return { present: true };
  }
  let error = "";
  for (const ref of refs) {
    const fetched = await git.run(clone, [...FETCH, remote, ref], GIT_LONG_MS);
    if (await present()) {
      return { present: true };
    }
    error = lastLine(fetched.stderr);
  }
  return { present: false, error };
}

// A path as the file system resolves it: through its existing parent when it does not exist itself.
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    try {
      return join(await realpath(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

// Whether the clone registers a worktree at exactly path, as the file system resolves path's directories (git lists
// the path it resolved when it added the worktree); a registration elsewhere that a symlink at path leads to is not it.
async function registered(git: Git, clone: string, path: string): Promise<boolean> {
  const listed = await git.run(clone, ["worktree", "list", "--porcelain"], GIT_QUICK_MS);
  if (listed.code !== 0) {
    return false;
  }
  const wanted = await canonical(path);
  return [...listed.stdout.matchAll(/^worktree (.+)$/gm)].some((match) => match[1] === wanted);
}

// The repository a directory's git belongs to: its common git directory, as the file system resolves it.
async function commonDir(git: Git, dir: string): Promise<string | null> {
  const found = await git.run(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], GIT_QUICK_MS);
  return found.code === 0 ? realpath(found.stdout.trim()).catch(() => null) : null;
}

// The clone, of those given, whose worktree the directory at path is: one that registers exactly path, and whose
// common git directory the directory's git uses. null when none.
export async function ownerOf(git: Git, clones: readonly string[], path: string): Promise<string | null> {
  const own = await commonDir(git, path);
  if (own === null) {
    return null;
  }
  for (const clone of clones) {
    if ((await registered(git, clone, path)) && own === (await commonDir(git, clone))) {
      return clone;
    }
  }
  return null;
}

// Removes what prq left at a worktree path, and only that: nothing there but a registration in one of the clones
// (its directory gone), or a directory that is one of the clones' worktrees (ownerOf). A symlink is never followed,
// and anything else is left as it is, with the reason.
export async function releaseWorktree(
  git: Git,
  clones: readonly string[],
  path: string,
): Promise<{ released: true } | { released: false; reason: string }> {
  const entry = await lstat(path).catch(() => null);
  let owners: readonly string[];
  if (entry === null) {
    owners = clones;
  } else if (entry.isSymbolicLink()) {
    return { released: false, reason: `${path} is a symlink, not followed` };
  } else if (!entry.isDirectory()) {
    return { released: false, reason: `${path} is not a directory` };
  } else {
    const owner = await ownerOf(git, clones, path);
    if (owner === null) {
      const of = clones.length === 0 ? "a clone checkout.json names" : clones.join(" or ");
      return { released: false, reason: `${path} is not a worktree of ${of}` };
    }
    owners = [owner];
  }
  for (const clone of owners) {
    if ((await registered(git, clone, path)) && !(await removeWorktree(git, clone, path))) {
      return { released: false, reason: `the worktree ${path} could not be removed from ${clone}` };
    }
  }
  return { released: true };
}

// Removes the worktree registered at exactly path, its directory gone or not, locked or not (a worktree add that was
// stopped leaves its lock); never a clone-wide prune. Whether the registration is gone.
export async function removeWorktree(git: Git, clone: string, path: string): Promise<boolean> {
  await git.run(clone, ["worktree", "remove", "--force", "--force", path], GIT_QUICK_MS);
  return !(await registered(git, clone, path));
}

// Adds a detached worktree at path. One that fails or does not finish in time is removed by its exact path, with
// whatever it left in the directory.
export async function addWorktree(
  git: Git,
  clone: string,
  path: string,
  sha: string,
  timeoutMs = GIT_LONG_MS,
): Promise<void> {
  try {
    const added = await git.run(clone, ["worktree", "add", "--detach", path, sha], timeoutMs);
    if (added.code !== 0) {
      throw new CliError(EXIT.error, `git worktree add failed: ${lastLine(added.stderr)}`);
    }
  } catch (error) {
    // The add's own failure is what the command reports, whatever the cleanup meets.
    await removeWorktree(git, clone, path).catch(() => false);
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

// Whether path is a directory, not following a symlink at it.
export async function isDirectory(path: string): Promise<boolean> {
  return lstat(path).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
}

// Whether path is dir or inside it, as the file system resolves both.
export async function within(path: string, dir: string): Promise<boolean> {
  const [inner, outer] = await Promise.all([canonical(path), canonical(dir)]);
  return inner === outer || inner.startsWith(`${outer}${sep}`);
}

function lastLine(text: string): string {
  return (
    text
      .trim()
      .split("\n")
      .at(-1)
      ?.replaceAll(/[^\x20-\x7e]/g, "?")
      .slice(0, 200) ?? ""
  );
}
