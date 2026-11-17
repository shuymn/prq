import { rm } from "node:fs/promises";
import { join } from "node:path";

import { Job, PrDetails } from "@prq/protocol";
import * as v from "valibot";

import { cleanUp, readCheckout } from "../cleanup.ts";
import type { Client } from "../client.ts";
import { CliError, EXIT, type ExitCode } from "../errors.ts";
import { Git } from "../git.ts";
import { readJson, type State, writeAtomically } from "../state.ts";
import {
  addWorktree,
  type Clone,
  type CloneSearch,
  ensureCommit,
  findClone,
  isDirectory,
  registered,
  remoteOf,
  removeWorktree,
} from "../worktree.ts";
import { STALE, writeContext } from "./context.ts";

// What checkout reads of context.json: the job it was written for and the pull request's details.
const SavedContext = v.looseObject({ job: Job, details: v.nullable(PrDetails) });

// prq checkout: a detached worktree of the claimed job's workspace in the claim's directory, from the host's clone
// (docs/design.md, Local CLI). A job without a workspace needs none, and no git runs. The worktree's commit is fetched
// when the clone lacks it, pull/<n>/head first and then the commit itself, by a fetch that changes none of the clone's
// refs; so is the base, whose absence is only a notice. prq writes nothing inside the worktree. The job directories
// no record names are removed first, as reconcile does.
export async function checkout(
  client: Client,
  state: State,
  agentId: string,
  search: CloneSearch,
  print: (result: object) => void,
  stderr: (line: string) => void,
): Promise<ExitCode> {
  const claim = await state.claimed();
  const { job } = claim;
  const sha = job.workspaceSha;
  if (sha === null) {
    print({ path: null, sha: null, base: null, next: "answer" });
    return EXIT.ok;
  }
  const dir = state.jobDir(job);
  let details = await savedDetails(dir, job);
  if (details === undefined) {
    const written = await writeContext(client, state, agentId, claim);
    if (written === null) {
      print(STALE);
      return EXIT.mismatch;
    }
    details = written.context.details;
  }

  const git = await Git.create(state.hooksDir);
  await cleanUp(state, git, agentId, search.cwd, stderr);
  const path = join(dir, "worktree");
  let target = await reusable(git, dir, path, job);
  if (target === null) {
    target = await findClone(git, job.pr, search);
    const fetched = await ensureCommit(git, target, sha, [`pull/${job.pr.number}/head`, sha]);
    if (!fetched.present) {
      throw new CliError(
        EXIT.error,
        `the commit ${sha} is not in ${target.clone}, and fetching it from ${target.remote} failed: ${fetched.error}`,
      );
    }
    await replaceWorktree(git, dir, path, target.clone, sha);
  }

  let base = details?.baseSha ?? null;
  if (base !== null && !(await ensureCommit(git, target, base, [base])).present) {
    stderr(`the base ${base} could not be fetched from ${target.remote}; continuing without it`);
    base = null;
  }
  print({ path, sha, base, clone: target.clone, next: "answer" });
  return EXIT.ok;
}

// The details context.json holds when it was written for this job; undefined when it is missing or another's.
async function savedDetails(dir: string, job: Job): Promise<PrDetails | null | undefined> {
  const saved = v.safeParse(SavedContext, await readJson(join(dir, "context.json")));
  if (!saved.success || saved.output.job.jobId !== job.jobId || saved.output.job.workspaceSha !== job.workspaceSha) {
    return undefined;
  }
  return saved.output.details;
}

// The worktree an earlier checkout added for this directory, still registered in the clone checkout.json names: it is
// at the directory's commit by construction, and the AI may already be working in it.
async function reusable(git: Git, dir: string, path: string, job: Job): Promise<Clone | null> {
  const recorded = await readCheckout(dir);
  if (recorded === null || !(await isDirectory(path)) || !(await registered(git, recorded.clone, path))) {
    return null;
  }
  const remote = await remoteOf(git, recorded.clone, job.pr);
  return remote === null ? null : { clone: recorded.clone, remote };
}

// Adds the worktree at path, after removing what an earlier attempt left there: a registration, in the clone it was
// recorded with or in this one, and the files. checkout.json names the clone before the worktree exists, so a later
// cleanup finds the registration whatever happens in between.
async function replaceWorktree(git: Git, dir: string, path: string, clone: string, sha: string): Promise<void> {
  const recorded = await readCheckout(dir);
  for (const earlier of new Set([recorded?.clone ?? clone, clone])) {
    if ((await registered(git, earlier, path)) && !(await removeWorktree(git, earlier, path))) {
      throw new CliError(EXIT.error, `the worktree ${path} left by an earlier checkout could not be removed`);
    }
  }
  await rm(path, { recursive: true, force: true });
  await writeAtomically(join(dir, "checkout.json"), `${JSON.stringify({ clone, sha })}\n`);
  await addWorktree(git, clone, path, sha);
}
