import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { HEADER_RULES_MAX, headersText } from "./static-assets.ts";

const BASE = await readFile(fileURLToPath(new URL("../src/client/public/_headers", import.meta.url)), "utf8");

// The `_headers` for a build that emitted these files.
const headersFor = (files: string[]) => headersText(BASE, "assets", files);

const assets = (count: number) => Array.from({ length: count }, (_, i) => `assets/chunk-${i}.js`);

describe("the generated _headers", () => {
  test("keeps the rules for every path, then makes each emitted asset immutable", () => {
    const headers = headersFor(["index.html", "assets/index-a1.js", "assets/index-b2.css"]);
    expect(headers).toMatch(/^# .*\n(?:#.*\n)*\/\*\n {2}Cache-Control: no-cache\n/);
    expect(headers).toContain(
      "/assets/index-a1.js\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n",
    );
    expect(headers).toContain(
      "/assets/index-b2.css\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n",
    );
    expect(headers).not.toContain("/index.html");
  });

  test("fails the build past the platform's rule limit, not at it", () => {
    // public/_headers holds one rule, for every path.
    expect(headersFor(assets(HEADER_RULES_MAX - 1))).toContain("/assets/chunk-98.js");
    expect(() => headersFor(assets(HEADER_RULES_MAX))).toThrow(`_headers would hold ${HEADER_RULES_MAX + 1} rules`);
  });
});
