// What the operations scripts' tests put in place of the production settings, through their own entry (test-entry.ts),
// which sets it before a script's modules load: the stand-ins and shorter bounds. The production entries never set it,
// and refuse the variables a terminal could carry to the same effect (operations.ts, refuseOverrides).

import * as v from "valibot";

const Milliseconds = v.pipe(v.number(), v.integer(), v.minValue(1));

export const Fixture = v.strictObject({
  // The deploy directory, the program run in wrangler's place, and the repository's wrangler configuration.
  directory: v.optional(v.string()),
  wrangler: v.optional(v.string()),
  wranglerConfig: v.optional(v.string()),
  // The wait for wrangler and for an answer; the clone's steps and the upload; the rollout's poll and its end.
  waitMs: v.optional(Milliseconds),
  stepMs: v.optional(Milliseconds),
  pollMs: v.optional(Milliseconds),
  rolloutMs: v.optional(Milliseconds),
  // The Worker's origin for the idle check, and the API the deploy's own reads go to.
  origin: v.optional(v.string()),
  api: v.optional(v.string()),
  // What the stand-ins read of their environment, added to the one wrangler gets.
  childEnv: v.optional(v.record(v.string(), v.string())),
});

export const fixture: v.InferOutput<typeof Fixture> = {};
