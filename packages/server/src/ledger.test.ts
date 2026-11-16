import type { Problem } from "@prq/protocol";
import { describe, expect, it } from "vitest";

import {
  claimReleasedAt,
  isPresent,
  type LedgerEntry,
  needsAttention,
  PRESENCE_MS,
  presenceEnd,
  problemOf,
  STALL_MS,
} from "./ledger.ts";

const QUIET: LedgerEntry = {
  details: null,
  owner: "local",
  latestEvent: null,
  summaryFailed: false,
  answerFailed: false,
  stalled: false,
  waitingWork: false,
  unsummarized: false,
  jobs: { waiting: 0, running: 0, failed: 0 },
  claims: [],
};

const FLAGS = ["summaryFailed", "answerFailed", "stalled", "waitingWork", "unsummarized"] as const;

// Every combination of the entry's flags, with and without a present agent.
const combinations = Array.from({ length: 2 ** (FLAGS.length + 1) }, (_, bits) => ({
  flags: Object.fromEntries(FLAGS.map((flag, index) => [flag, (bits & (1 << index)) !== 0])),
  present: (bits & (1 << FLAGS.length)) !== 0,
}));

describe("label order", () => {
  it("picks the first label that applies, in the design's order, for every combination", () => {
    for (const { flags, present } of combinations) {
      const entry = { ...QUIET, ...flags };
      // The design's list, read top to bottom.
      const applies: [Problem, boolean][] = [
        ["summary_failed", entry.summaryFailed],
        ["answer_failed", entry.answerFailed],
        ["possibly_stalled", entry.stalled],
        ["waiting_for_local_agent", entry.waitingWork && !present],
        ["new_push_not_summarized", entry.unsummarized],
      ];
      const expected = applies.find(([, applied]) => applied)?.[0] ?? null;
      expect({ flags, present, problem: problemOf(entry, present) }).toEqual({ flags, present, problem: expected });
    }
  });

  it("counts every label but New push not summarized toward Needs attention", () => {
    expect(
      (
        [
          "summary_failed",
          "answer_failed",
          "possibly_stalled",
          "waiting_for_local_agent",
          "new_push_not_summarized",
          null,
        ] as const
      ).map(needsAttention),
    ).toEqual([true, true, true, true, false, false]);
  });
});

describe("presence", () => {
  const at = 1_800_000_000_123;

  it("lasts PRESENCE_MS after the last contact, up to but not at its end", () => {
    const presence = { waiting: false, lastSeenAt: at, claimedAt: [] };
    expect(presenceEnd(presence)).toBe(at + PRESENCE_MS);
    expect(isPresent(presence, at + PRESENCE_MS - 1)).toBe(true);
    expect(isPresent(presence, at + PRESENCE_MS)).toBe(false);
  });

  it("lasts STALL_MS + PRESENCE_MS after a held claim, whatever the last contact", () => {
    const presence = { waiting: false, lastSeenAt: at - 5 * PRESENCE_MS, claimedAt: [at] };
    expect(presenceEnd(presence)).toBe(at + STALL_MS + PRESENCE_MS);
    expect(isPresent(presence, at + STALL_MS + PRESENCE_MS - 1)).toBe(true);
    expect(isPresent(presence, at + STALL_MS + PRESENCE_MS)).toBe(false);
    // The latest claim counts.
    expect(presenceEnd({ ...presence, claimedAt: [at - STALL_MS, at] })).toBe(at + STALL_MS + PRESENCE_MS);
  });

  it("never ends while the agent waits, and is not there with nothing known", () => {
    expect(isPresent({ waiting: true, lastSeenAt: null, claimedAt: [] }, at)).toBe(true);
    expect(isPresent({ waiting: false, lastSeenAt: null, claimedAt: [] }, Number.MIN_SAFE_INTEGER)).toBe(false);
  });

  it("ends PRESENCE_MS after a submit that ends the claim before STALL_MS, and does not come back for a later end", () => {
    const submitted = at + 30 * 60_000;
    const released = { waiting: false, lastSeenAt: claimReleasedAt(at, submitted), claimedAt: [] };
    expect(isPresent(released, submitted + PRESENCE_MS - 1)).toBe(true);
    expect(isPresent(released, submitted + PRESENCE_MS)).toBe(false);

    // A claim retried after STALL_MS stopped applying at STALL_MS: presence ended PRESENCE_MS after that.
    const late = at + STALL_MS + 2 * PRESENCE_MS;
    expect(claimReleasedAt(at, late)).toBe(at + STALL_MS);
    expect(isPresent({ waiting: false, lastSeenAt: claimReleasedAt(at, late), claimedAt: [] }, late)).toBe(false);
  });
});
