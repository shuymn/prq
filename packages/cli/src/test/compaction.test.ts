import { describe, expect, it } from "vitest";

import { startedAfterCompaction } from "./compaction.ts";

// How the compaction check (compaction.ts) decides that the questions asked during a compaction started after it
// ended, from log lines as the Worker's log prints them.

const STARTED =
  "{ event: 'prq.compaction.started', pr: 'acme~widgets~7', jobId: 'job-16', notesRev: 1, cutMessageId: 'answer-9', cutStep: 0, summarizedSteps: 22, turnPrefixSteps: 1 }";
const DONE =
  "{ event: 'prq.compaction.done', pr: 'acme~widgets~7', jobId: 'job-16', notesRev: 1, rev: 2, cutMessageId: 'answer-9', cutStep: 0, calls: 2 }";
const OTHER_DONE =
  "{ event: 'prq.compaction.done', pr: 'acme~widgets~7', jobId: 'job-4', notesRev: 0, rev: 1, cutMessageId: 'analysis-1', cutStep: 4, calls: 1 }";

function jobStarted(jobId: string): string {
  return `{ event: 'prq.job.started', pr: 'acme~widgets~7', jobId: '${jobId}', kind: 'answer', from: 'pending', to: 'running' }`;
}

describe("questions started after the compaction", () => {
  it("holds when the compaction's own end comes before both jobs' starts", () => {
    const lines = ["before", STARTED, DONE, jobStarted("job-q1"), jobStarted("job-q2")];

    expect(startedAfterCompaction(lines, 1, STARTED, ["job-q1", "job-q2"])).toEqual({
      doneAt: 2,
      startedAt: [3, 4],
      after: true,
    });
  });

  it.for([
    ["its end was not logged", [STARTED, jobStarted("job-q1"), jobStarted("job-q2")]],
    ["only another compaction's end was logged", [STARTED, OTHER_DONE, jobStarted("job-q1"), jobStarted("job-q2")]],
    ["a job started before its end", [STARTED, jobStarted("job-q1"), DONE, jobStarted("job-q2")]],
  ] as const)("does not hold when %s", ([, lines]) => {
    expect(startedAfterCompaction(lines, 0, STARTED, ["job-q1", "job-q2"]).after).toBe(false);
  });
});
