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
  // The programs run in gh's place and in gh-infra's (in place of `mise exec -- gh-infra`), and the directory of the
  // setup's state file.
  gh: v.optional(v.string()),
  ghInfra: v.optional(v.string()),
  stateDir: v.optional(v.string()),
  // The wait for wrangler, gh, git and an answer; the clone's steps, the upload, gh-infra's apply, and what the owner
  // does in a browser during setup cloudflare; the rollout's and
  // the rehearsal's poll; the rollout's end; and the rehearsal's end.
  waitMs: v.optional(Milliseconds),
  stepMs: v.optional(Milliseconds),
  pollMs: v.optional(Milliseconds),
  rolloutMs: v.optional(Milliseconds),
  followMs: v.optional(Milliseconds),
  // The Worker's origin for the idle check, and the API the deploy's own reads and setup cloudflare's calls go to.
  origin: v.optional(v.string()),
  api: v.optional(v.string()),
  // How long a write to the deploy directory holds its temporary file before renaming it: the tests' window to stop
  // it there.
  holdMs: v.optional(Milliseconds),
  // The origin the setup's model step reads DeepSeek's models list from, in place of DeepSeek's API.
  modelApi: v.optional(v.string()),
  // The origins the setup's GitHub App step reaches in place of GitHub's REST API and its web pages (the manifest
  // form, the App's settings and installation pages), and the program run in place of the browser's opener.
  githubApi: v.optional(v.string()),
  githubWeb: v.optional(v.string()),
  open: v.optional(v.string()),
  // What the stand-ins read of their environment, added to the one wrangler gets.
  childEnv: v.optional(v.record(v.string(), v.string())),
});

export const fixture: v.InferOutput<typeof Fixture> = {};
