import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ContextRequest, ContextResponse } from "@prq/protocol";
import * as v from "valibot";

import { type Client, Refused } from "../client.ts";
import { questionOf, readContext } from "../context.ts";
import { EXIT, type ExitCode } from "../errors.ts";
import { type State, writeAtomically } from "../state.ts";

// prq context: the claimed job's context, read page by page under the agent's record and written into the claim's
// directory as context.json, with an answer job's question as question.md. When the claim no longer holds (409
// stale_claim, or 404 unknown_job), exit 4 and claim again; the record stays for that claim to replace.
export async function context(
  client: Client,
  state: State,
  agentId: string,
  print: (result: object) => void,
): Promise<ExitCode> {
  const { job, claimId } = await state.claimed();
  const read = await readContext(job.jobId, (cursor) => {
    const request = v.parse(ContextRequest, { agentId, pr: job.pr, jobId: job.jobId, claimId, cursor });
    return client.call("/cli/context", request, ContextResponse);
  }).catch((error: unknown) => {
    if (error instanceof Refused && (error.code === "stale_claim" || error.code === "unknown_job")) {
      return null;
    }
    throw error;
  });
  if (read === null) {
    print({ status: "stale_claim", next: "claim" });
    return EXIT.mismatch;
  }
  const question = questionOf(read);
  const dir = state.jobDir(job);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const contextPath = join(dir, "context.json");
  await writeAtomically(contextPath, `${JSON.stringify(read, null, 2)}\n`);
  let questionPath: string | null = null;
  if (question !== null) {
    questionPath = join(dir, "question.md");
    await writeAtomically(questionPath, question);
  }
  print({
    dir,
    pr: read.pr,
    details: read.details,
    job: read.job,
    messages: read.messages.length,
    context: contextPath,
    question: questionPath,
    answer: join(dir, "answer.md"),
    next: "answer",
  });
  return EXIT.ok;
}
