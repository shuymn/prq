import type { ContextResponse } from "@prq/protocol";

import { CliError, EXIT } from "./errors.ts";

// A conversation message whole: a message sent in parts, joined.
type Message = Omit<ContextResponse["messages"][number], "part">;

// A job's context as prq context writes it: the last page's pull request, details and job, and the whole conversation.
export type Context = Pick<ContextResponse, "pr" | "details" | "job"> & { messages: Message[] };

// Reads every page of a job's context, from no cursor until nextCursor is null, and joins each message sent in parts
// (docs/design.md, Owner and jobs). A part continues the message collected so far: the same ID, its offset where the
// collected text ends and the same whole length; the message is whole when its text reaches that length. Pages that do
// not join that way (a part out of order, a page sequence that ends inside a message, a cursor seen before) end the
// command, as does a page of another job.
export async function readContext(
  jobId: string,
  page: (cursor: string | undefined) => Promise<ContextResponse>,
): Promise<Context> {
  const messages: Message[] = [];
  const cursors = new Set<string>();
  let open: { message: Message; length: number } | null = null;
  let cursor: string | undefined;
  for (;;) {
    const response = await page(cursor);
    if (response.job.jobId !== jobId) {
      throw broken(`a page is of job ${response.job.jobId}, not ${jobId}`);
    }
    for (const { part, ...message } of response.messages) {
      if (open !== null) {
        const collected = open.message.text.length;
        if (message.id !== open.message.id || part?.offset !== collected || part.length !== open.length) {
          throw broken(`message ${JSON.stringify(open.message.id)} stops at ${collected} of ${open.length} characters`);
        }
        open.message.text += message.text;
      } else if (part === undefined) {
        messages.push(message);
        continue;
      } else if (part.offset === 0) {
        open = { message, length: part.length };
      } else {
        throw broken(`message ${JSON.stringify(message.id)} starts at character ${part.offset}`);
      }
      if (open.message.text.length > open.length) {
        throw broken(`message ${JSON.stringify(open.message.id)} is longer than its ${open.length} characters`);
      }
      if (open.message.text.length === open.length) {
        messages.push(open.message);
        open = null;
      }
    }
    if (response.nextCursor === null) {
      if (open !== null) {
        throw broken(`the last page ends inside message ${JSON.stringify(open.message.id)}`);
      }
      const { pr, details, job } = response;
      return { pr, details, job, messages };
    }
    if (cursors.has(response.nextCursor)) {
      throw broken("a page names a cursor already read");
    }
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
}

function broken(reason: string): CliError {
  return new CliError(EXIT.error, `the context's pages do not join: ${reason}`);
}

// An answer job's question: the user message its target names. null for an analysis.
export function questionOf(context: Context): string | null {
  const { target } = context.job;
  if (target.kind !== "answer") {
    return null;
  }
  const question = context.messages.find((message) => message.id === target.messageId);
  if (question?.role !== "user") {
    throw new CliError(EXIT.error, `the question ${JSON.stringify(target.messageId)} is not in the conversation`);
  }
  return question.text;
}
