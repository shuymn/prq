// The fixture git's structure: what keeps a test's git off every repository but its fixtures. The victim of each case
// is a fixture of its own in another temporary root, so a check that failed would write only there.

import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FixtureGit, type FixtureRepo, fixtureRoot } from "./git.ts";

let root: string;
let outside: string;
let fixture: FixtureGit;
let repo: FixtureRepo;
let victim: FixtureRepo;

beforeEach(async () => {
  root = await fixtureRoot("prq-fixture-");
  outside = await fixtureRoot("prq-outside-");
  fixture = await FixtureGit.create(root);
  repo = await fixture.init("repo");
  await repo.commit("base", { allowEmpty: true });
  victim = await (await FixtureGit.create(outside)).init("victim");
  await victim.commit("victim", { allowEmpty: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

// What a write to the victim would change: its config, its refs, and the entries of its root.
async function victimState() {
  return {
    config: await readFile(join(victim.path, ".git", "config"), "utf8"),
    refs: await victim.refs(),
    entries: await readdir(outside),
  };
}

describe("FixtureGit", () => {
  it("takes paths as names in the fixture root, and refuses before git runs one that leads out of it", async () => {
    const before = await victimState();
    // A symlink in the root to the other root, and a directory whose .git file names the victim's git directory.
    await symlink(outside, join(root, "out"));
    await mkdir(join(root, "gitfile"));
    await writeFile(join(root, "gitfile", ".git"), `gitdir: ${join(victim.path, ".git")}\n`);

    const fresh = join(outside, "fresh");
    await expect(fixture.init(fresh)).rejects.toThrow(/is a name in the fixture root/);
    await expect(fixture.init(relative(root, fresh))).rejects.toThrow(/is a name in the fixture root/);
    await expect(fixture.init("out/fresh")).rejects.toThrow(/outside the fixture root/);
    await expect(fixture.repo("out/victim").configSet("core.x", "y")).rejects.toThrow(/outside the fixture root/);
    await expect(fixture.repo("gitfile").configSet("core.x", "y")).rejects.toThrow(/outside the fixture root/);
    await expect(repo.worktreeAdd("out/worktree")).rejects.toThrow(/outside the fixture root/);
    await expect(repo.push(fixture.repo("out/victim"), "HEAD:refs/heads/stray")).rejects.toThrow(
      /outside the fixture root/,
    );
    await expect(repo.submoduleAdd(fixture.repo("out/victim"), "lib")).rejects.toThrow(/outside the fixture root/);
    await expect(fixture.clone(`file://${victim.path}`, "copy")).rejects.toThrow(/clones only a URL/);
    await expect(repo.remoteAdd("victim", victim.path)).rejects.toThrow(/is a GitHub URL/);
    await expect(repo.configSet("user.name", "x")).rejects.toThrow(/may not set/);
    await expect(repo.configSet("core.worktree", victim.path)).rejects.toThrow(/may not set/);

    expect(await victimState()).toEqual(before);
    expect(await repo.configGet("user.name")).toBeNull();
    expect(await repo.worktrees()).toEqual([repo.path]);
  });

  it("has no free-form git: neither config -f<path> nor config --file <symlink> can be written", async () => {
    const before = await victimState();
    const victimConfig = join(victim.path, ".git", "config");
    await symlink(victimConfig, join(repo.path, "x"));

    // No method takes git's arguments.
    expect(() =>
      // @ts-expect-error -- FixtureGit runs no git a test writes.
      fixture.git(repo.path, "config", `-f${victimConfig}`, "core.x", "y"),
    ).toThrow(TypeError);
    expect(() =>
      // @ts-expect-error -- nor does FixtureRepo.
      repo.git("config", "--file", "x", "core.x", "y"),
    ).toThrow(TypeError);
    // The nearest a test comes: the forms as configSet's key, which git takes after --end-of-options as a key, and
    // refuses; and a config write, which goes to the repository's own config whatever its work tree holds.
    await expect(repo.configSet(`-f${victimConfig}`, "y")).rejects.toThrow(/invalid key/);
    await expect(repo.configSet("--file", "x")).rejects.toThrow(/key does not contain a section: --file/);
    await repo.configSet("core.x", "y");

    expect(await victimState()).toEqual(before);
    expect(await repo.configGet("core.x")).toBe("y");
    expect((await lstat(join(repo.path, "x"))).isSymbolicLink()).toBe(true);
  });

  it("runs git with none of the test process's variables, GIT_DIR and GIT_INDEX_FILE included", async () => {
    const decoy = await fixture.init("decoy");
    vi.stubEnv("GIT_DIR", join(decoy.path, ".git"));
    vi.stubEnv("GIT_INDEX_FILE", join(decoy.path, ".git", "index"));
    vi.stubEnv("GIT_WORK_TREE", decoy.path);
    expect(await repo.gitDir()).toBe(join(repo.path, ".git"));
  });

  it("refuses a fixture root inside a repository", async () => {
    await mkdir(join(repo.path, "tmp"));
    vi.stubEnv("TMPDIR", join(repo.path, "tmp"));
    await expect(fixtureRoot("prq-nested-")).rejects.toThrow(/is inside the repository/);
  });
});
