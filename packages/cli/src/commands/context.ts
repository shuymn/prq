import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ContextRequest, ContextResponse } from "@prq/protocol";
import * as v from "valibot";

import { type Client, Refused } from "../client.ts";
import { type Context, readContext } from "../context.ts";
import { EXIT, type ExitCode } from "../errors.ts";
import { publishContext, type Published } from "../publish.ts";
import type { Claim, State } from "../state.ts";

// prq context: the claimed job's context, read page by page under the agent's record and published in the claim's
// directory, the job kind's prompt with it. When the claim no longer holds (409 stale_claim, or 404 unknown_job), exit
// 4 and claim again; the record stays for that claim to replace. Next is checkout when the job has a workspace, else
// answer.
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
  const { context: read, dir, published } = written;
  print({
    dir,
    pr: read.pr,
    details: read.details,
    job: read.job,
    messages: read.messages.length,
    context: published.context,
    question: published.question,
    prompt: published.prompt,
    answer: join(dir, "answer.md"),
    next: read.job.workspaceSha === null ? "answer" : "checkout",
  });
  return EXIT.ok;
}

// What context and checkout print when the claim no longer holds.
export const STALE = { status: "stale_claim", next: "claim" } as const;

// Reads the claim's context and publishes it in the claim's directory (publishContext): the job kind's prompt in a new
// set, an answer job's question as question.md, and context.json. null when the claim no longer holds. Nothing is read
// or written while jobs/ is a symlink (State.assertJobsDir).
export async function writeContext(
  client: Client,
  state: State,
  agentId: string,
  { job, claimId }: Claim,
): Promise<{ context: Context; dir: string; published: Published } | null> {
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
  const dir = state.jobDir(job);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return { context: read, dir, published: await publishContext(dir, read) };
}
