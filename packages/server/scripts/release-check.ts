// The release check (`pnpm run release-check <tag> [--pre-tag <sha>]` in packages/server; docs/design.md, Versions):
// whether a commit may be released as <tag>, in the git repository it runs in, whose origin is the GitHub repository.
//
//   <tag>                  the tag is annotated, origin has the same tag object, it peels to HEAD (the commit being
//                          built), and that commit passes the checks below
//   <tag> --pre-tag <sha>  before the tag exists: the checks below for <sha> alone
//
// The checks of the commit: packages/server/package.json and packages/cli/package.json at it both have the tag's
// version (the tag without its v); it is on origin's main (an ancestor of what `git ls-remote` reports, which must be
// here); and GitHub reports a completed, successful `Check` run of GitHub Actions for that exact SHA (`gh api`, the
// latest run of that name).
//
// It uses only Node's built-ins, git and gh, so it runs before any install (the deploy runs it in its clone, and the
// release workflow on its checkout). Each git and gh call has a bound on its time; a signal to this process stops the
// call that runs and then ends this process as the signal would have.

import { type ChildProcess, execFile } from "node:child_process";

// A release tag: v and a SemVer version, a pre-release allowed (v0.2.0-rc.1), no build metadata.
export const TAG = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA = /^[0-9a-f]{40}$/;
const USAGE = "usage: release-check <tag> [--pre-tag <sha>]";
const PACKAGES = ["packages/server/package.json", "packages/cli/package.json"];
// GitHub's repository from origin's URL, as GitHub gives it for HTTPS and SSH.
const GITHUB =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
// How long one git or gh call is waited for.
const CALL_MS = 60_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

class Refusal extends Error {}

// A property of what JSON.parse gave, if it is an object.
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

type Result = { code: number; stdout: string; stderr: string };

const running = new Set<ChildProcess>();

function call(program: string, args: readonly string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      program,
      args,
      { timeout: CALL_MS, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        running.delete(child);
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
        } else if (typeof error.code === "number") {
          resolve({ code: error.code, stdout, stderr });
        } else if (error.killed) {
          reject(new Refusal(`${program} ${args[0] ?? ""} did not finish within ${CALL_MS / 1000} s and was stopped`));
        } else {
          reject(new Refusal(`${program} could not run (${error.code ?? error.message})`));
        }
      },
    );
    running.add(child);
  });
}

