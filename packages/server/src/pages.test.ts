import { describe, expect, it } from "vitest";

import { fitPage, type Page, pageLines, type PageRequest } from "./pr-session/pages.ts";

// The page reader every workspace command's output goes through: whole lines while they fit (numbers and newlines
// counted), the output's end, a prefix removed, the rest counted, a binary output, and a page cut again to less room.
// The tools' paging over it is in tools.test.ts.

function streamOf(text: string, chunk = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

function pageOf(text: string, request: Partial<PageRequest> = {}): Promise<Page> {
  return pageLines(streamOf(text), { start: { line: 1, char: 0 }, capChars: 1000, ...request });
}

describe("page reader", () => {
  it("collects whole lines while they fit, counting each line's number and newline", async () => {
    // Lines of 9 characters: "1\t" + 9 + newline is 12; four fit in 48, the fifth does not.
    const page = await pageOf("aaaaaaaaa\n".repeat(6), { capChars: 50, numbered: true, countRest: true });

    expect(page.lines).toHaveLength(4);
    expect(page.next).toEqual({ line: 5, char: 0 });
    expect(page.rest).toBe(2);
  });

  it("reads to the end of the output and knows its line count", async () => {
    expect(await pageOf("a\nb\n")).toMatchObject({ lines: ["a", "b"], next: null, lineCount: 2 });
    expect(await pageOf("a\nb")).toMatchObject({ lines: ["a", "b"], next: null, lineCount: 2 });
    expect(await pageOf("")).toMatchObject({ lines: [], next: null, lineCount: 0 });
    expect(await pageOf("a\n\nb\n", { start: { line: 2, char: 0 } })).toMatchObject({ lines: ["", "b"], next: null });
    expect(await pageOf("a\n", { start: { line: 5, char: 0 } })).toMatchObject({ lines: [], next: null, lineCount: 1 });
  });

  it("removes a prefix from each line and counts the rest of the output", async () => {
    const page = await pageOf("t:a:1:x\nt:b:2:y\nt:c:3:z\n", { stripPrefix: "t:", capChars: 15, countRest: true });

    expect(page.lines).toEqual(["a:1:x", "b:2:y"]);
    expect(page.rest).toBe(1);
  });

  it("reports a binary output's size and collects nothing", async () => {
    const page = await pageLines(streamOf(`PNG\u0000${"x".repeat(20_000)}`, 4096), {
      start: { line: 1, char: 0 },
      capChars: 100,
      detectBinary: true,
    });

    expect(page).toMatchObject({ lines: [], binaryBytes: 20_004 });
  });

  it("cuts a page again to a smaller room by the same rule", async () => {
    const page = await pageOf("aaaa\nbbbb\ncccc\n", { countRest: true });

    expect(fitPage(page, 11, false)).toMatchObject({ lines: ["aaaa", "bbbb"], next: { line: 3, char: 0 }, rest: 1 });
    expect(fitPage(page, 3, false)).toMatchObject({ lines: ["aa"], next: { line: 1, char: 2 }, rest: 3 });
    expect(fitPage(page, 100, false)).toBe(page);
  });
});
