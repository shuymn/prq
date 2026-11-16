import type { Job } from "@prq/protocol";

// The cloud agent of a cloud-owned session (#5 implements it). The session hands it the next waiting job in the step
// that marks the job running, at most one at a time; how the turn runs and how the job ends is the agent's.
export interface CloudAgent {
  // Takes over a job that has just become running. Synchronous: it begins, schedules or records the turn.
  start(job: Job): void;
}

// The reason a cloud job fails while no cloud agent is configured.
export const CLOUD_NOT_CONFIGURED = "cloud agent not configured";
