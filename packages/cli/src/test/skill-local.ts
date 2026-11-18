// check:skills --local's step (G8): the compiled prq as a local agent against the Worker of the check, behind the
// stand-in for Access, with yomiyasu registered from GitHub and a real pull request's head pushed. For the push's
// analysis, then for an answer to one question, `prq claim` and `prq context` run, and the check compares what the
// printed paths hold with its own read of GitHub (skills/yomiyasu/ at the pinned SHA: paths, sizes, modes, blob SHA-1)
// and prompt.md with the prompt saved for that kind of job. For the answer it then saves a new answer prompt and runs
// `prq context` again: context.json names a new set holding the new prompt, and every file the first run printed still
// opens with its bytes. `prq checkout` then adds the worktree from a clone of the check's own (an empty repository
// whose origin is the pull request's repository, so prq fetches the commit from GitHub), and nothing prq wrote is
// under it. It prints what it compared and the seconds of each command, and removes its temporary directory.

import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { PrRef, PromptKind } from "@prq/protocol";
import * as v from "valibot";

import { startAccess } from "./access.ts";
import buildCli from "./build.ts";
import { type Exit, startCli } from "./cli.ts";
import { FixtureGit, fixtureRoot, gitEnv } from "./git.ts";
import { ask, push, savePrompt } from "./pr.ts";
import type { Verdict } from "./skill-context.ts";
import {
  type Github,
  type Manifest,
  registerSkill,
  sameAsTree,
  type SkillCopy,
  skillLink,
  YOMIYASU,
} from "./skill-github.ts";
import type { Worker } from "./worker.ts";
import { readPull } from "./workspace.ts";

const AGENT = "skills-check-local";
const PROMPTS = {
  analysis: "Summarize the pull request in two short paragraphs.",
  answer: "Answer in the language of the question.",
} as const satisfies Record<PromptKind, string>;
const NEW_ANSWER_PROMPT = "Answer in one short paragraph, in the language of the question.";

const Claimed = v.looseObject({
  job: v.looseObject({ target: v.looseObject({ kind: v.string() }) }),
  dir: v.string(),
});
const Contexted = v.looseObject({
  dir: v.string(),
  prompt: v.nullable(v.string()),
  skills: v.array(v.object({ name: v.string(), description: v.string(), path: v.string() })),
  answer: v.string(),
});
const Saved = v.looseObject({ instructions: v.looseObject({ dir: v.string() }) });
const CheckedOut = v.looseObject({ path: v.string(), sha: v.string() });

// The one JSON line a command printed, or null.
function resultOf(exit: Exit): unknown {
  const line = exit.stdout.trim();
  try {
    return line === "" ? null : JSON.parse(line);
  } catch {
    return null;
  }
}

// The regular files under a skill's directory as prq context wrote them, each with the git mode its permission bits
// say, and every other kind of entry by its path.
async function copyAt(dir: string): Promise<{ files: SkillCopy[]; others: string[] }> {
  const files: SkillCopy[] = [];
  const others: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) {
      continue;
    }
    if (!entry.isFile()) {
      others.push(relative(dir, path));
      continue;
    }
    const content = new Uint8Array(await readFile(path));
    const bits = (await stat(path)).mode & 0o777;
    const mode = bits === 0o755 ? "100755" : bits === 0o644 ? "100644" : bits.toString(8);
    files.push({ path: relative(dir, path), mode, size: content.byteLength, content });
  }
  return { files, others };
}

