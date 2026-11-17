import { describe, expect, it } from "vitest";

import { MIN_CONTEXT_TOKENS } from "./config.ts";
import { contextBudget } from "./pr-session/context-budget.ts";

describe("contextBudget", () => {
  it("scales the parameters down with a small window", () => {
    expect(contextBudget(20_000)).toEqual({ reserve: 2_500, keptTail: 6_000, notesOutput: 4_000 });
  });

  it("gives Pi's defaults at Pi's sizes", () => {
    expect(contextBudget(131_072)).toEqual({ reserve: 16_384, keptTail: 20_000, notesOutput: 8_192 });
    expect(contextBudget(1_000_000)).toEqual({ reserve: 16_384, keptTail: 20_000, notesOutput: 8_192 });
  });

  it("keeps the kept tail above the notes output for every window from the floor up", () => {
    const failing: number[] = [];
    for (let window = MIN_CONTEXT_TOKENS; window <= 1_000_000; window += 1) {
      const { keptTail, notesOutput } = contextBudget(window);
      if (keptTail <= notesOutput) {
        failing.push(window);
      }
    }
    expect(failing).toEqual([]);
  });
});
