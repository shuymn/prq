// check:skills's smoke with a real model (G3; with a pull request argument): the Worker with the model of
// packages/server/.dev.vars at its real window and containers on, yomiyasu registered from main, and the answer prompt
// naming it saved. The push's analysis runs, then three questions in Japanese. Each answer must be done, and every
// answer request must hold the answer prompt. Whether the model activated the skill or ran its scripts is an
// observation, not a verdict: how a host words its prompt for a model is the host's to tune. Printed per answer:
// whether a page of yomiyasu's body (an executed activate_skill whose status line says `read`) was delivered in a model
// step before the answer's first text (a call the model wrote as text is no tool part, so it counts as not made),
// whether the pages read the whole body, the other tool calls, each executed script run (its script, ending and
// seconds), the logged usage, the job's time and each step's (the model's request, then the tools it called, timed
// between the requests here), and the answer's start.

import { type PrRef, sessionName } from "@prq/protocol";
import * as v from "valibot";

import { field, promptsHeld, textField, TOOL_CALL_MARKUP } from "./compaction.ts";
import { deliver, getMessages, ask, savePrompt } from "./pr.ts";
import type { GithubApp } from "./reconcile.ts";
import type { Verdict } from "./skill-context.ts";
import { registerSkill, skillLink, YOMIYASU } from "./skill-github.ts";
import { type ModelSettings, startWorker, type Worker } from "./worker.ts";
import { readPull, untilEnded, workspaceContainers } from "./workspace.ts";

const SMOKE_PROMPT = "Answer in the language of the question. Polish the final text with the yomiyasu skill.";
const QUESTIONS = [
  "このプルリクエストが何を変えるのかを3文で説明してください。",
  "このプルリクエストで一番注意してレビューすべき変更はどこですか。理由を2文で答えてください。",
  "このプルリクエストのテストは変更を十分に確かめていますか。2文で答えてください。",
];
// A continuation note at a page's end, the result cap's or the room's: where the next page starts.
const NEXT_PAGE = /^\[(?:truncated (?:at|inside)|cut at) line \d+[^\]]*?startLine (\d+)(?: and startChar (\d+))?/;

const Parts = v.array(
  v.looseObject({
    type: v.string(),
    text: v.optional(v.string()),
    state: v.optional(v.string()),
    input: v.optional(v.unknown()),
    output: v.optional(v.unknown()),
  }),
);
const Message = v.looseObject({ id: v.string(), parts: Parts });
const ActivateInput = v.object({
  name: v.string(),
  startLine: v.optional(v.number()),
  startChar: v.optional(v.number()),
});

type Part = v.InferOutput<typeof Parts>[number];

// An executed activation of the skill in an answer: its part's position and model step, its outcome from the status
// line, where its page starts, and its result.
type Activation = { at: number; step: number; outcome: string; startLine: number; startChar: number; output: string };

// What an answer's stored parts show of the skill: its executed activations; whether a page was delivered in a model
// step before the one of the answer's first nonblank text, so no text the author sees was written before the model
// read the skill's instructions (a step's result reaches the model in the next step, and a step's text may follow its
// tool call); whether the delivered pages read the whole body (from its start, each next page where the one before
// pointed, the last with no note); and the answer's text as the author sees it (every text part, joined as stored).
export function activationOf(
  parts: readonly Part[],
  skill: string,
): { activations: Activation[]; firstText: number; beforeText: boolean; wholeBody: boolean; text: string } {
  const status = new RegExp(`^\\[activate_skill skill ${skill} at [0-9a-f]{40} rev \\d+: (read|no room|error)\\]$`);
  // Each part's model step: the step-start parts up to it.
  let started = 0;
  const steps = parts.map((part) => (started += part.type === "step-start" ? 1 : 0));
  const activations = parts.flatMap((part, at): Activation[] => {
    const input = v.safeParse(ActivateInput, part.input);
    if (part.type !== "tool-activate_skill" || part.state !== "output-available" || !input.success) {
      return [];
    }
    if (input.output.name !== skill) {
      return [];
    }
    const output = typeof part.output === "string" ? part.output : "";
    const { startLine = 1, startChar = 0 } = input.output;
    const outcome = status.exec(output.split("\n", 1)[0] ?? "")?.[1] ?? "no status line";
    return [{ at, step: steps[at] ?? 0, outcome, startLine, startChar, output }];
  });
  const firstText = parts.findIndex((part) => part.type === "text" && (part.text ?? "").trim() !== "");
  const delivered = activations.filter((entry) => entry.outcome === "read");
  const beforeText = delivered.some((entry) => firstText < 0 || entry.step < (steps[firstText] ?? 0));
  // The page expected next, from the body's start; null once a page ended the body.
  let next: { line: number; char: number } | null = { line: 1, char: 0 };
  for (const page of delivered) {
    if (next !== null && page.startLine === next.line && page.startChar === next.char) {
      const note = NEXT_PAGE.exec(page.output.split("\n").at(-1) ?? "");
      next = note === null ? null : { line: Number(note[1]), char: Number(note[2] ?? 0) };
    }
  }
  const text = parts.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
  return { activations, firstText, beforeText, wholeBody: next === null, text };
}

