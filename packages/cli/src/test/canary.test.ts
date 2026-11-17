// The canary over a fixture repository in place of the real one: what it lets pass, and what fails the run.

import { chmod, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { guard } from "./canary.ts";
import { FixtureGit, fixtureRoot } from "./git.ts";

let root: string;
let fixture: FixtureGit;
let repo: string;

beforeEach(async () => {
  root = await fixtureRoot("prq-canary-");
  fixture = await FixtureGit.create(root);
  repo = join(root, "repo");
  await fixture.init(repo);
  await writeFile(join(repo, "README.md"), "a widget\n");
  await fixture.git(repo, "add", "README.md");
  await fixture.git(repo, "commit", "--quiet", "-m", "base");
  // A hooks directory the repository's config names, as lefthook's or a team's would be.
  await mkdir(join(root, "team-hooks"));
  await writeFile(join(root, "team-hooks", "pre-commit"), "#!/bin/sh\n");
  await fixture.git(repo, "config", "core.hooksPath", join(root, "team-hooks"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the canary", () => {
  it("passes what the tests do not do: a ref under refs/t3/ and an index whose stat data git status refreshed", async () => {
    const check = await guard(repo);
    await fixture.git(repo, "update-ref", "refs/t3/checkpoint", "HEAD");
    const readme = join(repo, "README.md");
    const { atime, mtime } = await stat(readme);
    await utimes(readme, atime, new Date(mtime.getTime() + 5_000));
    await fixture.git(repo, "status", "--porcelain");
    await expect(check()).resolves.toBeUndefined();
  });

  it.each([
    ["a branch", () => fixture.git(repo, "update-ref", "refs/heads/stray", "HEAD")],
    ["HEAD", () => fixture.git(repo, "checkout", "--quiet", "--detach", "HEAD")],
    ["a staged file", () => writeFile(join(repo, "new.txt"), "x").then(() => fixture.git(repo, "add", "new.txt"))],
    ["an index flag", () => fixture.git(repo, "update-index", "--skip-worktree", "README.md")],
    ["the config", () => fixture.git(repo, "config", "core.x", "y")],
    [
      "an executable hook in the default hooks directory",
      async () => {
        await writeFile(join(repo, ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
        await chmod(join(repo, ".git", "hooks", "post-checkout"), 0o755);
      },
    ],
    ["a hook's mode in the configured hooks directory", () => chmod(join(root, "team-hooks", "pre-commit"), 0o755)],
    ["a hook's bytes in the configured hooks directory", () => writeFile(join(root, "team-hooks", "pre-commit"), "x")],
    ["a registered worktree", () => fixture.git(repo, "worktree", "add", "--quiet", "--detach", join(root, "wt"))],
  ])("fails the run on %s", async (_, change) => {
    const check = await guard(repo);
    await change();
    await expect(check()).rejects.toThrow(/^the tests changed the repository /);
  });
});
