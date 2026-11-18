import { describe, expect, it } from "vitest";

import { activationOf } from "./skill-smoke.ts";

// How the skills smoke (skill-smoke.ts) reads an answer's stored parts: a delivered page of the skill must come before
// the first text the author sees, and the pages are followed from the body's start to the page that ends it.

const SHA = "a".repeat(40);
const HEADER = "From nanaism/yomiyasu, skills/yomiyasu.\nRead its files …\nIt runs no scripts here: …";

function activation(output: string, input: Record<string, unknown> = {}) {
  return { type: "tool-activate_skill", state: "output-available", input: { name: "yomiyasu", ...input }, output };
}

const FIRST = activation(
  `[activate_skill skill yomiyasu at ${SHA} rev 1: read]\n${HEADER}\nrule 1\n[truncated inside line 95; call again with startLine 95 and startChar 40]`,
);
const SECOND = activation(`[activate_skill skill yomiyasu at ${SHA} rev 1: read]\nrest of line 95\nlast rule\n`, {
  startLine: 95,
  startChar: 40,
});
const STEP = { type: "step-start" };

describe("an answer's activation of the skill", () => {
  it("holds when a delivered page comes before the first text, and follows the pages to the body's end", () => {
    const read = activationOf(
      [STEP, FIRST, STEP, SECOND, STEP, { type: "text", text: "Polished answer." }],
      "yomiyasu",
    );

    expect(read).toMatchObject({ firstText: 5, beforeText: true, wholeBody: true, text: "Polished answer." });
    expect(
      read.activations.map(({ at, outcome, startLine, startChar }) => [at, outcome, startLine, startChar]),
    ).toEqual([
      [1, "read", 1, 0],
      [3, "read", 95, 40],
    ]);
  });

  it("rejects an answer that wrote a draft before activating, whose text the author sees whole", () => {
    const read = activationOf(
      [STEP, { type: "text", text: "Unpolished draft." }, FIRST, STEP, SECOND, STEP, { type: "text", text: "Done." }],
      "yomiyasu",
    );

    expect(read).toMatchObject({ firstText: 1, beforeText: false, wholeBody: true, text: "Unpolished draft.Done." });
  });

  it("rejects a draft written in the step that called the skill, whose result the model read only in the next", () => {
    const read = activationOf(
      [STEP, FIRST, { type: "text", text: "Unpolished draft." }, STEP, SECOND, STEP, { type: "text", text: "Done." }],
      "yomiyasu",
    );

    expect(read).toMatchObject({ firstText: 2, beforeText: false, wholeBody: true });
  });

  it("tells a body read only in part, and counts neither a page that was not delivered nor blank text", () => {
    const partial = activationOf(
      [STEP, { type: "text", text: "\n" }, FIRST, STEP, { type: "text", text: "A." }],
      "yomiyasu",
    );
    const refused = activationOf(
      [
        STEP,
        activation(`[activate_skill skill yomiyasu at ${SHA} rev 1: no room]\n[no room left …]`),
        STEP,
        { type: "text", text: "A." },
      ],
      "yomiyasu",
    );

    expect(partial).toMatchObject({ firstText: 4, beforeText: true, wholeBody: false });
    expect(refused).toMatchObject({ beforeText: false, wholeBody: false });
    expect(refused.activations.map((entry) => entry.outcome)).toEqual(["no room"]);
  });
});
