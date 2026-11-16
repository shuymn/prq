// Prints the constants pencil-audit.js expects, read from components.md and screens.md, so that
//   { node design/audit-prelude.mjs; cat design/pencil-audit.js; }
// is one snippet for the Pencil MCP `execute` tool.
// - INVENTORY: every component name. The "Name ↔ props" cell of a components.md row holds either full names in code
//   spans (`Message/question/sent`), or a pattern (`Button/<variant>/<size>/<state>`) whose props are listed in the
//   same cell as "`variant`: primary, secondary, ..."; the pattern expands to every combination. A row with neither
//   is the component name alone.
// - SECTIONS: the components.md section headings, which name the root frames that hold the components.
// - FRAMES: the frame names of screens.md (second column of every table row whose first cell is a state ID).
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const cells = (line) =>
  line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim());
const tableRows = (md) => md.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| ---")).map(cells);

const components = read("components.md");
const inventory = [];
for (const [component, names] of tableRows(components)) {
  if (!component || component === "Component") continue;
  const spans = [...names.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const own = spans.filter((s) => s === component || s.startsWith(`${component}/`));
  const literal = own.filter((s) => !s.includes("<"));
  const pattern = own.find((s) => s.includes("<"));
  if (literal.length && (pattern || literal.some((s) => s !== component))) {
    inventory.push(...literal.filter((s) => s !== component));
    continue;
  }
  if (!pattern) {
    inventory.push(component);
    continue;
  }
  const values = {};
  for (const m of names.matchAll(/`([a-z][\w-]*)`: ([a-z0-9-]+(?:, [a-z0-9-]+)*)/g)) values[m[1]] ??= m[2].split(", ");
  let expanded = [pattern];
  for (const prop of [...pattern.matchAll(/<([^>]+)>/g)].map((m) => m[1])) {
    if (!values[prop]) throw new Error(`${component}: no values for <${prop}>`);
    expanded = expanded.flatMap((name) => values[prop].map((v) => name.replace(`<${prop}>`, v)));
  }
  inventory.push(...expanded);
}
const duplicates = inventory.filter((name, i) => inventory.indexOf(name) !== i);
if (duplicates.length) throw new Error(`duplicate component names: ${duplicates.join(", ")}`);

const sections = [...components.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());

const frames = [];
for (const [id, frame] of tableRows(read("screens.md"))) {
  if (id.startsWith("`") && frame && !frames.includes(frame)) frames.push(frame);
}

console.log(`const INVENTORY = ${JSON.stringify(inventory)};`);
console.log(`const SECTIONS = ${JSON.stringify(sections)};`);
console.log(`const FRAMES = ${JSON.stringify(frames)};`);
