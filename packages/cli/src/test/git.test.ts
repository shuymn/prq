// The fixture git's guards: what keeps a test's git off every repository but its fixtures. A refused command never
// runs git; the commands pointed at the package's own directory only read, so even a broken guard writes nothing there.

import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FixtureGit, fixtureRoot } from "./git.ts";

const PACKAGE = fileURLToPath(new URL("../..", import.meta.url));

let root: string;
let fixture: FixtureGit;

beforeEach(async () => {
  root = await fixtureRoot("prq-fixture-");
  fixture = await FixtureGit.create(root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("FixtureGit", () => {
  it("refuses a directory, path or option outside the fixture root, and identity or global config", async () => {
    await fixture.init(join(root, "repo"));
    const repo = join(root, "repo");
    await expect(fixture.git(PACKAGE, "rev-parse", "--show-toplevel")).rejects.toThrow(/outside the fixture root/);
    await expect(fixture.git(repo, "ls-remote", PACKAGE)).rejects.toThrow(/outside the fixture root/);
    await expect(fixture.git(repo, "fetch", `file://${PACKAGE}`)).rejects.toThrow(/outside the fixture root/);
    await expect(fixture.git(repo, `--git-dir=${PACKAGE}`, "rev-parse")).rejects.toThrow(/may not pass/);
    await expect(fixture.git(repo, "config", "user.name", "x")).rejects.toThrow(/may not run/);
    await expect(fixture.git(repo, "config", "--global", "core.editor", "x")).rejects.toThrow(/may not run/);
  });

  it("refuses, before git runs, a relative path or an option's path out of the root, and a config write after global options", async () => {
    // The victim is a fixture of its own, so a guard that failed would write only there.
    const outside = await fixtureRoot("prq-outside-");
    try {
      const victim = join(outside, "victim");
      await (await FixtureGit.create(outside)).init(victim);
      const config = await readFile(join(victim, ".git", "config"), "utf8");
      const repo = join(root, "repo");
      await fixture.init(repo);

      const fresh = join(outside, "fresh");
      await expect(fixture.git(repo, "init", "--quiet", relative(repo, fresh))).rejects.toThrow(
        /outside the fixture root/,
      );
      await expect(
        fixture.git(repo, "--no-pager", "config", `--file=${victim}/.git/config`, "user.name", "x"),
      ).rejects.toThrow(/outside the fixture root/);
      await expect(
        fixture.git(repo, "config", "--file", join(victim, ".git", "config"), "core.x", "y"),
      ).rejects.toThrow(/outside the fixture root/);
      await expect(fixture.git(repo, "--no-pager", "config", "user.name", "x")).rejects.toThrow(/may not run/);
      expect(
        await lstat(fresh).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(await readFile(join(victim, ".git", "config"), "utf8")).toBe(config);
      expect(await fixture.git(repo, "config", "--get", "user.name").catch(() => "unset")).toBe("unset");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("runs git with none of the test process's variables, GIT_DIR and GIT_INDEX_FILE included", async () => {
    const decoy = join(root, "decoy");
    const repo = join(root, "repo");
    await fixture.init(decoy);
    await fixture.init(repo);
    vi.stubEnv("GIT_DIR", join(decoy, ".git"));
    vi.stubEnv("GIT_INDEX_FILE", join(decoy, ".git", "index"));
    vi.stubEnv("GIT_WORK_TREE", decoy);
    expect(await fixture.git(repo, "rev-parse", "--absolute-git-dir")).toBe(join(repo, ".git"));
  });

  it("refuses a fixture root inside a repository", async () => {
    const repo = join(root, "repo");
    await fixture.init(repo);
    await mkdir(join(repo, "tmp"));
    vi.stubEnv("TMPDIR", join(repo, "tmp"));
    await expect(fixtureRoot("prq-nested-")).rejects.toThrow(/is inside the repository/);
  });
});
