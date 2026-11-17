// The context parameters scaled to the model's window W (MODEL_CONTEXT_TOKENS): Pi's defaults at Pi's sizes (W of
// 131,072 or more), and below them shares of the window, so none exceeds it. The kept tail always exceeds the notes
// output (by W/10 at small windows), and that margin holds the summary prompt: summarizing a context that fit the
// window (its history minus the kept tail, plus the summary's output) fits it too.
export type ContextBudget = {
  // Tokens left free for the next answer: the context is compacted when it exceeds the window minus this.
  reserve: number;
  // Tokens of the most recent conversation kept as they are when compacting.
  keptTail: number;
  // The most tokens a summary may produce.
  notesOutput: number;
};

export function contextBudget(window: number): ContextBudget {
  return {
    reserve: Math.min(16_384, Math.floor(window / 8)),
    keptTail: Math.min(20_000, Math.floor((3 * window) / 10)),
    notesOutput: Math.min(8_192, Math.floor(window / 5)),
  };
}

// The most tokens the context may take before it is compacted, and before a turn's tools are withdrawn: the window less
// the reserve.
export function contextLimit(window: number): number {
  return window - contextBudget(window).reserve;
}
