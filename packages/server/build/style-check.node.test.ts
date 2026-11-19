// The CI's style check (A4) run on fixtures: `stylelint` with stylelint.config.mjs (`pnpm run lint:css`) and
// `oxlint --type-aware --deny-warnings` with .oxlintrc.json (`pnpm run lint`), the repository's configurations as they
// are. A stylesheet goes to stylelint on stdin under a path in the client, so the configuration's overrides apply as
// to a file there; the TSX fixtures sit at their paths under a copy of .oxlintrc.json in the OS temp directory.

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(ROOT, "node_modules", ".bin");
const CLIENT = "packages/server/src/client";

type Run = { code: number; output: string };

function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; input?: string; env?: NodeJS.ProcessEnv },
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd: options.cwd, env: options.env, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: typeof error?.code === "number" ? error.code : 0, output: `${stdout}${stderr}` });
      },
    );
    child.stdin?.end(options.input ?? "");
  });
}

function stylelint(css: string, path = `${CLIENT}/components/Fixture.css`): Promise<Run> {
  return run(join(BIN, "stylelint"), ["--stdin-filename", path], { cwd: ROOT, input: css });
}

// A stylesheet as the components write them.
const NORMAL_CSS = `@layer components {
  [data-component="Fixture"] {
    display: grid;
    grid-template-columns: 1fr var(--size-rail);
    gap: var(--gap-group);
    inline-size: 100%;
    min-block-size: 1lh;
    padding-inline: var(--inset-page);
    font: var(--text-body);
    font-size-adjust: from-font;
    color: var(--color-fg-default);

    & .child {
      max-inline-size: 80ch;
      box-shadow: var(--shadow-overlay);
      opacity: 0;
      z-index: 1;
      font-style: italic;
      fill: currentColor;
      background: transparent;
      ROTATE: 90deg;
      border: var(--border-width-thin) solid var(--color-border-default);
      outline: var(--border-width-thick) solid var(--color-border-focus);
      border-color: var(--color-border-default) var(--color-border-default) var(--color-accent-fg);
    }
  }
}
`;

const declared = (declaration: string) => `@layer components {\n  .fixture {\n    ${declaration}\n  }\n}\n`;

describe("the stylesheet check", () => {
  test("passes a stylesheet written with tokens", async () => {
    expect(await stylelint(NORMAL_CSS)).toEqual({ code: 0, output: "" });
  });

  test.each([
    ["a hex color", "color: #fff;", "color-no-hex"],
    ["a color function", "color: rgb(0 0 0);", "function-disallowed-list"],
    ["a raw length", "margin: 13px;", "unit-allowed-list"],
    ["a percentage size other than 100%", "width: 17%;", "declaration-property-value-allowed-list"],
    ["a raw font family", "font-family: Arial;", "declaration-property-value-allowed-list"],
    [
      "a raw shadow",
      "box-shadow: 0 0 0 var(--border-width-thin) var(--color-border-default);",
      "declaration-property-value-allowed-list",
    ],
    ["a raw length in a custom property", "--x: 17px;", "unit-allowed-list"],
    ["a font name in a custom property", "--x: Arial;", "declaration-property-value-allowed-list"],
    ["a raw length as a fallback", "padding: var(--x, 12px);", "unit-allowed-list"],
    ["an oblique angle", "font-style: oblique 12deg;", "declaration-property-value-allowed-list"],
    ["the mark's offset elsewhere", "translate: 0 1px;", "unit-allowed-list"],
    ["a system color", "color: CanvasText;", "declaration-property-value-allowed-list"],
    ["a raw font family in capitals", "FONT-FAMILY: Arial;", "declaration-property-value-allowed-list"],
    ["an oblique angle in capitals", "FONT-STYLE: oblique 12deg;", "declaration-property-value-allowed-list"],
    ["a property's raw value in capitals", "Z-INDEX: 9;", "declaration-property-value-allowed-list"],
    ["an angle outside a rotation", "transform: rotate(17deg);", "unit-allowed-list"],
    [
      "a system color in a border",
      "border: var(--border-width-thin) solid CanvasText;",
      "declaration-property-value-allowed-list",
    ],
    [
      "a system color in an outline",
      "outline: var(--border-width-thick) solid CanvasText;",
      "declaration-property-value-allowed-list",
    ],
  ])("refuses %s", async (_name, declaration, rule) => {
    const result = await stylelint(declared(declaration));
    expect(result.code).not.toBe(0);
    expect(result.output).toContain(rule);
  });

  test("accepts the AppHeader mark's whole-pixel offset, that value only", async () => {
    const header = `${CLIENT}/components/AppHeader.css`;
    expect(await stylelint(declared("translate: 0 1px;"), header)).toEqual({ code: 0, output: "" });
    const other = await stylelint(declared("translate: 0 2px;"), header);
    expect(other.code).not.toBe(0);
    expect(other.output).toContain("declaration-property-value-allowed-list");
  });
});

