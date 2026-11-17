import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ContextRequest, ContextResponse } from "@prq/protocol";
import * as v from "valibot";

import { type Client, Refused } from "../client.ts";
import { type Context, questionOf, readContext } from "../context.ts";
import { EXIT, type ExitCode } from "../errors.ts";
import { type Claim, type State, writeAtomically } from "../state.ts";

// prq context: the claimed job's context, read page by page under the agent's record and written into the claim's
// directory. When the claim no longer holds (409 stale_claim, or 404 unknown_job), exit 4 and claim again; the record
// stays for that claim to replace. Next is checkout when the job has a workspace, else answer.
export async function context(
  client: Client,
  state: State,
  agentId: string,
  print: (result: object) => void,
): Promise<ExitCode> {
  const written = await writeContext(client, state, agentId, await state.claimed());
  if (written === null) {
    print(STALE);
    return EXIT.mismatch;
  }
  const { context: read, dir, contextPath, questionPath } = written;
  print({
    dir,
    pr: read.pr,
    details: read.details,
    job: read.job,
    messages: read.messages.length,
    context: contextPath,
    question: questionPath,
    answer: join(dir, "answer.md"),
    next: read.job.workspaceSha === null ? "answer" : "checkout",
  });
  return EXIT.ok;
}

// What context and checkout print when the claim no longer holds.
export const STALE = { status: "stale_claim", next: "claim" } as const;

// Reads the claim's context and writes it into the claim's directory: context.json, and an answer job's question as
// question.md. null when the claim no longer holds. Nothing is read or written while jobs/ is a symlink
// (State.assertJobsDir).
export async function writeContext(
  client: Client,
  state: State,
  agentId: string,
  { job, claimId }: Claim,
): Promise<{ context: Context; dir: string; contextPath: string; questionPath: string | null } | null> {
  await state.assertJobsDir();
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
    return null;
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
  return { context: read, dir, contextPath, questionPath };
}
