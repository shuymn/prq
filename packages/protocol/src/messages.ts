import * as v from "valibot";

import { AgentId, MessageId, Sha } from "./pr.ts";

// Who added a server message: a local agent by its ID, or the cloud agent by the model it ran.
const Author = v.variant("kind", [
  v.object({ kind: v.literal("local"), agentId: AgentId }),
  v.object({ kind: v.literal("cloud"), model: v.pipe(v.string(), v.minLength(1), v.maxLength(256)) }),
]);

const Tokens = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

// What a cloud result's run used, summed over its model calls.
const Usage = v.object({ inputTokens: Tokens, outputTokens: Tokens, cachedInputTokens: Tokens });

// A cloud turn's text kept after the turn failed, with why it is incomplete.
const Incomplete = v.object({ reason: v.pipe(v.string(), v.maxLength(1000)) });

// The metadata of a message the server appends; questions from the UI carry none. An answer names its job, the
// question it answers (the UI pairs them by it) and the commit it was written at (the job's workspaceSha). An analysis
// names its job and the head it summarizes. A cloud result also carries its usage, and a cloud turn's text kept after
// a failure is marked incomplete.
export const MessageMetadata = v.variant("kind", [
  v.object({
    kind: v.literal("answer"),
    jobId: v.string(),
    questionId: MessageId,
    sha: v.nullable(Sha),
    by: Author,
    usage: v.optional(Usage),
    incomplete: v.optional(Incomplete),
  }),
  v.object({
    kind: v.literal("analysis"),
    jobId: v.string(),
    headSha: Sha,
    by: Author,
    usage: v.optional(Usage),
    incomplete: v.optional(Incomplete),
  }),
]);
export type MessageMetadata = v.InferOutput<typeof MessageMetadata>;
