// Prints the constants pencil-audit.js expects, read from components.md and screens.md (inventory.mjs), so that
//   { node design/audit-prelude.mjs; cat design/pencil-audit.js; }
// is one snippet for the Pencil MCP `execute` tool.
// - INVENTORY: every component name.
// - SECTIONS: the components.md section headings, which name the root frames that hold the components.
// - FRAMES: the frame names of screens.md.
import { readFileSync } from "node:fs";

import { designNames } from "./inventory.mjs";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const { inventory, sections, frames } = designNames(read("components.md"), read("screens.md"));

console.log(`const INVENTORY = ${JSON.stringify(inventory)};`);
console.log(`const SECTIONS = ${JSON.stringify(sections)};`);
console.log(`const FRAMES = ${JSON.stringify(frames)};`);
