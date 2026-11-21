import type { Job, PrDetails, PrRef, Skill } from "@prq/protocol";

import { TOOL_RESULT_CHARS } from "./tools.ts";

// What a cloud job's model is told besides the conversation: the system prompt and an analysis's task. The core's text
// is language-neutral; how a summary or an answer reads is the host's prompt's (docs/design.md, Instructions and
// skills).

// The system prompt, in the order that changes least first (docs/design.md, Caching): the core's lines, the skill
// list, the host's prompt of the job's kind, the pull request's facts, then the job's own lines. `instructions` is the
// part before the facts, the same for every job under the same prompt, skills and tools.
export type SystemPrompt = { text: string; instructions: string };

// What the system message lists of a registered skill.
type SkillRecord = Pick<Skill, "name" | "description">;

export function systemPrompt({
  pr,
  details,
  job,
  tools,
  skills = [],
  hostPrompt,
}: {
  pr: PrRef;
  details: PrDetails | null;
  job: Job;
  // Whether the turn has the workspace's tools.
  tools: boolean;
  // The skills the turn lists; the skill tools are offered while any is.
  skills?: readonly SkillRecord[];
  // The host's prompt of the job's kind, as saved.
  hostPrompt: string;
}): SystemPrompt {
  const instructions = instructionPart({ kind: job.target.kind, tools, skills, hostPrompt });
  return { text: withFacts(instructions, { pr, details, job, tools }), instructions };
}

// The system prompt from its instruction part on: the pull request's facts as `details` holds them, then the job's
// own lines, the workspace's tools named with `tools`.
export function withFacts(
  instructions: string,
  { pr, details, job, tools }: { pr: PrRef; details: PrDetails | null; job: Job; tools: boolean },
): string {
  const lines = [instructions, `Pull request: ${pr.owner}/${pr.repo}#${pr.number}`];
  if (details === null) {
    lines.push("Its details are not known yet: no webhook has arrived.");
  } else {
    lines.push(
      `Title: ${details.title}`,
      `URL: ${details.url}`,
      `Repository: ${details.fullName}`,
      `Base: ${details.baseSha}`,
      `Head: ${details.headSha}`,
    );
  }
  if (job.target.kind === "analysis") {
    lines.push(`Your job: summarize the pull request at head ${job.target.headSha}.`);
  } else if (job.workspaceSha === null) {
    lines.push("Your job: answer the last question. No push has been seen yet, so there is no code to read.");
  } else {
    lines.push(`Your job: answer the last question, about the code at commit ${job.workspaceSha}.`);
  }
  if (tools) {
    lines.push(
      `Your tools read the repository at commit ${job.workspaceSha ?? ""} through git: list_files, read_file and grep ` +
        "read that commit, and diff shows the pull request's change against its base.",
    );
  }
  return lines.join("\n");
}

// How a cloud turn delivers its answer (docs/design.md, Owner and jobs): every turn is offered publish.
const PUBLISH_LINE =
  "You deliver your answer by calling publish with the complete answer; text you write outside it is not shown.";

// The skill mechanism, the core's only line about skills: what the list below it is and how its tools load a skill,
// and, when the turn runs scripts, how they run.
export const SKILLS_LINE =
  "The host's skills are listed below by name and description. When the task or the host's instructions call for " +
  "one, call activate_skill with its name before writing, and follow what it says; read_skill_resource reads the " +
  "files it names.";
export const SCRIPTS_SENTENCE = "run_skill_script runs the commands an activated skill allows.";

// The label of the skill list: one JSON record per line keeps each field delimited, so a description holding a line
// break, a record-shaped text or the host block's tags stays inside its string.
export const SKILL_LIST_LABEL =
  'Skill metadata, one JSON record per line ({"name", "description"}); each record names a skill you can activate, ' +
  "and its description says when to use it:";

// The system prompt's instruction part: the core's lines (how the answer is delivered, and how tools page and are
// withdrawn, when any tool besides publish is offered:
// the workspace's with `tools`, the skills' with a skill listed), the skill mechanism with one record per skill sorted
// by name, and the host's prompt of the job's kind.
export function instructionPart({
  kind,
  tools,
  skills = [],
  scripts = false,
  hostPrompt,
}: {
  kind: Job["target"]["kind"];
  tools: boolean;
  skills?: readonly SkillRecord[];
  // Whether the turn is offered run_skill_script.
  scripts?: boolean;
  hostPrompt: string;
}): string {
  const lines = ["You work on one GitHub pull request: you summarize it and answer questions about it.", PUBLISH_LINE];
  if (tools || skills.length > 0) {
    lines.push(
      `A tool's result is cut at ${TOOL_RESULT_CHARS} characters; a note at its end says how to read the next page.`,
      "When the conversation has no room for more, the tools other than publish are withdrawn: answer from what you " +
        "have read.",
    );
  }
  if (skills.length > 0) {
    const sorted = skills.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    lines.push(
      scripts ? `${SKILLS_LINE} ${SCRIPTS_SENTENCE}` : SKILLS_LINE,
      SKILL_LIST_LABEL,
      ...sorted.map(({ name, description }) => JSON.stringify({ name, description })),
    );
  }
  if (hostPrompt.trim() !== "") {
    lines.push(
      `Instructions from the host for ${kind === "analysis" ? "summaries" : "answers"}:`,
      "<host-instructions>",
      hostPrompt,
      "</host-instructions>",
    );
  }
  return lines.join("\n");
}

// An analysis's request, which is not stored: a local analysis stores none either.
export function analysisTask(headSha: string): string {
  return `Summarize the pull request at head ${headSha}.`;
}
