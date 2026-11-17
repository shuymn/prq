// A scripted model for cloud turns: each model call streams the next script, which can hold at a gate (an explicit
// wait point) or fail. The model records what each call was given. It stands in for the provider through the session's
// cloudModel(), spied on the class so an instance made after a reset uses it too.

import { MockLanguageModelV4 } from "ai/test";
import { vi } from "vitest";

import { PrSession } from "../pr-session/index.ts";
import type { WorkspaceClient } from "../pr-session/workspace.ts";
import { type Gate, prSessionSeams } from "./session.ts";
import { FakeWorkspace } from "./workspace.ts";

type DoStream = MockLanguageModelV4["doStream"];
export type CallOptions = Parameters<DoStream>[0];
type StreamResult = Awaited<ReturnType<DoStream>>;
export type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

// A step of a script: a part to stream, a gate to wait at, or an error to fail the stream with.
type Step = StreamPart | { hold: Gate } | { fail: unknown };
export type Script = Step[];
// What one model call does: stream a script, or fail before any stream (a refusal).
type Call = Script | { refuse: unknown };

type Tokens = { input?: number; output?: number; cached?: number };

export function text(delta: string, id = "text-1"): StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta },
    { type: "text-end", id },
  ];
}

export function reasoning(delta: string, id = "reasoning-1"): StreamPart[] {
  return [
    { type: "reasoning-start", id },
    { type: "reasoning-delta", id, delta },
    { type: "reasoning-end", id },
  ];
}

export function finish(
  reason: "stop" | "length" | "content-filter" | "tool-calls" | "other" = "stop",
  { input = 10, output = 5, cached = 0 }: Tokens = {},
): StreamPart {
  return {
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: undefined },
      outputTokens: { total: output, text: output, reasoning: undefined },
    },
  };
}

// A call of one of the turn's tools, as the model streams it.
export function toolCall(toolName: string, input: Record<string, unknown>, toolCallId = "call-1"): StreamPart {
  return { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) };
}

// A whole answer: its text, then a normal finish.
export function answerScript(answer: string, tokens: Tokens = {}): Script {
  return [...text(answer), finish("stop", tokens)];
}

function scriptedStream(script: Script): ReadableStream<StreamPart> {
  let index = 0;
  return new ReadableStream<StreamPart>({
    async pull(controller) {
      while (index < script.length) {
        const step = script[index];
        index += 1;
        if (step === undefined) {
          break;
        }
        if ("hold" in step) {
          await step.hold.wait();
          continue;
        }
        if ("fail" in step) {
          controller.error(step.fail);
          return;
        }
        controller.enqueue(step);
        return;
      }
      controller.close();
    },
  });
}

export class ScriptedModel {
  readonly calls: CallOptions[] = [];
  readonly #scripts: Call[] = [];
  readonly model: MockLanguageModelV4;
  // The model's context window in tokens (MODEL_CONTEXT_TOKENS): a window of about a million tokens by default.
  contextTokens = 1_048_576;

  constructor(modelId = "scripted-model") {
    this.model = new MockLanguageModelV4({
      modelId,
      doStream: async (options) => {
        this.calls.push(options);
        const script = this.#scripts.shift();
        if (script === undefined) {
          throw new Error("no script left for this model call");
        }
        if ("refuse" in script) {
          throw script.refuse;
        }
        return { stream: scriptedStream(script) };
      },
    });
  }

  // Scripts for the next model calls, in order.
  add(...scripts: Call[]): this {
    this.#scripts.push(...scripts);
    return this;
  }

  // The text of each call's prompt messages, by role, for asserting what a job's model saw.
  prompts(): { role: string; text: string }[][] {
    return this.calls.map((call) =>
      call.prompt
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role,
          text:
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
        })),
    );
  }
}

// Every PrSession of the test file runs its cloud turns on the model (undefined: none configured).
export function useCloudModel(model: ScriptedModel | undefined): void {
  const seams = prSessionSeams(PrSession.prototype);
  vi.spyOn(seams, "cloudModel").mockReturnValue(model?.model);
  vi.spyOn(seams, "contextTokens").mockImplementation(() => {
    if (model === undefined) {
      throw new Error("no model is configured");
    }
    return model.contextTokens;
  });
}

// Every PrSession of the test file has the workspace (an empty one by default) for a job with a workspace commit.
export function useWorkspace(workspace: WorkspaceClient = new FakeWorkspace()): WorkspaceClient {
  vi.spyOn(prSessionSeams(PrSession.prototype), "workspaceFor").mockImplementation((job) =>
    job.workspaceSha === null ? null : workspace,
  );
  return workspace;
}
