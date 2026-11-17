import { MAX_ANSWER_CHARS } from "@prq/protocol";
import { describe, expect, it } from "vitest";

import { checkAnswer } from "./answer.ts";

describe("checkAnswer", () => {
  it("takes up to MAX_ANSWER_CHARS UTF-16 code units, as written", () => {
    const longest = `${"\u{1F600}".repeat(10)}${"x".repeat(MAX_ANSWER_CHARS - 20)}`;
    expect(checkAnswer(longest, "answer.md")).toBe(longest);
    expect(checkAnswer(" an answer\n", "answer.md")).toBe(" an answer\n");
  });

  it("refuses one unit more", () => {
    expect(() => checkAnswer(`\u{1F600}${"x".repeat(MAX_ANSWER_CHARS - 1)}`, "answer.md")).toThrow(
      `the answer in answer.md has ${MAX_ANSWER_CHARS + 1} characters (UTF-16 code units), more than ${MAX_ANSWER_CHARS}`,
    );
  });

  it.each(["", " ", "\n\t \r\n"])("refuses a blank answer %j", (text) => {
    expect(() => checkAnswer(text, "answer.md")).toThrow("the answer in answer.md is blank");
  });
});
