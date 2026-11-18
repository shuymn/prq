import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type Context, questionOf } from "./context.ts";
import { writeAtomically } from "./state.ts";

// What prq context writes into a claim's directory (docs/design.md, Local CLI), published at one point. What can change
// between its runs (the job kind's prompt) is written into a new set, a directory whose name no other set has had
// (mkdtemp makes it), and context.json, written last, names it: that write publishes the set. A reader that follows
// context.json, or a path a run printed, sees one complete set. A set once published is never removed by another run,
// so every path any run printed keeps opening; the job directory's cleanup removes them all.
//   instructions/set-<random>/prompt.md  a set: the job kind's prompt, absent when it is blank
//   question.md                          an answer job's question (it never changes for a job)
//   context.json                         the context, with the instructions and the set's directory

export type Published = { context: string; question: string | null; prompt: string | null };

// Publishes the context. A failure removes the set this call made, and leaves the files an earlier call published as
// they were. `write` writes a whole file (writeAtomically, replaced in tests).
export async function publishContext(
  dir: string,
  read: Context,
  write: (path: string, content: string) => Promise<void> = writeAtomically,
): Promise<Published> {
  const question = questionOf(read);
  const sets = join(dir, "instructions");
  await mkdir(sets, { recursive: true, mode: 0o700 });
  const set = await mkdtemp(join(sets, "set-"));
  try {
    const text = read.instructions.prompts[read.job.target.kind].text;
    const blank = text.trim() === "";
    if (!blank) {
      await writeFile(join(set, "prompt.md"), text, { mode: 0o600, flag: "wx", flush: true });
    }
    let questionPath: string | null = null;
    if (question !== null) {
      questionPath = join(dir, "question.md");
      await write(questionPath, question);
    }
    const contextPath = join(dir, "context.json");
    const saved = { ...read, instructions: { ...read.instructions, dir: set } };
    await write(contextPath, `${JSON.stringify(saved, null, 2)}\n`);
    return { context: contextPath, question: questionPath, prompt: blank ? null : join(set, "prompt.md") };
  } catch (error) {
    await rm(set, { recursive: true, force: true });
    throw error;
  }
}