async function git(...args: string[]): Promise<string> {
  const result = await call("git", args);
  if (result.code !== 0) {
    throw new Refusal(`git ${args[0] ?? ""} failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

// The repository's owner and name on GitHub, from origin.
async function githubRepository(): Promise<string> {
  const url = (await call("git", ["config", "--get", "--end-of-options", "remote.origin.url"])).stdout.trim();
  const match = GITHUB.exec(url);
  if (match === null) {
    throw new Refusal("origin is not a GitHub repository");
  }
  return `${match[1]}/${match[2]}`;
}

// The annotated tag here and on origin, the same object, peeling to HEAD: the commit.
async function taggedCommit(tag: string): Promise<{ commit: string; lines: string[] }> {
  const ref = `refs/tags/${tag}`;
  const type = await call("git", ["cat-file", "-t", "--end-of-options", ref]);
  if (type.code !== 0) {
    throw new Refusal(`there is no tag ${tag} here`);
  }
  if (type.stdout.trim() !== "tag") {
    throw new Refusal(`${tag} is a lightweight tag: a release tag is annotated (git tag -a)`);
  }
  const object = await git("rev-parse", "--verify", "--end-of-options", ref);
  const commit = await git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  const head = await git("rev-parse", "--verify", "HEAD");
  if (head !== commit) {
    throw new Refusal(`HEAD is ${head}, not ${commit}, which ${tag} tags`);
  }
  const remote = new Map(
    (await git("ls-remote", "--end-of-options", "origin", ref, `${ref}^{}`))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [sha = "", name = ""] = line.split("\t");
        return [name, sha];
      }),
  );
  const remoteObject = remote.get(ref);
  if (remoteObject === undefined) {
    throw new Refusal(`origin has no tag ${tag}: push it first`);
  }
  if (remoteObject !== object) {
    throw new Refusal(`origin's ${tag} is the tag object ${remoteObject}, not ${object} as here`);
  }
  if (remote.get(`${ref}^{}`) !== commit) {
    throw new Refusal(`origin's ${tag} does not peel to ${commit}`);
  }
  return { commit, lines: [`tag: ${tag} is annotated (${object}), the same on origin, and tags HEAD`] };
}

// Both packages' versions at the commit equal the tag's.
async function versions(tag: string, commit: string): Promise<string> {
  const issues: string[] = [];
  for (const path of PACKAGES) {
    const shown = await call("git", ["show", "--end-of-options", `${commit}:${path}`]);
    let version: unknown;
    try {
      version = field(JSON.parse(shown.stdout), "version");
    } catch {
      version = undefined;
    }
    if (shown.code !== 0 || typeof version !== "string") {
      issues.push(`${path} has no version at ${commit}`);
    } else if (`v${version}` !== tag) {
      issues.push(`${path} has the version ${version}, not ${tag.slice(1)}`);
    }
  }
  if (issues.length > 0) {
    throw new Refusal(issues.join("; "));
  }
  return `versions: ${PACKAGES.join(" and ")} are ${tag.slice(1)}`;
}

// The commit is an ancestor of origin's main, as origin reports it now.
async function onMain(commit: string): Promise<string> {
  const main = (await git("ls-remote", "--end-of-options", "origin", "refs/heads/main")).split("\t")[0] ?? "";
  if (!SHA.test(main)) {
    throw new Refusal("origin has no main");
  }
  if ((await call("git", ["cat-file", "-e", "--end-of-options", `${main}^{commit}`])).code !== 0) {
    throw new Refusal(`origin's main (${main}) is not here: git fetch origin, then check again`);
  }
  const ancestor = await call("git", ["merge-base", "--is-ancestor", "--end-of-options", commit, main]);
  if (ancestor.code === 1) {
    throw new Refusal(`${commit} is not on origin's main (${main})`);
  }
  if (ancestor.code !== 0) {
    throw new Refusal(`git merge-base failed (exit ${ancestor.code}): ${ancestor.stderr.trim()}`);
  }
  return `main: ${commit} is on origin's main (${main})`;
}

// GitHub's latest Check run of GitHub Actions for the commit, completed and successful.
async function checked(repository: string, commit: string): Promise<string> {
  const result = await call("gh", ["api", `repos/${repository}/commits/${commit}/check-runs?check_name=Check`]);
  if (result.code !== 0) {
    throw new Refusal(`gh api failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  let runs: unknown;
  try {
    runs = field(JSON.parse(result.stdout), "check_runs");
  } catch {
    throw new Refusal("gh api did not answer JSON");
  }
  const ours = (Array.isArray(runs) ? (runs as unknown[]) : []).filter(
    (run) =>
      field(run, "name") === "Check" &&
      field(field(run, "app"), "slug") === "github-actions" &&
      field(run, "head_sha") === commit,
  );
  const passed = ours.find((run) => field(run, "status") === "completed" && field(run, "conclusion") === "success");
  if (passed === undefined) {
    const seen = ours.map((run) => `${String(field(run, "status"))}/${String(field(run, "conclusion"))}`);
    throw new Refusal(
      `GitHub reports no successful Check run of GitHub Actions for ${commit}` +
        (seen.length > 0 ? ` (${seen.join(", ")})` : ""),
    );
  }
  const url = field(passed, "html_url");
  return `Check: completed, success, for ${commit}${typeof url === "string" ? ` (${url})` : ""}`;
}

async function check(args: readonly string[]): Promise<string[]> {
  const [tag = "", flag, sha = ""] = args;
  const preTag = flag === "--pre-tag";
  if (!TAG.test(tag) || !(args.length === 1 || (preTag && args.length === 3))) {
    throw new Refusal(USAGE);
  }
  if (preTag && !SHA.test(sha)) {
    throw new Refusal("--pre-tag takes a commit's full SHA (40 hexadecimal digits)");
  }
  const repository = await githubRepository();
  let commit = sha;
  const lines: string[] = [];
  if (preTag) {
    if ((await call("git", ["cat-file", "-e", "--end-of-options", `${sha}^{commit}`])).code !== 0) {
      throw new Refusal(`${sha} is not a commit here: git fetch origin, then check again`);
    }
    lines.push(`tag: not checked before it exists; check ${tag} again once it is pushed`);
  } else {
    const tagged = await taggedCommit(tag);
    commit = tagged.commit;
    lines.push(...tagged.lines);
  }
  lines.push(await versions(tag, commit));
  lines.push(await onMain(commit));
  lines.push(await checked(repository, commit));
  return [`${tag} at ${commit} may be released`, ...lines.map((line) => `  ${line}`)];
}

if (import.meta.main) {
  for (const signal of SIGNALS) {
    process.once(signal, () => {
      for (const child of running) {
        child.kill("SIGTERM");
      }
      process.kill(process.pid, signal);
    });
  }
  // A "--" before the arguments (as some package managers pass it) is not an argument.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  try {
    for (const line of await check(args)) {
      process.stdout.write(`release-check: ${line}\n`);
    }
  } catch (error) {
    process.stderr.write(`release-check: ${error instanceof Refusal ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
