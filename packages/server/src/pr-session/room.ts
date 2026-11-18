import type { LanguageModelUsage } from "ai";

import { contextLimit } from "./context-budget.ts";

// How much a cloud turn may still read (docs/design.md, Model context: "Overrun inside one turn"): the model's window
// less the reserve, less the newest request the provider measured, less an estimate of what came after it. The newest
// measurement already holds every earlier step, so nothing is counted twice.

// The estimate's ratio for text the provider has not measured yet: characters ÷ 3 (characters ÷ 4 under-counted
// Japanese text and diffs).
export const CHARS_PER_TOKEN = 3;

// The context the provider measured for a model call: its request and its output, or null when it did not report both
// (the AI SDK's totalTokens sums whatever side it has).
export function measuredTokens(usage: LanguageModelUsage): number | null {
  return usage.inputTokens === undefined || usage.outputTokens === undefined
    ? null
    : usage.inputTokens + usage.outputTokens;
}

export class ContextRoom {
  // Tokens a request may take: the window less the reserve.
  readonly #limit: number;
  // Tokens of the newest measured request with its output, or the estimate of the first request before any.
  #measured: number;
  // Characters added after that measurement: tool results taken since, and output whose usage was not reported.
  #added = 0;

  constructor(window: number) {
    this.#limit = contextLimit(window);
    this.#measured = 0;
  }

  // The turn's first request, before any model call of the turn has measured one: the context count (the last
  // committed turn's measurement and what came after it), or, without a measurement, its characters estimated.
  start(tokens: number): void {
    this.#measured = tokens;
    this.#added = 0;
  }

  // A model call ended: its usage (input and output) replaces the measurement. A provider that reported none leaves the
  // measurement as it was, and the call's content is estimated instead.
  measure(usage: LanguageModelUsage, contentChars: number): void {
    const tokens = measuredTokens(usage);
    if (tokens === null) {
      this.#added += contentChars;
      return;
    }
    this.#measured = tokens;
    this.#added = 0;
  }

  // The characters the next request may still add.
  leftChars(): number {
    return (this.#limit - this.#measured) * CHARS_PER_TOKEN - this.#added;
  }

  // A tool result taken into the context.
  take(chars: number): void {
    this.#added += chars;
  }
}
