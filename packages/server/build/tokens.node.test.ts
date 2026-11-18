import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Rolldown } from "vite";
import { describe, expect, test } from "vitest";

import { tokensCss, tokensPlugin } from "./tokens.ts";

// The web UI's build output (vite.config.ts).
const CLIENT_DIR = fileURLToPath(new URL("../dist/client", import.meta.url));

// The README's table of token names and their CSS (design/README.md, Names): `--name: value` per row.
async function readmeDeclarations(): Promise<string[]> {
  const readme = await readFile(fileURLToPath(new URL("../../../design/README.md", import.meta.url)), "utf8");
  const rows = [...readme.matchAll(/^\| `[a-z0-9.-]+` +\| `(--[a-z0-9-]+: [^`]+)` +\|$/gm)];
  return rows.map(([, declaration = ""]) => declaration);
}

// The tokens' CSS as a production build minifies it: tokensPlugin alone, built by Vite into memory from an entry in the
// OS temp directory.
async function minifiedTokens(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "prq-tokens-"));
  try {
    await writeFile(join(root, "entry.js"), 'import "virtual:prq/tokens.css";\n');
    const output = await build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [tokensPlugin()],
      build: { write: false, rolldownOptions: { input: join(root, "entry.js") } },
    });
    const [result] = Array.isArray(output) ? output : [output];
    if (result === undefined || !("output" in result)) {
      throw new Error("the build wrote no output");
    }
    const css = result.output.find(
      (file): file is Rolldown.OutputAsset => file.type === "asset" && file.fileName.endsWith(".css"),
    );
    if (css === undefined) {
      throw new Error("the build emitted no CSS");
    }
    return String(css.source).trim();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("the tokens' CSS", () => {
  test("holds the README's values in the tokens layer", async () => {
    const declarations = await readmeDeclarations();
    expect(declarations).toHaveLength(6);
    // Each line without its indentation.
    const lines = (await tokensCss()).split("\n").map((line) => line.trim());
    expect(lines.slice(0, 2)).toEqual(["@layer tokens {", ":root {"]);
    for (const declaration of declarations) {
      expect(lines).toContain(`${declaration};`);
    }
  });

  test("is in the production build's stylesheet", async () => {
    // The entry stylesheet, as the built page links it.
    const page = await readFile(join(CLIENT_DIR, "index.html"), "utf8");
    const sheets = [...page.matchAll(/<link rel="stylesheet"[^>]* href="\/([^"]+)"/g)].map(([, href = ""]) => href);
    expect(sheets).toHaveLength(1);
    const production = await readFile(join(CLIENT_DIR, sheets[0] ?? ""), "utf8");
    const tokens = await minifiedTokens();
    expect(tokens).toMatch(/^@layer tokens\{:root\{--/);
    expect(production).toContain(tokens);
  });
});
