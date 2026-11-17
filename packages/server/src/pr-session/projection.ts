import { MessageMetadata } from "@prq/protocol";
import * as v from "valibot";

// What a cloud job's model sees of the conversation (docs/design.md, Model context): the results stored so far in
// storage order, which is commit order (every result is appended at its job's end), each answer preceded by its
// question wherever that question is stored. Incomplete texts are left out, and so is every question without a stored
// answer (waiting, running or failed): a question enters together with its answer, so the results of jobs that ran
// before this one are kept wherever they were stored, and the projection only grows at its end.
export async function projection<M extends { id: string; role: string; metadata?: unknown }>(
  history: AsyncIterable<M>,
): Promise<M[]> {
  const questions = new Map<string, M>();
  const projected: M[] = [];
  for await (const message of history) {
    if (message.role === "user") {
      questions.set(message.id, message);
      continue;
    }
    const metadata = v.safeParse(MessageMetadata, message.metadata);
    if (message.role !== "assistant" || !metadata.success || metadata.output.incomplete !== undefined) {
      continue;
    }
    if (metadata.output.kind === "answer") {
      const question = questions.get(metadata.output.questionId);
      if (question !== undefined) {
        projected.push(question);
      }
    }
    projected.push(message);
  }
  return projected;
}
