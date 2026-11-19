// The gallery stays out of the product (plan P2.11): the production build emits no file of it, and no module of it is
// in the build's graph, so no module of the app imports the registry.

import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Rolldown } from "vite";
import { build } from "vite";
import { describe, expect, test } from "vitest";

const CONFIG = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
const CLIENT_OUT = fileURLToPath(new URL("../dist/client", import.meta.url));
const GALLERY = fileURLToPath(new URL("../src/client/gallery/", import.meta.url));

describe("the production build", () => {
  test("the built client holds no gallery file", async () => {
    const files = await readdir(CLIENT_OUT, { recursive: true });
    expect(files).toContain("index.html");
    expect(files.filter((file) => file.toLowerCase().includes("gallery"))).toEqual([]);
  });

  test("no module of the gallery is in the build's graph", async () => {
    // Built in memory: dist/client, which other tests serve, is left as it is.
    const result = await build({
      configFile: CONFIG,
      mode: "production",
      logLevel: "silent",
      build: { write: false, emptyOutDir: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]).filter(
      (output): output is Rolldown.RolldownOutput => "output" in output,
    );
    const chunks = outputs.flatMap(({ output }) => output.filter((item) => item.type === "chunk"));
    const modules = chunks.flatMap((chunk) => chunk.moduleIds);
    expect(modules.some((id) => id.endsWith("src/client/App.tsx"))).toBe(true);
    expect(modules.filter((id) => id.startsWith(GALLERY))).toEqual([]);
    expect(
      outputs.flatMap(({ output }) => output.map((item) => item.fileName)).filter((name) => name.includes("gallery")),
    ).toEqual([]);
  }, 60_000);
});
