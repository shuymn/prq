// The push `check:workspace --browser` delivers after its other steps (workspace.ts nextPush()): the Worker takes a
// synchronize only when it is later than the update it last took, in whole seconds as GitHub gives them.

import { expect, test } from "vitest";

import { nextPush } from "./workspace.ts";

test("moves the head to the base, from the head, a whole second after the pull request's update", () => {
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const pull = {
    head: { sha: head },
    base: { sha: base },
    updated_at: "2026-11-19T10:00:59Z",
    user: { login: "host" },
  };
  expect(nextPush(pull)).toEqual({ action: "synchronize", head: base, base, before: head, at: "2026-11-19T10:01:00Z" });
});
