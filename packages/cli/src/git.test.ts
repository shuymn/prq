import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REPOSITORY_VARIABLES } from "./git.ts";
import { FixtureGit, fixtureRoot } from "./test/git.ts";

let root: string;

beforeEach(async () => {
  root = await fixtureRoot("prq-git-");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Git", () => {
  it("drops every variable the installed git lists as local to a repository", async () => {
    const fixture = await FixtureGit.create(root);
    const listed = (await fixture.git(root, "rev-parse", "--local-env-vars")).split("\n");
    expect(listed.length).toBeGreaterThan(0);
    expect([...REPOSITORY_VARIABLES]).toEqual(expect.arrayContaining([...listed, "GIT_NAMESPACE"]));
  });
});
