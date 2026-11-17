import { ContextRequest, ContextResponse } from "@prq/protocol";
import * as v from "valibot";

import { cleanUp } from "../cleanup.ts";
import { type Client, Refused } from "../client.ts";
import { EXIT, type ExitCode } from "../errors.ts";
import { Git } from "../git.ts";
import { type Claim, type State, UnreadableRecord } from "../state.ts";
import { claimNext, type ClaimResult, describeClaim } from "./claim.ts";

// prq reconcile, at the start of a session: brings the local state in line with the server's (docs/design.md, Local
// CLI). The agent's record is checked with the first page of its context, which only reads (a claim would take new
// work). It holds: next is answer when an answer is saved in its directory, else context. 409 stale_claim: the claimId
// was replaced, by a retry or by a late claim of this agent that may have resumed the same run, so the record and its
// directory stay and the next claim tells which. 404 unknown_job: the record is removed. Then the job directories no
// record names are removed.
export async function reconcile(
  client: Client,
  state: State,
  agentId: string,
  cwd: string,
  print: (result: object) => void,
  stderr: (line: string) => void,
): Promise<ExitCode> {
  let claim: ClaimResult | null = null;
  let next: string;
  const record = await readRecord(state, stderr);
  if (record === "unreadable") {
    next = "claim";
  } else if (record === null) {
    next = "wait";
  } else {
    const held = await probe(client, agentId, record);
    if (held === "unknown_job") {
      await state.removeRecord();
      next = "wait";
    } else {
      claim = await describeClaim(state, record);
      next = held === "stale_claim" ? "claim" : claimNext(claim);
    }
  }
  const { removed, kept } = await cleanUp(state, await Git.create(state.hooksDir), agentId, cwd, stderr);
  print({ claim, removed, kept, next });
  return EXIT.ok;
}

// The record, or "unreadable": the next claim replaces it.
async function readRecord(state: State, stderr: (line: string) => void): Promise<Claim | null | "unreadable"> {
  try {
    return await state.readRecord();
  } catch (error) {
    if (error instanceof UnreadableRecord) {
      stderr(error.message);
      return "unreadable";
    }
    throw error;
  }
}

// Whether the claim holds, by the first page of its context.
async function probe(client: Client, agentId: string, { job, claimId }: Claim) {
  const request = v.parse(ContextRequest, { agentId, pr: job.pr, jobId: job.jobId, claimId });
  try {
    await client.call("/cli/context", request, ContextResponse);
    return "held";
  } catch (error) {
    if (error instanceof Refused && (error.code === "stale_claim" || error.code === "unknown_job")) {
      return error.code;
    }
    throw error;
  }
}
