// The names the design and the code share, read from the texts of components.md and screens.md: the Pencil audit's
// prelude (audit-prelude.mjs) reads the files in Node, and the web UI's gallery check
// (packages/server/src/client/gallery/registry.test.tsx) imports them as text in the browser.
// - inventory: every component name. The "Name ↔ props" cell of a components.md row holds either full names in code
//   spans (`Message/question/sent`), or a pattern (`Button/<variant>/<size>/<state>`) whose props are listed in the
//   same cell as "`variant`: primary, secondary, ..."; the pattern expands to every combination. A row with neither
//   is the component name alone.
// - props: each component's props in the order its pattern names them (`Button` → variant, size, state); a component
//   named without a pattern has none.
// - sections: the components.md section headings, which name the root frames that hold the components.
// - stateIds: the state IDs of screens.md (first column of every table row that starts with one), each once.
// - frames: the frame names of screens.md (second column of those rows), each once.

const cells = (line) =>
  line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim());
const tableRows = (md) =>
  md
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
    .map(cells);

export function designNames(componentsMd, screensMd) {
  const inventory = [];
  const props = {};
  for (const [component, names] of tableRows(componentsMd)) {
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
    props[component] = [...pattern.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
    const values = {};
    for (const m of names.matchAll(/`([a-z][\w-]*)`: ([a-z0-9-]+(?:, [a-z0-9-]+)*)/g))
      values[m[1]] ??= m[2].split(", ");
    let expanded = [pattern];
    for (const prop of [...pattern.matchAll(/<([^>]+)>/g)].map((m) => m[1])) {
      if (!values[prop]) throw new Error(`${component}: no values for <${prop}>`);
      expanded = expanded.flatMap((name) => values[prop].map((v) => name.replace(`<${prop}>`, v)));
    }
    inventory.push(...expanded);
  }
  const duplicates = inventory.filter((name, i) => inventory.indexOf(name) !== i);
  if (duplicates.length) throw new Error(`duplicate component names: ${duplicates.join(", ")}`);

  const sections = [...componentsMd.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());

  const stateIds = [];
  const frames = [];
  for (const [id, frame] of tableRows(screensMd)) {
    if (!id.startsWith("`") || !frame) continue;
    const stateId = id.replaceAll("`", "");
    if (!stateIds.includes(stateId)) stateIds.push(stateId);
    if (!frames.includes(frame)) frames.push(frame);
  }
  return { inventory, props, sections, stateIds, frames };
}
