import { lstat, readdir, rm, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { Sha } from "@prq/protocol";
import * as v from "valibot";

import type { Git } from "./git.ts";
import { isMissing, JOB_DIR_NAME, readJson, type State } from "./state.ts";
import { registered, removeWorktree, within } from "./worktree.ts";

// What prq checkout records before it adds a job directory's worktree: the clone that registers it.
const CheckoutRecord = v.object({ clone: v.pipe(v.string(), v.check(isAbsolute)), sha: Sha });

// A job directory's checkout.json, or null when there is none to use.
export async function readCheckout(dir: string): Promise<v.InferOutput<typeof CheckoutRecord> | null> {
  const parsed = v.safeParse(CheckoutRecord, await readJson(join(dir, "checkout.json")));
  return parsed.success ? parsed.output : null;
}

type Cleanup = {
  removed: string[];
  // The job directories other agents' records name.
  kept: { agentId: string; dir: string }[];
};

// Removes the job directories no agent's record names (docs/design.md, Local CLI): jobs/ is listed before the records
// are read, and a directory is created only after the record that names it, so a directory listed is never newer than
// a record that names it. Left alone: a directory that holds the working directory, an entry whose name is not a job
// directory's, and everything while a record is unreadable (it may name any of them). A symlink is unlinked, never
// followed. A directory's worktree is removed from its clone by its exact path first; one that cannot be is reported
// and its directory kept.
export async function cleanUp(state: State, git: Git, agentId: string, cwd: string, stderr: (line: string) => void) {
  const result: Cleanup = { removed: [], kept: [] };
  let entries: string[];
  try {
    entries = await readdir(state.jobsDir);
  } catch (error) {
    if (isMissing(error)) {
      return result;
    }
    throw error;
  }
  const { records, unreadable } = await state.allRecords();
  const named = new Map(records.map(({ agentId: owner, claim }) => [state.jobDir(claim.job), owner]));
  for (const path of unreadable) {
    stderr(`the claim record ${path} is unreadable; no job directory is removed until it is replaced`);
  }
  for (const name of entries.toSorted()) {
    const path = join(state.jobsDir, name);
    const owner = named.get(path);
    if (owner !== undefined) {
      if (owner !== agentId) {
        result.kept.push({ agentId: owner, dir: path });
      }
      continue;
    }
    if (unreadable.length > 0 || (await within(cwd, path))) {
      continue;
    }
    const entry = await lstat(path).catch(() => null);
    if (entry?.isSymbolicLink() === true) {
      await unlink(path);
      result.removed.push(path);
    } else if (
      entry?.isDirectory() === true &&
      JOB_DIR_NAME.test(name) &&
      (await removeJobWorktree(git, path, stderr))
    ) {
      await rm(path, { recursive: true, force: true });
      result.removed.push(path);
    }
  }
  return result;
}

// Removes a job directory's worktree from the clone checkout.json names, by its exact path. Whether the directory may
// go: there is no worktree registered there, or it was removed.
async function removeJobWorktree(git: Git, dir: string, stderr: (line: string) => void): Promise<boolean> {
  const checkout = await readCheckout(dir);
  if (checkout === null) {
    return true;
  }
  const { clone } = checkout;
  const worktree = join(dir, "worktree");
  try {
    if (!(await registered(git, clone, worktree)) || (await removeWorktree(git, clone, worktree))) {
      return true;
    }
  } catch {
    // Reported below, like a refusal.
  }
  stderr(`the worktree ${worktree} could not be removed from ${clone}; its job directory is kept`);
  return false;
}