type Timing = { start: number; end: number };

// Times each request to the model, from its start to the end of its response's body, installed before the Worker
// starts so that it sees the requests the harness passes on.
function timeModel(root: string): { timings: Timing[]; stop: () => void } {
  const timings: Timing[] = [];
  const before = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(root)) {
      return before(input, init);
    }
    const timing = { start: Date.now(), end: Number.NaN };
    timings.push(timing);
    const res = await before(input, init);
    if (res.body === null) {
      timing.end = Date.now();
      return res;
    }
    const ended = new TransformStream<Uint8Array, Uint8Array>({
      flush() {
        timing.end = Date.now();
      },
    });
    return new Response(res.body.pipeThrough(ended), res);
  };
  return {
    timings,
    stop: () => {
      globalThis.fetch = before;
    },
  };
}

function seconds(ms: number): string {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "?";
}

async function answerParts(worker: Worker, pr: PrRef, id: string): Promise<v.InferOutput<typeof Parts>> {
  const list = v.parse(v.array(Message), await getMessages(worker, pr));
  return list.find((message) => message.id === id)?.parts ?? [];
}

export async function checkSmoke(
  settings: { app: GithubApp; model: ModelSettings },
  pr: PrRef,
  print: (line: string) => void,
  verdict: Verdict,
): Promise<void> {
  const pull = await readPull(pr);
  print(
    `G3 smoke: ${pr.owner}/${pr.repo}#${pr.number} at head ${pull.head.sha.slice(0, 7)}, model ${settings.model.MODEL_ID}, ` +
      `window ${settings.model.MODEL_CONTEXT_TOKENS}; the answer prompt: ${SMOKE_PROMPT}`,
  );
  const tracked = await workspaceContainers();
  const timed = timeModel(settings.model.MODEL_BASE_URL);
  const worker = await startWorker({ model: settings.model, githubApp: settings.app.settings, containers: true });
  try {
    const skill = await registerSkill(worker, skillLink(YOMIYASU, "main"));
    print(`  yomiyasu registered at ${skill.sha.slice(0, 7)} rev ${skill.rev}`);
    await savePrompt(worker, "answer", SMOKE_PROMPT);
    await deliver(worker, pr, {
      action: "opened",
      head: pull.head.sha,
      base: pull.base.sha,
      at: pull.updated_at,
      installation: settings.app.installationId,
    });
    await (await worker.durableObject("PrSession", sessionName(pr)))["settle"]?.();
    const analysis = await untilEnded(worker, pr, (job) => job.target.kind === "analysis");
    const analysisParts = analysis === undefined ? [] : await answerParts(worker, pr, `analysis-${analysis.jobId}`);
    print(
      `  analysis: ${analysis?.state ?? "none"}${analysis?.failure == null ? "" : `: ${analysis.failure}`}; ` +
        `activations (recorded, not required): ${analysisParts.filter((part) => part.type === "tool-activate_skill").length}`,
    );
    let activated = 0;
    let whole = 0;
    for (const [index, question] of QUESTIONS.entries()) {
      const id = `smoke-${index + 1}`;
      print(`question ${id}: ${question}`);
      const from = { logs: worker.logs().length, timings: timed.timings.length };
      await ask(worker, pr, id, question);
      const job = await untilEnded(
        worker,
        pr,
        (entry) => entry.target.kind === "answer" && entry.target.messageId === id,
      );
      const parts = job === undefined ? [] : await answerParts(worker, pr, `answer-${job.jobId}`);
      const { activations, firstText, beforeText, wholeBody, text } = activationOf(parts, "yomiyasu");
      const others = parts
        .filter((part) => part.type.startsWith("tool-") && part.type !== "tool-activate_skill")
        .map((part) => `${part.type.slice(5)} (${part.state ?? "?"})`);
      const logs = worker.logs().slice(from.logs);
      const logged = logs.filter((line) => line.includes("prq.skill.activated") && field(line, "jobId") === job?.jobId);
      const usage = logs.find((line) => line.includes("prq.job.usage") && field(line, "jobId") === job?.jobId) ?? "";
      const timings = timed.timings.slice(from.timings);
      const steps = timings.map((timing, step) => {
        const next = timings[step + 1];
        return `model ${seconds(timing.end - timing.start)}${next === undefined ? "" : `, tools ${seconds(next.start - timing.end)}`}`;
      });
      const read = job?.state === "done" && beforeText;
      activated += read ? 1 : 0;
      whole += read && wholeBody ? 1 : 0;
      verdict(job?.state === "done", `  ${job?.state ?? "no job"}${job?.failure == null ? "" : `: ${job.failure}`}`);
      print(
        `  activations of yomiyasu: ` +
          `${activations.map((entry) => `${entry.outcome} at startLine ${entry.startLine}${entry.startChar === 0 ? "" : ` startChar ${entry.startChar}`} (${entry.output.length} characters, part ${entry.at + 1})`).join(", ") || "none"}; ` +
          `first text at part ${firstText + 1} of ${parts.length}; a page delivered in an earlier step: ${beforeText ? "yes" : "no"}; ` +
          `the whole body read: ${wholeBody ? "yes" : "no"}`,
      );
      print(
        `  logged activations: ${logged.map((line) => `${field(line, "outcome")} ${field(line, "chars")} characters`).join(", ") || "none"}`,
      );
      print(
        `  other tool calls: ${others.join(", ") || "none"}; tool-call markup in the answer: ${TOOL_CALL_MARKUP.test(text) ? "yes" : "no"}`,
      );
      const runs = logs.filter((line) => line.includes("prq.skill.script") && field(line, "jobId") === job?.jobId);
      print(
        `  script runs: ${runs.map((line) => `${field(line, "script")} ${textField(line, "ending")} in ${seconds(Number(field(line, "ms")))}`).join(", ") || "none"}`,
      );
      print(
        `  usage: input ${field(usage, "inputTokens")}, cached ${field(usage, "cachedInputTokens")}, output ` +
          `${field(usage, "outputTokens")} tokens over ${field(usage, "steps")} steps; job ${seconds(Number(field(usage, "wallMs")))}`,
      );
      print(`  steps: ${steps.join("; ")}`);
      print(`  answer: ${text.trim().split("\n")[0]?.slice(0, 160) ?? ""}`);
    }
    print(
      `G3 smoke (an observation, not a verdict): ${activated} of ${QUESTIONS.length} answers read a page of yomiyasu ` +
        `in a step before their first text, ${whole} of them the whole body`,
    );
    const { counts, wrong } = promptsHeld(worker.modelRequests(), { analysis: "", answer: SMOKE_PROMPT });
    verdict(
      wrong.length === 0 && counts.answer > 0 && counts.other === 0,
      `G3 smoke prompts: ${counts.analysis} analysis and ${counts.answer} answer requests, ${counts.other} other; ` +
        (wrong.length === 0 ? "each answer request holds the answer prompt and the analysis none" : wrong.join("; ")),
    );
  } finally {
    await worker.close();
    timed.stop();
    const { seen, removed } = await tracked.remove();
    print(`  containers of this check: ${seen}, removed after the Worker closed: ${removed}`);
  }
}
