// A manual end-to-end check of a cloud question (cloud-check.ts): the real Worker in wrangler's local runtime with a
// model configured, a question asked over the chat WebSocket while no agent is present (so the session is the cloud
// agent's) and before any push (so the job needs no workspace), and what the session then shows: the job's state, the
// stored answer with its author and usage, or the job's failure.

import { setTimeout as sleep } from "node:timers/promises";

import { MessageMetadata, type PrRef, type PrSessionView } from "@prq/protocol";
import * as v from "valibot";

import { ask, getMessages, sessionView } from "./pr.ts";
import { type ModelSettings, startWorker, type Worker } from "./worker.ts";

const PR: PrRef = { owner: "acme", repo: "widgets", number: 7 };
const QUESTION_ID = "cloud-check-question";
const QUESTION = "In two sentences: what is a pull request, and why are its changes reviewed before they are merged?";
// Longer than the provider's two bounds (no response, no output) and the AI SDK's retries together.
const JOB_MS = 6 * 60_000;
const POLL_MS = 500;

const Stored = v.array(
  v.object({
    id: v.string(),
    parts: v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })),
    metadata: v.optional(v.unknown()),
  }),
);

// The question's job, once the session has made one.
async function answerJob(worker: Worker): Promise<PrSessionView["jobs"][number] | undefined> {
  return (await sessionView(worker, PR)).jobs.find((entry) => entry.target.kind === "answer");
}

async function stored(worker: Worker): Promise<v.InferOutput<typeof Stored>> {
  return v.parse(Stored, await getMessages(worker, PR));
}

// Asks the question and reports how its job ended. With expectRefusal, the check passes when the provider refused the
// request (an unknown model ID); otherwise when the answer was stored with its usage.
export async function checkCloud(
  model: ModelSettings,
  expectRefusal: boolean,
  print: (line: string) => void,
): Promise<boolean> {
  print(`cloud check: model ${model.MODEL_ID} at ${new URL(model.MODEL_BASE_URL).host}, the Worker in a local runtime`);
  const worker = await startWorker({ model });
  try {
    print(`question: ${QUESTION}`);
    const started = Date.now();
    await ask(worker, PR, QUESTION_ID, QUESTION);
    let job = await answerJob(worker);
    while (job?.state !== "done" && job?.state !== "failed" && Date.now() - started < JOB_MS) {
      await sleep(POLL_MS);
      job = await answerJob(worker);
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (job === undefined) {
      print("job: none (the session did not take the question as a cloud job)");
      return false;
    }
    if (job.state === "failed") {
      print(`job: failed after ${seconds} s: ${job.failure ?? "no reason"}`);
      const refused = job.failure?.startsWith("provider refused the request (HTTP 4") === true;
      print(expectRefusal && refused ? "as expected" : "NOT as expected");
      return expectRefusal && refused;
    }
    if (job.state !== "done") {
      print(`job: still ${job.state} after ${seconds} s`);
      return false;
    }
    print(`job: done after ${seconds} s`);
    const answer = (await stored(worker)).find((message) => message.id === `answer-${job.jobId}`);
    const text = (answer?.parts ?? []).map((part) => part.text ?? "").join("");
    const metadata = v.safeParse(MessageMetadata, answer?.metadata);
    print(`answer: ${text}`);
    print(`author: ${JSON.stringify(metadata.success ? metadata.output.by : null)}`);
    print(`usage: ${JSON.stringify(metadata.success ? (metadata.output.usage ?? null) : null)}`);
    const ok =
      !expectRefusal && text.trim() !== "" && metadata.success && (metadata.output.usage?.inputTokens ?? 0) > 0;
    print(ok ? "as expected" : "NOT as expected");
    return ok;
  } finally {
    await worker.close();
  }
}
