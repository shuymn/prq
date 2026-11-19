// The release check (release-check.ts) run as the package script runs it, in a host's clone whose origin is a GitHub
// URL that the fixture's git config rewrites to a bare repository in the OS temp directory, with a stand-in for gh that
// answers GitHub's check runs. Each refusal is one test; none pushes a tag anywhere but the fixture.

import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FixtureGit, type FixtureRepo, fixtureRoot } from "../../cli/src/test/git.ts";

const SCRIPT = fileURLToPath(new URL("release-check.ts", import.meta.url));
const REPOSITORY = "prq-test/prq";
const TAG = "v0.1.0";

// The stand-in for gh: it appends its arguments to FAKE_GH_LOG, then prints FAKE_GH_ANSWER, or fails with
// FAKE_GH_EXIT.
const FAKE_GH = `#!${process.execPath}
import { appendFileSync } from "node:fs";

appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.FAKE_GH_EXIT !== undefined) {
  console.error("gh: Not Found (HTTP 404)");
  process.exit(Number(process.env.FAKE_GH_EXIT));
}
process.stdout.write(process.env.FAKE_GH_ANSWER ?? "{}");
`;

type Run = { code: number | null; stdout: string; stderr: string };

// The script's exit code from execFile's error: null when it ended by a signal.
function exitCode(error: { code?: unknown } | null): number | null {
  if (error === null) {
    return 0;
  }
  return typeof error.code === "number" ? error.code : null;
}

async function packageVersion(path: string): Promise<string> {
  const text = await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  return v.parse(v.object({ version: v.string() }), JSON.parse(text)).version;
}

let bin: string;
let root: string;
let fixture: FixtureGit;
let origin: FixtureRepo;
let seed: FixtureRepo;
let env: Record<string, string>;

// GitHub's check runs for a commit: one run of Check by GitHub Actions, as given.
function checkRuns(commit: string, run: Record<string, unknown> = {}): string {
  return JSON.stringify({
    total_count: 1,
    check_runs: [
      {
        name: "Check",
        head_sha: commit,
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
        html_url: `https://github.com/${REPOSITORY}/actions/runs/1/job/2`,
        ...run,
      },
    ],
  });
}

// One stand-in for the file, run once here: macOS checks a new executable on its first run, which can take seconds.
beforeAll(async () => {
  bin = await fixtureRoot("prq-release-check-bin-");
  await writeFile(join(bin, "gh"), FAKE_GH, { mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    execFile(
      join(bin, "gh"),
      ["--version"],
      { env: { FAKE_GH_LOG: join(bin, "warm.jsonl") }, timeout: 60_000 },
      (error) => (error === null ? resolve() : reject(error)),
    );
  });
}, 90_000);

afterAll(async () => {
  await rm(bin, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await fixtureRoot("prq-release-check-");
  fixture = await FixtureGit.create(root, { [`https://github.com/${REPOSITORY}.git`]: "origin.git" });
  origin = await fixture.init("origin.git", { bare: true });
  seed = await fixture.init("seed");
  env = {
    ...fixture.env,
    PATH: `${bin}:${fixture.env["PATH"] ?? ""}`,
    FAKE_GH_LOG: join(root, "gh.jsonl"),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// A commit in the seed with the two packages' versions, on top of what it has.
async function release(server = "0.1.0", cli = server): Promise<string> {
  for (const [path, version] of [
    ["packages/server", server],
    ["packages/cli", cli],
  ] as const) {
    await mkdir(join(seed.path, path), { recursive: true });
    await writeFile(join(seed.path, path, "package.json"), `${JSON.stringify({ version }, null, 2)}\n`);
  }
  await seed.add("packages");
  await seed.commit(`chore(release): v${server}`, { allowEmpty: true });
  return seed.headCommit();
}

// The release commit on origin's main, tagged and pushed, and the host's clone of it.
async function released(tag = TAG): Promise<{ host: FixtureRepo; commit: string }> {
  const commit = await release();
  await seed.push(origin, "HEAD:refs/heads/main");
  await seed.tagAnnotated(tag, commit, `prq ${tag}`);
  await seed.push(origin, `refs/tags/${tag}`);
  return { host: await fixture.clone(origin, "host"), commit };
}

function check(cwd: string, args: string[], answer?: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { cwd, env: answer === undefined ? env : { ...env, FAKE_GH_ANSWER: answer }, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: exitCode(error), stdout, stderr }),
    );
  });
}

