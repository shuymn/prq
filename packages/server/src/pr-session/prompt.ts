import type { Job, PrDetails, PrRef } from "@prq/protocol";

import { TOOL_RESULT_CHARS } from "./tools.ts";

// What a cloud job's model is told besides the conversation: the system prompt and an analysis's task. Both are
// language-neutral; how a summary or an answer reads is the host's prompt's (#6).

export function systemPrompt({
  pr,
  details,
  job,
  tools,
}: {
  pr: PrRef;
  details: PrDetails | null;
  job: Job;
  // Whether the turn has the workspace's tools.
  tools: boolean;
}): string {
  const lines = ["You work on one GitHub pull request: you summarize it and answer questions about it."];
  lines.push(`Pull request: ${pr.owner}/${pr.repo}#${pr.number}`);
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
      `A tool's result is cut at ${TOOL_RESULT_CHARS} characters; a note at its end says how to read the next page.`,
      "When the conversation has no room for more, the tools are withdrawn: answer from what you have read.",
    );
  }
  return lines.join("\n");
}

// An analysis's request, which is not stored: a local analysis stores none either.
export function analysisTask(headSha: string): string {
  return `Summarize the pull request at head ${headSha}.`;
}