// TSX fixtures by path under the client, each with the rules it must break (none for a clean one).
const TSX: Record<string, { source: string; rules: string[] }> = {
  "components/Normal.tsx": {
    source: `export function Normal({ label }: { label: string }) {
  return (
    <div data-component="Normal" data-tone="muted" className="normal">
      <span>{label}</span>
    </div>
  );
}
`,
    rules: [],
  },
  "components/StyleProp.tsx": {
    source: `export const StyleProp = () => <div style={{ color: "red" }} />;\n`,
    rules: ["react(forbid-dom-props)"],
  },
  "components/StyleElement.tsx": {
    source: `export const StyleElement = () => <style>{".x { color: red }"}</style>;\n`,
    rules: ["react(forbid-elements)"],
  },
  "components/Spread.tsx": {
    source: `const boxProps = { style: { color: "red" } };
export const Spread = () => <div {...boxProps} />;
`,
    rules: ["react(jsx-props-no-spreading)"],
  },
  "components/LiteralSpread.tsx": {
    source: `export const LiteralSpread = () => <div {...{ style: { color: "red" } }} />;\n`,
    rules: ["react(jsx-props-no-spreading)"],
  },
  "components/Forwarding.tsx": {
    source: `import { Normal } from "./Normal.tsx";
export const Forwarding = (props: { label: string }) => <Normal {...props} />;
`,
    rules: [],
  },
  "components/Danger.tsx": {
    source: `export const Danger = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n`,
    rules: ["react(no-danger)"],
  },
  "components/Fill.tsx": {
    source: `export const Fill = () => (
  <svg viewBox="0 0 1 1">
    <path fill="#fff" d="M0 0h1v1h-1z" />
  </svg>
);
`,
    rules: ["react(forbid-dom-props)"],
  },
  "components/Sized.tsx": {
    source: `export const Sized = () => <svg width={17} height={17} viewBox="0 0 1 1" />;\n`,
    rules: ["react(forbid-dom-props)"],
  },
  // The mark's SVG sizes are whole multiples of its grid; nothing else about it is exempt.
  "components/BrandMark.tsx": {
    source: `export const BrandMark = () => <svg width={24} height={16} viewBox="2 4 12 8" />;\n`,
    rules: [],
  },
};

describe("the TSX check", () => {
  let root = "";
  let result: Run = { code: 0, output: "" };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "prq-style-check-"));
    await copyFile(join(ROOT, ".oxlintrc.json"), join(root, ".oxlintrc.json"));
    for (const [path, { source }] of Object.entries(TSX)) {
      const file = join(root, CLIENT, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    // The fixtures sit outside the repository, where oxlint cannot find its type-aware helper by itself.
    // The unix format, since oxlint picks its default output by environment (a compact one under an AI agent, a
    // graphical one in CI).
    result = await run(join(BIN, "oxlint"), ["--type-aware", "--deny-warnings", "--format", "unix"], {
      cwd: root,
      env: { ...process.env, OXLINT_TSGOLINT_PATH: join(BIN, "tsgolint") },
    });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test.each(Object.entries(TSX))("%s", (path, { rules }) => {
    const reported = result.output
      .split("\n")
      .filter((line) => line.startsWith(`${CLIENT}/${path}:`))
      .map((line) => /\[Error\/(\S+)\]$/.exec(line)?.[1] ?? line);
    expect([...new Set(reported)]).toEqual(rules);
  });

  test("fails the run", () => {
    expect(result.code).not.toBe(0);
  });
});