export async function checkLocal(
  worker: Worker,
  github: Github,
  pr: PrRef,
  print: (line: string) => void,
  verdict: Verdict,
): Promise<void> {
  buildCli();
  const skill = await registerSkill(worker, skillLink(YOMIYASU, "main"));
  const manifest: Manifest = await github.manifestAt(YOMIYASU, skill.sha);
  const pull = await readPull(pr);
  print(
    `G8: yomiyasu registered at ${skill.sha.slice(0, 7)} rev ${skill.rev}; ${pr.owner}/${pr.repo}#${pr.number} at ` +
      `${pull.head.sha.slice(0, 7)} (base ${pull.base.sha.slice(0, 7)})`,
  );
  const root = await fixtureRoot("prq-skills-local-");
  const access = await startAccess(worker);
  try {
    const env = {
      ...gitEnv(root),
      PRQ_HOME: join(root, "state"),
      PRQ_URL: access.url,
      PRQ_ACCESS_CLIENT_ID: access.clientId,
      PRQ_ACCESS_CLIENT_SECRET: access.clientSecret,
    };
    const prq = async (...args: string[]) => {
      const started = performance.now();
      const exit = await startCli([...args, "--agent-id", AGENT], env, root).exited;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      print(
        `G8 prq ${args.join(" ")}: exit ${exit.code ?? exit.signal}, ${seconds} s${exit.stderr === "" ? "" : `; stderr ${exit.stderr.trim()}`}`,
      );
      return exit;
    };

    // What one prq context printed, checked against GitHub's tree and the prompt saved for the job's kind.
    const context = async (label: string, prompt: string) => {
      const printed = v.parse(Contexted, resultOf(await prq("context")));
      const [only] = printed.skills;
      const copy = only === undefined ? { files: [], others: [] } : await copyAt(only.path);
      const compared = sameAsTree(`G8 ${label}: skills/yomiyasu`, copy.files, manifest);
      const set = v.parse(Saved, JSON.parse(await readFile(join(printed.dir, "context.json"), "utf8")));
      verdict(
        printed.skills.length === 1 &&
          only?.name === "yomiyasu" &&
          only.path === join(set.instructions.dir, "skills", "yomiyasu") &&
          copy.others.length === 0 &&
          compared.held,
        `${compared.line}; at ${relative(root, only?.path ?? "")}${copy.others.length === 0 ? "" : `; other entries ${copy.others.join(", ")}`}`,
      );
      const text = printed.prompt === null ? null : await readFile(printed.prompt, "utf8");
      verdict(text === prompt, `G8 ${label}: prompt.md ${text === prompt ? "is" : "is NOT"} the saved prompt`);
      return {
        printed,
        files: [
          ...(printed.prompt === null ? [] : [printed.prompt]),
          ...copy.files.map((file) => join(only?.path ?? "", file.path)),
        ],
      };
    };

    const waited = await prq("wait", "--timeout", "0");
    verdict(waited.code === 2, "G8: the agent is present (its wait timed out at once)");
    await savePrompt(worker, "analysis", PROMPTS.analysis);
    await savePrompt(worker, "answer", PROMPTS.answer);
    await push(worker, pr, pull.head.sha, pull.base.sha);

    // The push's analysis.
    const analysis = v.parse(Claimed, resultOf(await prq("claim")));
    verdict(analysis.job.target.kind === "analysis", `G8 analysis: claimed a ${analysis.job.target.kind} job`);
    const analysisContext = await context("analysis", PROMPTS.analysis);
    await writeFile(analysisContext.printed.answer, "A summary written by the check.\n");
    verdict((await prq("submit")).code === 0, "G8 analysis: submitted");

    // An answer to one question, at the analysed head.
    await ask(worker, pr, "skills-local-q1", "What does this pull request change?");
    const answer = v.parse(Claimed, resultOf(await prq("claim")));
    verdict(answer.job.target.kind === "answer", `G8 answer: claimed an ${answer.job.target.kind} job`);
    const first = await context("answer", PROMPTS.answer);
    const before = new Map(await Promise.all(first.files.map(async (path) => [path, await readFile(path)] as const)));

    // A new answer prompt, and the context again before the checkout: a new set, the first one's files unchanged.
    await savePrompt(worker, "answer", NEW_ANSWER_PROMPT);
    const firstSet = v.parse(Saved, JSON.parse(await readFile(join(answer.dir, "context.json"), "utf8")));
    const second = await context("answer, refreshed", NEW_ANSWER_PROMPT);
    const secondSet = v.parse(Saved, JSON.parse(await readFile(join(answer.dir, "context.json"), "utf8")));
    const changed: string[] = [];
    for (const [path, bytes] of before) {
      const now = await readFile(path).catch(() => null);
      if (now === null || !now.equals(bytes)) {
        changed.push(relative(answer.dir, path));
      }
    }
    verdict(
      secondSet.instructions.dir !== firstSet.instructions.dir && second.printed.prompt !== first.printed.prompt,
      `G8 refresh: context.json names ${relative(answer.dir, secondSet.instructions.dir)}, not the first run's ${relative(answer.dir, firstSet.instructions.dir)}`,
    );
    verdict(
      changed.length === 0,
      `G8 refresh: the ${before.size} files the first run printed ${changed.length === 0 ? "still open with their bytes" : `changed: ${changed.join(", ")}`}`,
    );

    // The checkout, from a clone that lacks the commit, and nothing of prq's under the worktree.
    const git = await FixtureGit.create(root);
    const clone = await git.init("clone");
    await clone.remoteAdd("origin", `https://github.com/${pr.owner}/${pr.repo}.git`);
    const checkedOut = await prq("checkout", "--clone", join(root, "clone"));
    const worktree = v.safeParse(CheckedOut, resultOf(checkedOut));
    if (!worktree.success) {
      verdict(false, "G8 checkout: no worktree");
      return;
    }
    const tree = git.repo(relative(root, worktree.output.path));
    const status = await tree.status();
    const head = await tree.headCommit();
    verdict(
      worktree.output.path === join(answer.dir, "worktree") && head === pull.head.sha && status === "",
      `G8 checkout: ${relative(root, worktree.output.path)} at ${head.slice(0, 7)}; untracked or ignored entries in it: ` +
        (status === "" ? "none" : status.split("\n").slice(0, 5).join(", ")),
    );
  } finally {
    await access.close();
    await rm(root, { recursive: true, force: true });
  }
}
