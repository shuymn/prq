import * as v from "valibot";

import { AgentId, MessageId, Sha } from "./pr.ts";

// Who added a server message. #5 adds the cloud agent.
const Author = v.object({ kind: v.literal("local"), agentId: AgentId });

// The metadata of a message the server appends; questions from the UI carry none. An answer names its job, the
// question it answers (the UI pairs them by it) and the commit it was written at (the job's workspaceSha). An analysis
// names its job and the head it summarizes.
export const MessageMetadata = v.variant("kind", [
  v.object({ kind: v.literal("answer"), jobId: v.string(), questionId: MessageId, sha: v.nullable(Sha), by: Author }),
  v.object({ kind: v.literal("analysis"), jobId: v.string(), headSha: Sha, by: Author }),
]);
export type MessageMetadata = v.InferOutput<typeof MessageMetadata>;
