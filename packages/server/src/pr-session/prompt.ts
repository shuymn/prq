import type { Job, PrDetails, PrRef } from "@prq/protocol";

// What a cloud job's model is told besides the conversation: the system prompt and an analysis's task. Both are
// language-neutral; how a summary or an answer reads is the host's prompt's (#6).

export function systemPrompt({ pr, details, job }: { pr: PrRef; details: PrDetails | null; job: Job }): string {
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
  return lines.join("\n");
}

// An analysis's request, which is not stored: a local analysis stores none either.
export function analysisTask(headSha: string): string {
  return `Summarize the pull request at head ${headSha}.`;
}
