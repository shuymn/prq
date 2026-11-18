import type { Job, PrDetails, PrRef } from "@prq/protocol";

import { TOOL_RESULT_CHARS } from "./tools.ts";

// What a cloud job's model is told besides the conversation: the system prompt and an analysis's task. The core's text
// is language-neutral; how a summary or an answer reads is the host's prompt's (docs/design.md, Instructions and
// skills).

// The system prompt, in the order that changes least first (docs/design.md, Caching): the core's lines, the host's
// prompt of the job's kind, the pull request's facts, then the job's own lines. `instructions` is the part before the
// facts, the same for every job under the same prompt and tools.
export type SystemPrompt = { text: string; instructions: string };

export function systemPrompt({
  pr,
  details,
  job,
  tools,
  hostPrompt,
}: {
  pr: PrRef;
  details: PrDetails | null;
  job: Job;
  // Whether the turn has the workspace's tools.
  tools: boolean;
  // The host's prompt of the job's kind, as saved.
  hostPrompt: string;
}): SystemPrompt {
  const instructions = instructionPart({ kind: job.target.kind, tools, hostPrompt });
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
  return { text: lines.join("\n"), instructions };
}

// The system prompt's instruction part: the core's lines and the host's prompt of the job's kind.
export function instructionPart({
  kind,
  tools,
  hostPrompt,
}: {
  kind: Job["target"]["kind"];
  tools: boolean;
  hostPrompt: string;
}): string {
  const lines = ["You work on one GitHub pull request: you summarize it and answer questions about it."];
  if (tools) {
    lines.push(
      `A tool's result is cut at ${TOOL_RESULT_CHARS} characters; a note at its end says how to read the next page.`,
      "When the conversation has no room for more, the tools are withdrawn: answer from what you have read.",
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
