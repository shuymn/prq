// The check of scripts/tools-check.ts: the production turn's tool loop (the tools, stopWhen, the room that withdraws
// them, the stream bounds) over an in-memory workspace, against the given model, with a window small enough that the
// room runs out. Every line goes through the key's redaction before it is printed.

import type { Job, PrDetails, PrRef } from "@prq/protocol";
import { streamText } from "ai";

import { contextBudget } from "../src/pr-session/context-budget.ts";
import { classifyModelError, redact } from "../src/pr-session/model.ts";
import { systemPrompt } from "../src/pr-session/prompt.ts";
import { NO_ROOM, toolLoop, TURN_LOOP } from "../src/pr-session/tools.ts";
import { type CloudModel, stepTokens } from "../src/pr-session/turn.ts";
import { FakeWorkspace, type Files } from "../src/test/workspace.ts";

// The window the check measures the room against: the smallest MODEL_CONTEXT_TOKENS accepted, so a few pages of the
// change fill it whatever the model's real window is.
export const CHECK_WINDOW = 16_384;

const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);
const PR: PrRef = { owner: "example", repo: "shop", number: 1 };
const DETAILS: PrDetails = {
  fullName: "example/shop",
  title: "Update catalog prices",
  state: "open",
  url: "https://github.com/example/shop/pull/1",
  headSha: HEAD,
  baseSha: BASE,
};
const JOB: Job = {
  jobId: "00000000-0000-4000-8000-000000000001",
  pr: PR,
  run: 1,
  target: { kind: "answer", messageId: "question" },
  workspaceSha: HEAD,
};

const QUESTION =
  "Which items changed price in this pull request, and which one rose the most? Use the diff of src/catalog.ts and " +
  "read all of its pages before you answer.";

const CATEGORIES = ["tools", "garden", "kitchen", "office", "toys"];

function basePrice(item: number): number {
  return 1000 + ((item * 37) % 900);
}

// Every fifth item costs more at the head, so the change is one long hunk of many pages.
function headPrice(item: number): number {
  return item % 5 === 0 ? basePrice(item) + ((item * 13) % 500) : basePrice(item);
}

function catalog(price: (item: number) => number): string {
  const lines = ["// The shop's catalog: every item with its price in cents.", "export const catalog = ["];
  for (let item = 1; item <= 600; item += 1) {
    const sku = `SKU-${String(item).padStart(4, "0")}`;
    lines.push(
      `  { sku: "${sku}", name: "Item ${item}", category: "${CATEGORIES[item % 5]}", price: ${price(item)} },`,
    );
  }
  lines.push("];", "");
  return lines.join("\n");
}

function pricing(rate: string): string {
  return [
    'import { catalog } from "./catalog.ts";',
    "",
    `export const TAX_RATE = ${rate};`,
    "",
    "export function total(sku: string, quantity: number): number {",
    "  const item = catalog.find((entry) => entry.sku === sku);",
    "  if (item === undefined) {",
    "    throw new Error(`unknown item ${sku}`);",
    "  }",
    "  return Math.round(item.price * quantity * (1 + TAX_RATE));",
    "}",
    "",
  ].join("\n");
}

const README = "# shop\n\nThe catalog and its prices.\n";

const BASE_FILES: Files = {
  "README.md": README,
  "src/catalog.ts": catalog(basePrice),
  "src/pricing.ts": pricing("0.08"),
};
const HEAD_FILES: Files = {
  "README.md": README,
  "src/catalog.ts": catalog(headPrice),
  "src/pricing.ts": pricing("0.1"),
};

// How a tool result came back: whole, cut at a page (the 12,000-character cap), cut for the room, or an error.
function resultKind(output: unknown): string {
  if (typeof output !== "string") {
    return "not text";
  }
  if (output === NO_ROOM || output.includes("no room for more")) {
    return "cut: no room left";
  }
  if (output.startsWith("error:")) {
    return "error";
  }
  if (/^\[(truncated|\d+ more)/m.test(output)) {
    return "cut: page";
  }
  return "whole";
}

// Runs the production tool loop on the check's question and prints each step, whether and when the tools were
// withdrawn, the finish reason, the answer and the usage. True when the answer is not blank and the turn finished with
// `stop`.
export async function checkTools(
  model: CloudModel,
  print: (line: string) => void,
  { window = CHECK_WINDOW, secret }: { window?: number; secret?: string } = {},
): Promise<boolean> {
  const say = (line: string) => print(redact(line, secret));
  const workspace = new FakeWorkspace({ base: BASE_FILES, head: HEAD_FILES });
  const target = { fullName: `${PR.owner}/${PR.repo}`, installationId: null, sha: HEAD, baseSha: BASE, seq: 1 };
  const prepared = await workspace.prepare(target, new AbortController().signal);
  const { text: system } = systemPrompt({ pr: PR, details: DETAILS, job: JOB, tools: true, hostPrompt: "" });
  const messages = [{ role: "user" as const, content: QUESTION }];
  const loop = await toolLoop({ workspace, target, prepared }, window, { system, messages });
  say(`tools check: model ${model.modelId}, window ${window} (reserve ${contextBudget(window).reserve})`);
  say(`question: ${QUESTION}`);
  const offered: string[] = [];
  const errors: unknown[] = [];
  const result = streamText({
    model,
    system,
    messages,
    ...TURN_LOOP,
    tools: loop.tools,
    prepareStep: (options) => {
      const step = loop.prepareStep(options);
      offered.push(step?.activeTools?.length === 0 ? "no tools offered" : "tools offered");
      return step;
    },
    onLanguageModelCallEnd: loop.onLanguageModelCallEnd,
    onError: ({ error }) => {
      errors.push(error);
    },
    onStepFinish: ({ stepNumber, finishReason, usage, toolResults, toolCalls }) => {
      const tokens = stepTokens(usage);
      say("");
      say(
        `step ${stepNumber + 1}: ${offered[stepNumber] ?? "?"}; finish ${finishReason}; ` +
          `input ${tokens.input}, output ${tokens.output}, cached ${tokens.cachedInput}`,
      );
      for (const call of toolCalls) {
        const output = toolResults.find((done) => done.toolCallId === call.toolCallId)?.output;
        const size = typeof output === "string" ? `${output.length} characters` : "no result";
        say(`  ${call.toolName} ${JSON.stringify(call.input)} → ${size}, ${resultKind(output)}`);
      }
    },
  });
  let text: string;
  let finishReason: string;
  try {
    text = await result.text;
    finishReason = await result.finishReason;
  } catch (error) {
    errors.push(error);
    text = "";
    finishReason = "error";
  }
  for (const error of errors) {
    say(`error: ${classifyModelError(error, secret).reason}`);
  }
  const withdrawn = loop.withdrawnAt();
  const total = await Promise.resolve(result.totalUsage).catch(() => undefined);
  say("");
  say(`tools withdrawn: ${withdrawn === null ? "no" : `from step ${withdrawn + 1} (no tools offered)`}`);
  say(`finish reason: ${finishReason}`);
  say("answer:");
  for (const line of text.split("\n")) {
    say(`  ${line}`);
  }
  if (total !== undefined) {
    const tokens = stepTokens(total);
    say(`usage: ${offered.length} steps, input ${tokens.input}, output ${tokens.output}, cached ${tokens.cachedInput}`);
  }
  const ok = text.trim() !== "" && finishReason === "stop";
  say(ok ? "answered: yes" : "answered: NO (a non-blank answer with a stop finish was expected)");
  return ok;
}
