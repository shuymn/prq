import * as v from "valibot";

import { ContextInstructions } from "./instructions.ts";
import { MessageMetadata } from "./messages.ts";
import { AgentId, MessageId, PrDetails, PrRef, Sha } from "./pr.ts";

// The longest answer a submit carries, in UTF-16 code units. Stored as JSON, each unit takes at most 6 bytes (a
// `\u00XX` escape), so an answer stays under the Durable Object SQLite value limit (8 MB); it also bounds the history
// frames that carry it.
export const MAX_ANSWER_CHARS = 1_000_000;

// How long a route waits for a call to a Durable Object, the object's start included. An application budget, not a
// platform limit (a Worker may answer a connected client after any time): far above a start and a call, and short
// enough that the agent or the UI soon tries again. The CLI waits longer than each route's bound, so the route's own
// 503 arrives before the CLI gives up.
export const ROUTE_CALL_MS = 30_000;

// The longest a wait lasts; the agent then waits again.
export const WAIT_MAX_MS = 25_000;

// How long a wait asked for timeoutMs lasts at most.
export function waitBoundMs(timeoutMs: number | undefined): number {
  return Math.min(timeoutMs ?? WAIT_MAX_MS, WAIT_MAX_MS);
}

const Uuid = v.pipe(v.string(), v.uuid());

// What a job produces: the analysis of a head, or the answer to a question.
export const JobTarget = v.variant("kind", [
  v.object({ kind: v.literal("analysis"), headSha: Sha }),
  v.object({ kind: v.literal("answer"), messageId: MessageId }),
]);
export type JobTarget = v.InferOutput<typeof JobTarget>;

// The job's run: 1 at first, advanced each time the job goes back to waiting (the host retries it, or a push returns to
// its superseded head). A submit names the run its answer was produced under, and is accepted only while the job is
// still in that run.
const Run = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

// A job as a local agent receives it. workspaceSha is the commit to work at, fixed when the job was claimed: an
// analysis's head; for an answer the head of the latest completed analysis, else the current head, else null (no push
// seen yet). An answer's question is the message its target names, which the agent reads from the context's pages: a
// job carries no text of unbounded length, so a claim and each context page stay within an RPC call.
export const Job = v.object({
  jobId: Uuid,
  pr: PrRef,
  run: Run,
  target: JobTarget,
  workspaceSha: v.nullable(Sha),
});
export type Job = v.InferOutput<typeof Job>;

// /cli/wait: answers ready as soon as the agent may have work (its own claimed job, or a pending one), or timeout after
// timeoutMs, which the server caps. It never takes a job; claim does.
export const WaitRequest = v.object({
  agentId: AgentId,
  timeoutMs: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
});
export type WaitRequest = v.InferOutput<typeof WaitRequest>;

export const WaitResponse = v.object({ status: v.picklist(["ready", "timeout"]) });
export type WaitResponse = v.InferOutput<typeof WaitResponse>;

// /cli/claim: the agent's own claimed job first (resumed), then the next pending one.
export const ClaimRequest = v.object({ agentId: AgentId });
export type ClaimRequest = v.InferOutput<typeof ClaimRequest>;

// The answer to a claim: a job with the claim's ID, or none. resumed is true when the job was the agent's own claimed
// job, now under a new claimId.
export const ClaimResponse = v.union([
  v.object({ job: Job, claimId: Uuid, resumed: v.boolean() }),
  v.object({ job: v.null() }),
]);
export type ClaimResponse = v.InferOutput<typeof ClaimResponse>;

// /cli/submit: the answer to a claimed job, under the claim that holds it and the run it was produced under. pr is
// accepted in any case.
export const SubmitRequest = v.object({
  agentId: AgentId,
  pr: PrRef,
  jobId: Uuid,
  claimId: Uuid,
  run: Run,
  target: JobTarget,
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ANSWER_CHARS)),
});
export type SubmitRequest = v.InferOutput<typeof SubmitRequest>;

// The answer to an accepted submit: accepted when it added the message, duplicate when the same claim had already
// submitted it and nothing was added.
export const SubmitResponse = v.object({ status: v.picklist(["accepted", "duplicate"]), messageId: MessageId });
export type SubmitResponse = v.InferOutput<typeof SubmitResponse>;

// /cli/context: what a local agent works on its claimed job from, asked under the claim that holds it. pr is accepted in
// any case. cursor is the nextCursor of the page before; none for the first page.
export const ContextRequest = v.object({
  agentId: AgentId,
  pr: PrRef,
  jobId: Uuid,
  claimId: Uuid,
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(2048))),
});
export type ContextRequest = v.InferOutput<typeof ContextRequest>;

// A conversation message as a local agent reads it: its text, and the metadata of a message the server appended. A
// message too large for one page comes in parts, each in a page of its own: part says where its text starts in the
// message's text and how long the whole text is, and the agent joins the parts of one ID in order.
const ContextMessage = v.object({
  id: MessageId,
  role: v.picklist(["user", "assistant"]),
  text: v.string(),
  metadata: v.optional(MessageMetadata),
  part: v.optional(
    v.object({
      offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
      length: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    }),
  ),
});

// The answer to a context request: the canonical pull request, its details (null before its first webhook), the job as
// its claim fixed it (workspaceSha included), and one page of the conversation, oldest first. nextCursor asks for the
// next page; null when this page reached the end. The conversation is append-only, so a cursor stays valid while
// messages are added. The first page (no cursor) also carries the host's instructions as the Hub held them when it was
// read; later pages carry none. The whole response, not only its messages, stays within the server's page budget.
export const ContextResponse = v.object({
  pr: PrRef,
  details: v.nullable(PrDetails),
  job: Job,
  instructions: v.optional(ContextInstructions),
  messages: v.array(ContextMessage),
  nextCursor: v.nullable(v.string()),
});
export type ContextResponse = v.InferOutput<typeof ContextResponse>;
