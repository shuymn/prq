// The checks of scripts/provider-check.ts: what the configured provider does with the requests a cloud turn makes,
// through the production model (createModel, with its response bound and the turn's stream bounds). Every line goes
// through the key's redaction before it is printed.

import {
  APICallError,
  jsonSchema,
  type ModelMessage,
  RetryError,
  StreamProviderError,
  streamText,
  type TextStreamPart,
  type ToolSet,
} from "ai";

import type { ModelConfig } from "../src/config.ts";
import { classifyModelError, createModel, redact, STREAM_TIMEOUT } from "../src/pr-session/model.ts";
import { type CloudModel, stepTokens } from "../src/pr-session/turn.ts";

// A tool the model may call; it has no execute, so a call ends the step.
const tools: ToolSet = {
  lookup: {
    description: "Read a file of the repository by its path.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    }),
  },
};

type Part = TextStreamPart<ToolSet>;
type Run = { parts: Part[]; errors: unknown[] };

// A lookup the model made, and its result: a turn's history when the tools are withdrawn.
const LOOKED_UP: ModelMessage[] = [
  { role: "user", content: "Use the lookup tool to read README.md, then say in one sentence what it is about." },
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: { path: "README.md" } }],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "lookup",
        output: { type: "text", value: "# prq\n\nSummarizes pull requests and answers questions about them." },
      },
    ],
  },
];

async function stream(
  model: CloudModel,
  input: string | ModelMessage[],
  options: { tools?: ToolSet; activeTools?: string[]; maxOutputTokens?: number } = {},
): Promise<Run> {
  const errors: unknown[] = [];
  const result = streamText({
    model,
    ...(typeof input === "string" ? { prompt: input } : { messages: input }),
    timeout: STREAM_TIMEOUT,
    ...options,
    onError: ({ error }) => {
      errors.push(error);
    },
  });
  const parts: Part[] = [];
  for await (const part of result.fullStream) {
    parts.push(part);
  }
  return { parts, errors };
}

// The part types in order, a run of one type counted.
function shape(parts: Part[]): string {
  const runs: [string, number][] = [];
  for (const part of parts) {
    const last = runs.at(-1);
    if (last?.[0] === part.type) {
      last[1] += 1;
    } else {
      runs.push([part.type, 1]);
    }
  }
  return runs.map(([type, count]) => (count === 1 ? type : `${type} ×${count}`)).join(", ");
}

function finish(parts: Part[]): string {
  const end = parts.find((part) => part.type === "finish");
  return end === undefined ? "none" : `${end.finishReason} (raw: ${end.rawFinishReason ?? "none"})`;
}

function stepUsage(parts: Part[]) {
  return parts.findLast((part) => part.type === "finish-step")?.usage;
}

