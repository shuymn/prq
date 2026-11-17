import { join } from "node:path";

import { type ErrorCode, SubmitRequest, SubmitResponse } from "@prq/protocol";
import * as v from "valibot";

import { readAnswer } from "../answer.ts";
import { type Client, Refused } from "../client.ts";
import { EXIT, type ExitCode } from "../errors.ts";
import type { Claim, State } from "../state.ts";
import { claimJob, claimNext, type ClaimResult } from "./claim.ts";

// The refusals that say the claim no longer holds the job: the answer is dropped, not retried.
const MISMATCHES: readonly ErrorCode[] = ["stale_claim", "unknown_job", "target_mismatch"];

// prq submit: the answer saved in the record's directory, sent under the record's claim and the run it was produced
// under (docs/design.md, Owner and jobs). Accepted or duplicate: the record is removed, exit 0. On 409 stale_claim
// the agent claims once, and the claim becomes the record. Only when it returns the same job in the same run at the
// same workspace is the answer sent again, under the new claimId; when only the workspace moved, the answer is
// dropped and the claim kept, since a resume re-fixes the workspace and the stored answer would be labelled with the
// new one. Any other outcome drops the answer too, exit 4 with the claim to work on.
export async function submit(
  client: Client,
  state: State,
  agentId: string,
  print: (result: object) => void,
  stderr: (line: string) => void,
): Promise<ExitCode> {
  const record = await state.claimed();
  const text = await readAnswer(join(state.jobDir(record.job), "answer.md"));
  const dropped = (reason: string, claimed: ClaimResult): ExitCode => {
    print({ status: "dropped", reason, claim: claimed.job === null ? null : claimed, next: claimNext(claimed) });
    return EXIT.mismatch;
  };

  let outcome = await send(client, agentId, record, record.claimId, text);
  if (outcome === "stale_claim") {
    const claimed = await claimJob(client, state, agentId, record, stderr);
    if (claimed.job === null || claimed.job.jobId !== record.job.jobId || claimed.job.run !== record.job.run) {
      return dropped("stale_claim", claimed);
    }
    if (claimed.job.workspaceSha !== record.job.workspaceSha) {
      return dropped("workspace_moved", claimed);
    }
    outcome = await send(client, agentId, record, claimed.claimId, text);
    if (typeof outcome === "string") {
      return dropped(outcome, claimed);
    }
  } else if (typeof outcome === "string") {
    await state.removeRecord();
    return dropped(outcome, { job: null });
  }
  await state.removeRecord();
  print({ ...outcome, next: "wait" });
  return EXIT.ok;
}

// One submit of the answer under claimId, with the job, run and target of the claim it was produced under: the
// server's answer, or the code of a refusal that says the claim no longer holds.
async function send(
  client: Client,
  agentId: string,
  record: Claim,
  claimId: string,
  text: string,
): Promise<SubmitResponse | ErrorCode> {
  const { jobId, pr, run, target } = record.job;
  const request = v.parse(SubmitRequest, { agentId, pr, jobId, claimId, run, target, text });
  try {
    return await client.call("/cli/submit", request, SubmitResponse);
  } catch (error) {
    if (error instanceof Refused && error.code !== null && MISMATCHES.includes(error.code)) {
      return error.code;
    }
    throw error;
  }
}
