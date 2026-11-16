import { LatestEvent, LedgerRow, Owner, PrDetails, type Problem } from "@prq/protocol";
import * as v from "valibot";

// The ledger's rules, pure (docs/design.md, PR ledger and Presence): which problem a pull request's row shows, and
// whether a local agent counts as present. Times are epoch ms, all from one object's clock.

// A claim with no result this long after it is possibly stalled, and stops making its agent present.
export const STALL_MS = 60 * 60_000;
// An agent ID stays present this long after its last contact, and after its claim stops applying.
export const PRESENCE_MS = 10 * 60_000;

// What a session sends the Hub at one revision: the fields of its row the session knows, and what the Hub needs to
// pick its problem. summaryFailed: the current head's analysis failed and has not completed since. answerFailed: an
// answer job failed and has not completed since. stalled: a claimed job has had no result for STALL_MS. waitingWork:
// a local session has pending jobs. unsummarized: the current head is known and has no completed analysis. Each claim
// held in the session carries its time by the session's clock (since) and how long before the entry was made (ageMs:
// a duration, so the Hub can place the claim on its own clock).
export const LedgerEntry = v.object({
  details: v.nullable(PrDetails),
  owner: v.nullable(Owner),
  latestEvent: v.nullable(LatestEvent),
  summaryFailed: v.boolean(),
  answerFailed: v.boolean(),
  stalled: v.boolean(),
  waitingWork: v.boolean(),
  unsummarized: v.boolean(),
  jobs: LedgerRow.entries.jobs,
  claims: v.array(
    v.object({ agentId: v.string(), jobId: v.string(), since: v.number(), ageMs: v.pipe(v.number(), v.minValue(0)) }),
  ),
});
export type LedgerEntry = v.InferOutput<typeof LedgerEntry>;

// The first problem that applies, in the design's order. Only "Waiting for a local agent" depends on the Hub's own
// knowledge: whether a local agent is present.
export function problemOf(entry: LedgerEntry, localAgentPresent: boolean): Problem | null {
  if (entry.summaryFailed) {
    return "summary_failed";
  }
  if (entry.answerFailed) {
    return "answer_failed";
  }
  if (entry.stalled) {
    return "possibly_stalled";
  }
  if (entry.waitingWork && !localAgentPresent) {
    return "waiting_for_local_agent";
  }
  return entry.unsummarized ? "new_push_not_summarized" : null;
}

// Whether a row's problem counts toward "Needs attention": every label but "New push not summarized".
export function needsAttention(problem: Problem | null): boolean {
  return problem !== null && problem !== "new_push_not_summarized";
}

// An agent ID's presence as the Hub knows it, on the Hub's clock: whether it is in a wait, its last contact, and when
// each claim it holds was made.
export type Presence = { waiting: boolean; lastSeenAt: number | null; claimedAt: readonly number[] };

// When the agent stops being present unless something changes: never while it waits; otherwise PRESENCE_MS after its
// last contact or after its latest claim stops applying (STALL_MS after the claim), whichever is later. -Infinity
// when neither is known.
export function presenceEnd(presence: Presence): number {
  if (presence.waiting) {
    return Number.POSITIVE_INFINITY;
  }
  const contact = presence.lastSeenAt === null ? Number.NEGATIVE_INFINITY : presence.lastSeenAt + PRESENCE_MS;
  return Math.max(contact, ...presence.claimedAt.map((at) => at + STALL_MS + PRESENCE_MS));
}

export function isPresent(presence: Presence, now: number): boolean {
  return now < presenceEnd(presence);
}

// The time a claim made at claimedAt stopped applying when it ended at now (a submit or a retry): presence then lasts
// PRESENCE_MS from there, so a claim that ended after STALL_MS does not make its agent present again.
export function claimReleasedAt(claimedAt: number, now: number): number {
  return Math.min(now, claimedAt + STALL_MS);
}
