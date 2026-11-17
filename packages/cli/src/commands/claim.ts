import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ClaimRequest, ClaimResponse } from "@prq/protocol";
import * as v from "valibot";

import type { Client } from "../client.ts";
import { EXIT, type ExitCode } from "../errors.ts";
import { type Claim, type State, UnreadableRecord } from "../state.ts";

// prq claim: the agent's own claimed job first (resumed), else the next waiting one, saved as the agent's record
// before it is printed. The output names the claim's directory and its answer file; next is answer when an answer is
// saved there (a claim that resumed the same job, run and workspace), else context. With no job the record is removed.
// A record replaced by a claim on another directory, or removed, ended that claim: its answer must not be submitted.
export async function claim(
  client: Client,
  state: State,
  agentId: string,
  print: (result: object) => void,
  stderr: (line: string) => void,
): Promise<ExitCode> {
  const previous = await previousClaim(state, stderr);
  const response = await client.call("/cli/claim", v.parse(ClaimRequest, { agentId }), ClaimResponse);
  if (response.job === null) {
    await state.removeRecord();
    if (previous !== null) {
      stderr(ended(state, previous));
    }
    print({ job: null, next: "wait" });
    return EXIT.ok;
  }
  await state.saveRecord(response);
  const dir = state.jobDir(response.job);
  // Created only after the record that names it is written.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (previous !== null && state.jobDir(previous.job) !== dir) {
    stderr(ended(state, previous));
  }
  const answer = join(dir, "answer.md");
  const saved = await exists(answer);
  print({ ...response, dir, answer, saved, next: saved ? "answer" : "context" });
  return EXIT.ok;
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
