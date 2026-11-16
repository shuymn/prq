import { expect, it } from "vitest";

declare global {
  interface ImportMeta {
    // Vite's import.meta.glob, as these tests call it (vite/client is not a dependency of this package).
    glob(patterns: string[], options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
  }
}

// The Worker's own sources, read by Vite when the test is transformed.
const sources = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./**/*.d.ts", "!./test/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

// What addresses a Durable Object by name or ID, or reaches for a namespace binding.
const STUB_MAKERS =
  /\b(?:getAgentByName|getServerByName|getByName|idFromName|idFromString|newUniqueId)\b|\benv\.(?:Hub|PrSession)\b/;

function matching(pattern: RegExp): string[] {
  return Object.entries(sources)
    .filter(([, text]) => pattern.test(text))
    .map(([path]) => path)
    .toSorted();
}

it("single stub factory", () => {
  // The scan sees the sources, and its pattern finds the factory itself.
  expect(Object.keys(sources)).toEqual(expect.arrayContaining(["./names.ts", "./index.ts", "./pr-session/index.ts"]));
  expect(matching(STUB_MAKERS)).toEqual(["./names.ts"]);
  // The Agents router makes stubs too; it runs only behind the name check in agents.ts.
  expect(matching(/\brouteAgentRequest\b/)).toEqual(["./agents.ts"]);
});
