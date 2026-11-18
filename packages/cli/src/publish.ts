import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ContextSkill } from "@prq/protocol";

import { type Context, questionOf } from "./context.ts";
import { type SkillFile, writeSkillFiles } from "./skills.ts";
import { type Staging, temporaryFor, writeAtomically } from "./state.ts";

// What prq context writes into a claim's directory (docs/design.md, Local CLI), published at one point. What can change
// between its runs (the job kind's prompt and the host's skills) is written into a new set, a directory whose name no
// other set has had (mkdtemp makes it), and context.json, written last, names it: that write publishes the set. A
// reader that follows context.json, or a path a run printed, sees one complete set. A set once published is never
// removed by another run, so every path any run printed keeps opening; the job directory's cleanup removes them all.
//   instructions/set-<random>/prompt.md        a set: the job kind's prompt, absent when it is blank
//   instructions/set-<random>/skills/<name>/   and each registered skill's files at the revision the context listed
//   question.md                                an answer job's question (it never changes for a job)
//   context.json                               the context, with the instructions and the set's directory

export type Published = {
  context: string;
  question: string | null;
  prompt: string | null;
  skills: { name: string; description: string; path: string }[];
};

// Reads a skill's files and checks them (readSkillFiles; replaced in tests).
export type SkillReader = (skill: ContextSkill) => Promise<SkillFile[]>;

// The signals that end prq while it writes a set. No git runs then, so git's own handling (git.ts) is not listening.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

// Until release is called, a signal removes context.json's temporary file and, unless the rename that publishes the set
// has been issued (renaming marks it, synchronously), the set; then it ends prq by that signal, as it would have. Once
// the rename is issued, context.json may name the set, so it stays: one a signal left unpublished stays until the job
// directory goes, like any other set. A SIGKILL can still leave a set that no context.json names; the job directory's
// cleanup removes it.
function removedOnSignal(set: string, contextPath: string): Staging & { release: () => void } {
  const temporary = temporaryFor(contextPath);
  let issued = false;
  const listeners = SIGNALS.map((signal) => {
    const listener = () => {
      release();
      rmSync(temporary, { force: true });
      if (!issued) {
        rmSync(set, { recursive: true, force: true });
      }
      process.kill(process.pid, signal);
    };
    return [signal, listener] as const;
  });
  const release = () => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
  };
  for (const [signal, listener] of listeners) {
    process.on(signal, listener);
  }
  const renaming = () => {
    issued = true;
  };
  return { temporary, renaming, release };
}

// Publishes the context, each skill read and checked whole before its files are written, one skill at a time. A
// failure or a signal removes the set this call made, unless context.json may name it, and leaves the files an earlier
// call published as they were. `write` writes a whole file, an error meaning it was not replaced (writeAtomically,
// replaced in tests).
export async function publishContext(
  dir: string,
  read: Context,
  skillFiles: SkillReader,
  write: (path: string, content: string, staging?: Staging) => Promise<void> = writeAtomically,
): Promise<Published> {
  const question = questionOf(read);
  const sets = join(dir, "instructions");
  await mkdir(sets, { recursive: true, mode: 0o700 });
  const set = await mkdtemp(join(sets, "set-"));
  const contextPath = join(dir, "context.json");
  const guard = removedOnSignal(set, contextPath);
  try {
    const text = read.instructions.prompts[read.job.target.kind].text;
    const blank = text.trim() === "";
    if (!blank) {
      await writeFile(join(set, "prompt.md"), text, { mode: 0o600, flag: "wx", flush: true });
    }
    const skills: Published["skills"] = [];
    for (const skill of read.instructions.skills) {
      const path = join(set, "skills", skill.name);
      await writeSkillFiles(path, await skillFiles(skill));
      skills.push({ name: skill.name, description: skill.description, path });
    }
    let questionPath: string | null = null;
    if (question !== null) {
      questionPath = join(dir, "question.md");
      await write(questionPath, question);
    }
    const saved = { ...read, instructions: { ...read.instructions, dir: set } };
    await write(contextPath, `${JSON.stringify(saved, null, 2)}\n`, guard);
    return { context: contextPath, question: questionPath, prompt: blank ? null : join(set, "prompt.md"), skills };
  } catch (error) {
    await rm(set, { recursive: true, force: true });
    throw error;
  } finally {
    guard.release();
  }
}
