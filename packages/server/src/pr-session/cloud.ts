import type { Job } from "@prq/protocol";

// The cloud agent of a cloud-owned session. The session hands it the next waiting job in the step that marks the job
// running under a new turn, at most one at a time; the turn is live in this isolate until the agent ends it.
export interface CloudAgent {
  // Takes over a job that has just become running under turnId. Synchronous: it begins, schedules or records the turn,
  // and never waits for it, since the hand-over can run inside another chat turn.
  start(job: Job, turnId: string): void;
}

// The reason a cloud job fails while no cloud agent is configured.
export const CLOUD_NOT_CONFIGURED = "cloud agent not configured";

// The start of the reason a cloud job fails while the cloud agent's configuration is invalid; the variables follow.
export const CLOUD_MISCONFIGURED = "cloud agent misconfigured";

// The code a cloud job with a workspace commit reads: the workspace at that commit.
export type Workspace = { sha: string };

// The reason a job with a workspace commit fails when no workspace can be had: a result is never produced without the
// code it is about.
export const WORKSPACE_NOT_AVAILABLE = "workspace: not available";

// How many times a run's turn starts before an interruption fails it: the first start and two restarts, which cover a
// deploy or an eviction, while a turn that stops the object every time (one that runs it out of memory) ends.
export const MAX_STARTS = 3;

// The reason a run fails after its turn was interrupted on every start it was given.
export const TURN_INTERRUPTED = `the turn was interrupted ${MAX_STARTS} times by restarts; retry to run it again`;