async function ghCalls(): Promise<string[][]> {
  const text = await readFile(join(root, "gh.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => v.parse(v.array(v.string()), JSON.parse(line)));
}

describe("release-check <tag>", () => {
  it("passes an annotated tag that origin has, at HEAD, on main, with both versions and a green Check", async () => {
    const { host, commit } = await released();

    const result = await check(host.path, ["--", TAG], checkRuns(commit));

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(`release-check: ${TAG} at ${commit} may be released\n`);
    expect(result.stdout).toContain("versions: packages/server/package.json and packages/cli/package.json are 0.1.0");
    expect(await ghCalls()).toEqual([["api", `repos/${REPOSITORY}/commits/${commit}/check-runs?check_name=Check`]]);
  });

  it("refuses unequal versions, naming the package", async () => {
    await release("0.1.0", "0.0.9");
    await seed.push(origin, "HEAD:refs/heads/main");
    const commit = await seed.headCommit();
    await seed.tagAnnotated(TAG, commit, `prq ${TAG}`);
    await seed.push(origin, `refs/tags/${TAG}`);
    const host = await fixture.clone(origin, "host");

    expect(await check(host.path, [TAG], checkRuns(commit))).toMatchObject({
      code: 1,
      stderr: "release-check: packages/cli/package.json has the version 0.0.9, not 0.1.0\n",
    });
  });

  it("refuses versions that are not the tag's", async () => {
    const { host, commit } = await released("v0.1.1");

    expect(await check(host.path, ["v0.1.1"], checkRuns(commit))).toMatchObject({
      code: 1,
      stderr:
        "release-check: packages/server/package.json has the version 0.1.0, not 0.1.1; " +
        "packages/cli/package.json has the version 0.1.0, not 0.1.1\n",
    });
  });

  it("refuses a tag that is not here", async () => {
    const { host, commit } = await released();

    expect(await check(host.path, ["v0.1.1"], checkRuns(commit))).toMatchObject({
      code: 1,
      stderr: "release-check: there is no tag v0.1.1 here\n",
    });
  });

  it("refuses a lightweight tag", async () => {
    const commit = await release();
    await seed.push(origin, "HEAD:refs/heads/main");
    await seed.tag(TAG, commit);
    await seed.push(origin, `refs/tags/${TAG}`);
    const host = await fixture.clone(origin, "host");

    expect(await check(host.path, [TAG], checkRuns(commit))).toMatchObject({
      code: 1,
      stderr: `release-check: ${TAG} is a lightweight tag: a release tag is annotated (git tag -a)\n`,
    });
  });

  it("refuses a tag origin does not have", async () => {
    const commit = await release();
    await seed.push(origin, "HEAD:refs/heads/main");
    const host = await fixture.clone(origin, "host");
    await host.tagAnnotated(TAG, commit, `prq ${TAG}`);

    expect(await check(host.path, [TAG], checkRuns(commit))).toMatchObject({
      code: 1,
      stderr: `release-check: origin has no tag ${TAG}: push it first\n`,
    });
  });

  it("refuses a tag whose object on origin is another", async () => {
    const { host, commit } = await released();
    await host.tagAnnotated(TAG, commit, `prq ${TAG}, again`, { force: true });

    const result = await check(host.path, [TAG], checkRuns(commit));

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`^release-check: origin's ${TAG} is the tag object [0-9a-f]{40}, not `));
  });

  it("refuses a HEAD that is not the tag's commit", async () => {
    const base = await release("0.0.0");
    const { host, commit } = await released();
    await host.checkoutDetach(base);

    expect(await check(host.path, [TAG], checkRuns(commit))).toMatchObject({
      code: 1,
      stderr: `release-check: HEAD is ${base}, not ${commit}, which ${TAG} tags\n`,
    });
  });

  it("refuses a commit that is not on origin's main", async () => {
    const main = await release("0.0.0");
    await seed.push(origin, "HEAD:refs/heads/main");
    await seed.switchCreate("side", main);
    const commit = await release();
    await seed.tagAnnotated(TAG, commit, `prq ${TAG}`);
    await seed.push(origin, `refs/tags/${TAG}`);
    const host = await fixture.clone(origin, "host");
    await host.checkoutDetach(commit);

    expect(await check(host.path, [TAG], checkRuns(commit))).toMatchObject({
      code: 1,
      stderr: `release-check: ${commit} is not on origin's main (${main})\n`,
    });
  });

  it.each([
    ["no Check run", (_commit: string) => JSON.stringify({ total_count: 0, check_runs: [] }), ""],
    ["a failed one", (commit: string) => checkRuns(commit, { conclusion: "failure" }), " (completed/failure)"],
    [
      "one in progress",
      (commit: string) => checkRuns(commit, { status: "in_progress", conclusion: null }),
      " (in_progress/null)",
    ],
    ["one of another app", (commit: string) => checkRuns(commit, { app: { slug: "someone-else" } }), ""],
    ["one of another commit", (commit: string) => checkRuns(commit, { head_sha: "f".repeat(40) }), ""],
  ])("refuses %s", async (_what, answer, seen) => {
    const { host, commit } = await released();

    expect(await check(host.path, [TAG], answer(commit))).toMatchObject({
      code: 1,
      stderr: `release-check: GitHub reports no successful Check run of GitHub Actions for ${commit}${seen}\n`,
    });
  });

  it("refuses when gh fails", async () => {
    const { host, commit } = await released();
    env["FAKE_GH_EXIT"] = "1";

    expect(await check(host.path, [TAG], checkRuns(commit))).toMatchObject({
      code: 1,
      stderr: "release-check: gh api failed (exit 1): gh: Not Found (HTTP 404)\n",
    });
  });

  it("prints its usage for anything but a release tag", async () => {
    const { host } = await released();

    for (const args of [[], ["0.1.0"], ["v0.1"], [TAG, "extra"], [TAG, "--pre-tag"]]) {
      expect(await check(host.path, args)).toMatchObject({
        code: 1,
        stderr: "release-check: usage: release-check <tag> [--pre-tag <sha>]\n",
      });
    }
    expect(await ghCalls()).toEqual([]);
  });

  it("runs with no installed dependency", async () => {
    const { host, commit } = await released();
    const alone = join(root, "alone");
    await mkdir(alone);
    await copyFile(SCRIPT, join(alone, "release-check.ts"));

    const result = await new Promise<Run>((resolve) => {
      execFile(
        process.execPath,
        [join(alone, "release-check.ts"), TAG],
        { cwd: host.path, env: { ...env, FAKE_GH_ANSWER: checkRuns(commit) }, timeout: 30_000 },
        (error, stdout, stderr) => resolve({ code: exitCode(error), stdout, stderr }),
      );
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
  });
});

describe("release-check <tag> --pre-tag <sha>", () => {
  it("passes the commit alone before the tag exists", async () => {
    const commit = await release();
    await seed.push(origin, "HEAD:refs/heads/main");
    const host = await fixture.clone(origin, "host");

    const result = await check(host.path, [TAG, "--pre-tag", commit], checkRuns(commit));

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(`tag: not checked before it exists; check ${TAG} again once it is pushed`);
  });

  it("refuses the commit's unequal versions", async () => {
    const commit = await release("0.1.0", "0.0.9");
    await seed.push(origin, "HEAD:refs/heads/main");
    const host = await fixture.clone(origin, "host");

    expect(await check(host.path, [TAG, "--pre-tag", commit], checkRuns(commit))).toMatchObject({
      code: 1,
      stderr: "release-check: packages/cli/package.json has the version 0.0.9, not 0.1.0\n",
    });
  });

  it("refuses a commit off origin's main, and one without a green Check", async () => {
    const main = await release("0.0.0");
    await seed.push(origin, "HEAD:refs/heads/main");
    const commit = await release();
    await seed.push(origin, "HEAD:refs/heads/side");
    const host = await fixture.clone(origin, "host");

    expect(await check(host.path, [TAG, "--pre-tag", commit], checkRuns(commit))).toMatchObject({
      code: 1,
      stderr: `release-check: ${commit} is not on origin's main (${main})\n`,
    });
    expect(await check(host.path, [TAG, "--pre-tag", main], checkRuns(main, { conclusion: "failure" }))).toMatchObject({
      code: 1,
    });
  });

  it("refuses what is not a full SHA, or not a commit here", async () => {
    const { host } = await released();

    expect(await check(host.path, [TAG, "--pre-tag", "abc123"])).toMatchObject({
      code: 1,
      stderr: "release-check: --pre-tag takes a commit's full SHA (40 hexadecimal digits)\n",
    });
    expect(await check(host.path, [TAG, "--pre-tag", "e".repeat(40)])).toMatchObject({
      code: 1,
      stderr: `release-check: ${"e".repeat(40)} is not a commit here: git fetch origin, then check again\n`,
    });
  });
});

describe("the repository's versions", () => {
  it("are one version for the Worker with its UI and for the CLI", async () => {
    expect(await packageVersion("../../cli/package.json")).toBe(await packageVersion("../package.json"));
  });
});
