// Prints a Pencil `execute` snippet that replaces the variables of the open .pen file with the design tokens from
// tokens.json, reads them back, and prints every difference (an empty list means the file matches tokens.json):
//   node design/pencil-variables.mjs           # set, then verify
//   node design/pencil-variables.mjs --check   # verify only
// Pencil variables are flat colors, numbers and strings, so the conversion:
// - names each variable like its CSS variable without the leading `--` (`color.bg.canvas` → `color-bg-canvas`);
// - leaves out `palette.*` and `space.*` (designs use the semantic colors and the `gap.*` / `inset.*` spacing only) and
//   the tokens that only code uses (CODE_ONLY);
// - resolves references, writes colors as hex (#rrggbb, or #rrggbbaa with alpha) and dimensions as px (1rem = 16px);
// - splits a typography token into `<name>-font-family`, `-font-size`, `-font-weight` (string) and `-line-height`
//   (a multiple of the font size); its letter spacing must be 0, which is Pencil's default;
// - splits a shadow into `<name>-color`, `-offset-x`, `-offset-y` and `-blur`; Pencil shadows have no spread, so a
//   shadow with spread is an error.
import { readFileSync } from "node:fs";

const CODE_ONLY = ["duration", "easing", "breakpoint"];
const SKIP = ["palette", "space", ...CODE_ONLY];
const REM = 16;

const tokens = JSON.parse(readFileSync(new URL("tokens.json", import.meta.url), "utf8"));

const flat = new Map();
(function walk(node, path, type) {
  type = node.$type ?? type;
  if ("$value" in node) {
    flat.set(path.join("."), { type, value: node.$value });
    return;
  }
  for (const [key, child] of Object.entries(node)) if (!key.startsWith("$")) walk(child, [...path, key], type);
})(tokens, [], undefined);

const resolve = (value) => {
  for (let seen = 0; typeof value === "string" && /^\{.+\}$/.test(value); seen++) {
    if (seen > 10) throw new Error(`reference loop at ${value}`);
    const target = flat.get(value.slice(1, -1));
    if (!target) throw new Error(`unknown reference ${value}`);
    value = target.value;
  }
  return value;
};
const byte = (c) =>
  Math.round(c * 255)
    .toString(16)
    .padStart(2, "0");
const hex = (value) => {
  const color = resolve(value);
  if (color.colorSpace !== "srgb") throw new Error(`unsupported color ${JSON.stringify(color)}`);
  const alpha = color.alpha ?? 1;
  return `#${color.components.map(byte).join("")}${alpha < 1 ? byte(alpha) : ""}`;
};
const px = (value) => {
  const { value: n, unit } = resolve(value);
  if (unit === "px") return n;
  if (unit === "rem") return n * REM;
  throw new Error(`unsupported unit ${unit}`);
};
const family = (value) => [resolve(value)].flat()[0];

const variables = {};
const put = (name, type, value) => (variables[name] = { type, value });
for (const [path, { type, value }] of flat) {
  if (SKIP.includes(path.split(".")[0])) continue;
  const name = path.replaceAll(".", "-");
  const v = resolve(value);
  if (type === "color") put(name, "color", hex(v));
  else if (type === "dimension") put(name, "number", px(v));
  else if (type === "fontFamily") put(name, "string", family(v));
  else if (type === "typography") {
    put(`${name}-font-family`, "string", family(v.fontFamily));
    put(`${name}-font-size`, "number", px(v.fontSize));
    put(`${name}-font-weight`, "string", String(resolve(v.fontWeight)));
    put(`${name}-line-height`, "number", resolve(v.lineHeight));
    if (px(v.letterSpacing) !== 0) throw new Error(`${path}: letter spacing is not mapped to Pencil yet`);
  } else if (type === "shadow") {
    if (px(v.spread) !== 0) throw new Error(`${path}: Pencil shadows have no spread`);
    put(`${name}-color`, "color", hex(v.color));
    put(`${name}-offset-x`, "number", px(v.offsetX));
    put(`${name}-offset-y`, "number", px(v.offsetY));
    put(`${name}-blur`, "number", px(v.blur));
  } else throw new Error(`${path}: no Pencil mapping for type ${type}`);
}

const expected = JSON.stringify(variables);
const verify = `
const expected = ${expected};
const actual = GetVariables().variables ?? {};
const same = (a, b) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b);
const diff = [];
for (const [name, e] of Object.entries(expected)) {
  const a = actual[name];
  if (!a) diff.push("missing " + name);
  else if (a.type !== e.type || !same(a.value, e.value)) diff.push(name + ": " + JSON.stringify(a) + " != " + JSON.stringify(e));
}
for (const name of Object.keys(actual)) if (!(name in expected)) diff.push("extra " + name);
Print({ variables: Object.keys(expected).length, diff });
`;
const check = process.argv.includes("--check");
console.log((check ? "" : `SetVariables(${expected}, true);`) + verify);
