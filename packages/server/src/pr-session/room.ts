import type { LanguageModelUsage } from "ai";

import { contextLimit } from "./context-budget.ts";

// How much a cloud turn may still read (docs/design.md, Model context: "Overrun inside one turn"): the model's window
// less the reserve, less the newest request the provider measured, less an estimate of what came after it. The newest
// measurement already holds every earlier step, so nothing is counted twice.

// The estimate's ratio for text the provider has not measured yet: characters ÷ 3 (characters ÷ 4 under-counted
// Japanese text and diffs).
export const CHARS_PER_TOKEN = 3;

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
  start(first: { tokens: number } | { chars: number }): void {
    this.#measured = "tokens" in first ? first.tokens : Math.ceil(first.chars / CHARS_PER_TOKEN);
    this.#added = 0;
  }

  // A model call ended: its usage (input and output) replaces the measurement. A provider that reported none leaves the
  // measurement as it was, and the call's content is estimated instead.
  measure(usage: LanguageModelUsage, contentChars: number): void {
    if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
      this.#added += contentChars;
      return;
    }
    this.#measured = usage.inputTokens + usage.outputTokens;
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
