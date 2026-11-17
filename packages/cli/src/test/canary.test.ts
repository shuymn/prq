// The canary over a fixture repository in place of the real one: what it lets pass, and what fails the run.

import { chmod, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { guard } from "./canary.ts";
import { FixtureGit, type FixtureRepo, fixtureRoot } from "./git.ts";

let root: string;
let fixture: FixtureGit;
let repo: FixtureRepo;

beforeEach(async () => {
  root = await fixtureRoot("prq-canary-");
  fixture = await FixtureGit.create(root);
  repo = await fixture.init("repo");
  await writeFile(join(repo.path, "README.md"), "a widget\n");
  await repo.add("README.md");
  await repo.commit("base");
  // A hooks directory the repository's config names, as lefthook's or a team's would be.
  await mkdir(join(root, "team-hooks"));
  await writeFile(join(root, "team-hooks", "pre-commit"), "#!/bin/sh\n");
  await repo.configSet("core.hooksPath", join(root, "team-hooks"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the canary", () => {
  it("passes what the tests do not do: a ref under refs/t3/ and an index whose stat data git status refreshed", async () => {
    const check = await guard(repo.path);
    await repo.updateRef("refs/t3/checkpoint", "HEAD");
    const readme = join(repo.path, "README.md");
    const { atime, mtime } = await stat(readme);
    await utimes(readme, atime, new Date(mtime.getTime() + 5_000));
    await repo.status();
    await expect(check()).resolves.toBeUndefined();
  });

  it.each([
    ["a branch", () => repo.updateRef("refs/heads/stray", "HEAD")],
    ["HEAD", () => repo.checkoutDetach("HEAD")],
    ["a staged file", () => writeFile(join(repo.path, "new.txt"), "x").then(() => repo.add("new.txt"))],
    ["an index flag", () => repo.skipWorktree("README.md")],
    ["the config", () => repo.configSet("core.x", "y")],
    [
      "an executable hook in the default hooks directory",
      async () => {
        await writeFile(join(repo.path, ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
        await chmod(join(repo.path, ".git", "hooks", "post-checkout"), 0o755);
      },
    ],
    ["a hook's mode in the configured hooks directory", () => chmod(join(root, "team-hooks", "pre-commit"), 0o755)],
    ["a hook's bytes in the configured hooks directory", () => writeFile(join(root, "team-hooks", "pre-commit"), "x")],
    ["a registered worktree", () => repo.worktreeAdd("wt")],
  ])("fails the run on %s", async (_, change) => {
    const check = await guard(repo.path);
    await change();
    await expect(check()).rejects.toThrow(/^the tests changed the repository /);
  });
});
