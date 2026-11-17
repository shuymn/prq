import { afterEach, describe, expect, it, vi } from "vitest";

import { CHECK_WINDOW, checkTools } from "../scripts/tools-report.ts";
import { contextBudget } from "./pr-session/context-budget.ts";
import { CHARS_PER_TOKEN } from "./pr-session/room.ts";
import { answerScript, finish, ScriptedModel, text, toolCall } from "./test/model.ts";
import { TEST_KEY } from "./test/provider.ts";

// The manual tools check (scripts/tools-check.ts) against a scripted model: what it reports of the production tool
// loop, when it counts the turn as answered, and that it never prints the key.

afterEach(() => {
  vi.restoreAllMocks();
});

// The usage of a step that leaves `left` characters of room in the check's window.
function leaving(left: number) {
  return { input: CHECK_WINDOW - contextBudget(CHECK_WINDOW).reserve - left / CHARS_PER_TOKEN - 50, output: 50 };
}

async function report(model: ScriptedModel, secret?: string) {
  const lines: string[] = [];
  const ok = await checkTools(model.model, (line) => lines.push(line), secret === undefined ? {} : { secret });
  return { ok, report: lines.join("\n") };
}

describe("tools check", () => {
  it("reports each step, the cut for the room, the withdrawn tools and the answer", async () => {
    const model = new ScriptedModel().add(
      [toolCall("diff", { path: "src/catalog.ts" }), finish("tool-calls", leaving(3000))],
      answerScript("Item 115 rose the most."),
    );

    const { ok, report: shown } = await report(model);

    expect(shown).toContain("step 1: tools offered; finish tool-calls");
    expect(shown).toMatch(/diff \{"path":"src\/catalog.ts"\} → \d+ characters, cut: no room left/);
    expect(shown).toContain("step 2: no tools offered; finish stop");
    expect(shown).toContain("tools withdrawn: from step 2 (no tools offered)");
    expect(shown).toContain("  Item 115 rose the most.");
    expect(shown).toContain("answered: yes");
    expect(ok).toBe(true);
    expect(model.calls.map((call) => call.tools?.length ?? 0)).toEqual([4, 0]);
  });

  it("does not count an answer cut at the output limit, and never prints the key", async () => {
    const model = new ScriptedModel().add([...text(`echoing ${TEST_KEY}`), finish("length")]);

    const { ok, report: shown } = await report(model, TEST_KEY);

    expect(shown).toContain("finish reason: length");
    expect(shown).toContain("echoing [redacted]");
    expect(shown).toContain("answered: NO");
    expect(shown).not.toContain(TEST_KEY.slice(0, 8));
    expect(ok).toBe(false);
  });
});
