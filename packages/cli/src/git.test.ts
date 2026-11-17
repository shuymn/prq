import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git, REPOSITORY_VARIABLES } from "./git.ts";
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
    const listed = await fixture.localEnvVars();
    expect(listed.length).toBeGreaterThan(0);
    expect([...REPOSITORY_VARIABLES]).toEqual(expect.arrayContaining([...listed, "GIT_NAMESPACE"]));
  });

  it("runs git with GIT_TERMINAL_PROMPT=0 and without the repository variables, whatever the environment says", async () => {
    // A program in git's place that prints what it was given.
    const fake = join(root, "env-git");
    await writeFile(fake, '#!/bin/sh\necho "${GIT_TERMINAL_PROMPT-unset} ${GIT_DIR-unset} ${GIT_INDEX_FILE-unset}"\n');
    await chmod(fake, 0o755);
    const env = {
      PATH: process.env["PATH"],
      GIT_TERMINAL_PROMPT: "1",
      GIT_DIR: "/elsewhere",
      GIT_INDEX_FILE: "/index",
    };
    const git = await Git.create(join(root, "hooks"), { binary: fake, env });
    expect((await git.run(root, ["status"], 5_000)).stdout).toBe("0 unset unset\n");
  });
});
