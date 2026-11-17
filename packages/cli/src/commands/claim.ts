import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ClaimRequest, ClaimResponse } from "@prq/protocol";
import * as v from "valibot";

import type { Client } from "../client.ts";
import { EXIT, type ExitCode } from "../errors.ts";
import { type Claim, type State, UnreadableRecord } from "../state.ts";

// What a claim gives the AI: no job, or the server's answer with the claim's directory, its answer file and whether an
// answer is saved there.
export type ClaimResult = { job: null } | (Claim & { dir: string; answer: string; saved: boolean });

// prq claim: the agent's own claimed job first (resumed), else the next waiting one, saved as the agent's record
// before it is printed.
export async function claim(
  client: Client,
  state: State,
  agentId: string,
  print: (result: object) => void,
  stderr: (line: string) => void,
): Promise<ExitCode> {
  const previous = await previousClaim(state, stderr);
  const result = await claimJob(client, state, agentId, previous, stderr);
  print({ ...result, next: claimNext(result) });
  return EXIT.ok;
}

// One claim, adopted as the agent's record: a job is saved as the record and its directory created; with no job the
// record is removed. A record replaced by a claim on another directory, or removed, ended that claim: its answer must
// not be submitted, which a stderr line says.
export async function claimJob(
  client: Client,
  state: State,
  agentId: string,
  previous: Claim | null,
  stderr: (line: string) => void,
): Promise<ClaimResult> {
  const response = await client.call("/cli/claim", v.parse(ClaimRequest, { agentId }), ClaimResponse);
  if (response.job === null) {
    await state.removeRecord();
    if (previous !== null) {
      stderr(ended(state, previous));
    }
    return { job: null };
  }
  await state.saveRecord(response);
  const dir = state.jobDir(response.job);
  // Created only after the record that names it is written.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (previous !== null && state.jobDir(previous.job) !== dir) {
    stderr(ended(state, previous));
  }
  const answer = join(dir, "answer.md");
  return { ...response, dir, answer, saved: await exists(answer) };
}

// The step after a claim: wait with no job; answer when an answer is saved in the claim's directory (a claim that
// resumed the same job, run and workspace), to be checked and finished before it is submitted; else context.
export function claimNext(result: ClaimResult): "wait" | "answer" | "context" {
  if (result.job === null) {
    return "wait";
  }
  return result.saved ? "answer" : "context";
}

// The record before this claim; an unreadable one is replaced.
async function previousClaim(state: State, stderr: (line: string) => void): Promise<Claim | null> {
  try {
    return await state.readRecord();
  } catch (error) {
    if (error instanceof UnreadableRecord) {
      stderr(`the claim record ${state.recordPath} is unreadable; replacing it`);
      return null;
    }
    throw error;
  }
}

function ended(state: State, previous: Claim): string {
  const { jobId, run } = previous.job;
  return `the claim on job ${jobId} (run ${run}) ended; do not submit the answer in ${state.jobDir(previous.job)}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