// Whether a run ended as a turn's result must: answer text that is not blank, then a `stop` finish.
function answered(parts: Part[]): boolean {
  return (
    parts.some((part) => part.type === "text-delta" && part.text.trim() !== "") &&
    parts.find((part) => part.type === "finish")?.finishReason === "stop"
  );
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

// A field of a value that may be an object.
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

// An error as the turn's classification sees it: its class and the provider's fields, then the reason a job would
// fail with.
function describeError(error: unknown, secret: string): string[] {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  const fields: Record<string, unknown> = { class: cause instanceof Error ? cause.name : typeof cause };
  if (RetryError.isInstance(error)) {
    fields["attempts"] = error.errors.length;
  }
  if (APICallError.isInstance(cause)) {
    const body = field(cause.data, "error");
    Object.assign(fields, {
      status: cause.statusCode,
      code: field(body, "code"),
      type: field(body, "type"),
      retryable: cause.isRetryable,
    });
  } else if (StreamProviderError.isInstance(cause)) {
    Object.assign(fields, {
      status: cause.statusCode,
      code: cause.code,
      type: cause.type,
      retryable: cause.isRetryable,
    });
  }
  const classified = classifyModelError(error, secret);
  return [
    `error: ${JSON.stringify(fields)}`,
    `message: ${cause instanceof Error ? cause.message : String(cause)}`,
    `job failure: ${classified.reason}`,
    `recognised as a context-length refusal: ${classified.contextLength ? "yes" : "no"}`,
  ];
}

type Check = { title: string; run: (model: CloudModel, say: (line: string) => void) => Promise<boolean> };

function errorsReported(run: Run, say: (line: string) => void, secret: string): boolean {
  for (const error of run.errors) {
    for (const line of describeError(error, secret)) {
      say(line);
    }
  }
  return run.errors.length > 0;
}

// A prompt long enough for a provider's prompt cache (a few thousand tokens), the same each time.
const LONG_PROMPT = `${Array.from({ length: 200 }, (_, line) => `Line ${line + 1}: the quick brown fox jumps over the lazy dog.`).join("\n")}\n\nReply with the single word OK.`;

function checks(config: ModelConfig): Check[] {
  const secret = config.MODEL_API_KEY;
  return [
    {
      title: "Streaming: text arrives in more than one chunk",
      run: async (model, say) => {
        const run = await stream(model, "Count from 1 to 30, one number per line, and nothing else.");
        const chunks = run.parts.filter((part) => part.type === "text-delta").length;
        const done = answered(run.parts);
        say(`text chunks: ${chunks} (more than one: ${yesNo(chunks > 1)})`);
        say(`finish reason: ${finish(run.parts)}; answered (text, then a stop): ${yesNo(done)}`);
        return !errorsReported(run, say, secret) && chunks > 1 && done;
      },
    },
    {
      title: "Usage and the prompt cache: the same long prompt twice",
      run: async (model, say) => {
        let ok = true;
        const hits = new Set<string>();
        for (const attempt of ["first", "second"]) {
          const run = await stream(model, LONG_PROMPT);
          const done = answered(run.parts);
          ok = !errorsReported(run, say, secret) && done && ok;
          say(`${attempt}: finish reason ${finish(run.parts)}; answered (text, then a stop): ${yesNo(done)}`);
          // The usage log needs both counts; a provider that leaves them out logs every run as 0.
          const usage = stepUsage(run.parts);
          if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
            say(`${attempt}: no usage reported (raw: ${JSON.stringify(usage?.raw ?? null)})`);
            ok = false;
            continue;
          }
          say(
            `${attempt}: input ${usage.inputTokens}, output ${usage.outputTokens}, ` +
              `cacheReadTokens ${usage.inputTokenDetails.cacheReadTokens ?? "none"}, ` +
              `cached input prq logs ${stepTokens(usage).cachedInput}`,
          );
          say(`${attempt} raw usage: ${JSON.stringify(usage.raw ?? null)}`);
          if ((usage.inputTokenDetails.cacheReadTokens ?? 0) > 0) {
            hits.add("prompt_tokens_details.cached_tokens");
          }
          const hit = usage.raw?.["prompt_cache_hit_tokens"];
          if (typeof hit === "number" && hit > 0) {
            hits.add("prompt_cache_hit_tokens");
          }
        }
        say(
          `cached tokens reported in: ${hits.size === 0 ? "neither field (no cache hit seen)" : [...hits].join(", ")}`,
        );
        return ok;
      },
    },
    {
      title: "A tool call: its streamed shape and finish reason",
      run: async (model, say) => {
        const run = await stream(model, "Use the lookup tool to read README.md. Do not answer without it.", { tools });
        say(`stream parts: ${shape(run.parts)}`);
        const calls = run.parts.filter((part) => part.type === "tool-call");
        for (const call of calls) {
          say(`tool call: ${call.toolName} ${JSON.stringify(call.input)}`);
        }
        say(`finish reason: ${finish(run.parts)}`);
        return !errorsReported(run, say, secret) && calls.length > 0;
      },
    },
    {
      // As a turn whose room ran out sends it: the history holds a tool call and its result, and no tool is offered.
      title: "No tools offered after a tool call (a turn's withdrawn tools)",
      run: async (model, say) => {
        const run = await stream(model, LOOKED_UP, { tools, activeTools: [] });
        const calls = run.parts.filter((part) => part.type === "tool-call").length;
        const done = answered(run.parts);
        say(`stream parts: ${shape(run.parts)}`);
        say(`tool calls: ${calls}; finish reason: ${finish(run.parts)}; answered (text, then a stop): ${yesNo(done)}`);
        return !errorsReported(run, say, secret) && calls === 0 && done;
      },
    },
    {
      title: "A context-length refusal: a prompt over MODEL_CONTEXT_TOKENS",
      run: async (model, say) => {
        // " a" is about one token in common tokenizers; a quarter over the window leaves room for that estimate.
        const words = Math.ceil(config.MODEL_CONTEXT_TOKENS * 1.25);
        say(`prompt: ${words} words (${words * 2} characters) against a window of ${config.MODEL_CONTEXT_TOKENS}`);
        const run = await stream(model, `${" a".repeat(words)}\n\nReply with the single word OK.`, {
          maxOutputTokens: 16,
        });
        if (!errorsReported(run, say, secret)) {
          say(`no error: the provider accepted it (finish reason: ${finish(run.parts)})`);
          return false;
        }
        return run.errors.some((error) => classifyModelError(error, secret).contextLength);
      },
    },
  ];
}

// Runs every check against the configured provider and prints what each saw. True when each behaved as a cloud turn
// needs (the context-length check: the refusal was recognised).
export async function checkProvider(config: ModelConfig, print: (line: string) => void): Promise<boolean> {
  const secret = config.MODEL_API_KEY;
  const say = (line: string) => print(redact(line, secret));
  const model = createModel(config);
  say(`provider check: model ${config.MODEL_ID} at ${new URL(config.MODEL_BASE_URL).host}`);
  let passed = 0;
  const list = checks(config);
  for (const [index, check] of list.entries()) {
    say("");
    say(`${index + 1}. ${check.title}`);
    const indented = (line: string) => say(`   ${line}`);
    let ok: boolean;
    try {
      ok = await check.run(model, indented);
    } catch (error) {
      for (const line of describeError(error, secret)) {
        indented(line);
      }
      ok = false;
    }
    indented(ok ? "as expected" : "NOT as expected");
    passed += ok ? 1 : 0;
  }
  say("");
  say(`${passed} of ${list.length} checks as expected`);
  return passed === list.length;
}
