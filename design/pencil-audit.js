// Audits the Pencil document against the design rules (README.md) and prints the result. Run it with the Pencil MCP
// `execute` tool after the constants that audit-prelude.mjs prints:
//   { node design/audit-prelude.mjs; cat design/pencil-audit.js; }
// It prints { violations, counts }; an empty `violations` means:
// - every fill, stroke color, stroke width, corner radius, padding, gap, text property (family, size, weight, line
//   height, letter spacing) and shadow on every node, and in every instance override, is a "$…" variable that exists,
//   except a raw 0; fills are colors, not gradients or images; no variable is a palette color or a space step, and none
//   of those is defined (Pencil drops a binding to a variable that does not exist, so a `$space-*` binding survives
//   only while `space-*` variables are defined, and then both are reported);
// - every fixed width or height is the value of the size token recorded in the node's context
//   (`context: "tokens width=size.icon height=size.icon"`), or at most its value when the size fits the content up to a
//   maximum (`width<=size.column.repo`), because Pencil drops variable bindings on sizes; an asset drawn on a pixel grid
//   (the BrandMark) records the grid instead (`context: "asset grid=16"`, or `asset grid=12x8` for a width and a height)
//   and may take any whole multiple of it; the
//   exceptions are the screen frames themselves, whose sizes are canvas sizes rather than tokens: a desktop frame is
//   1440 wide and at least 900 tall, a panel frame `size.panel` wide (recorded in its context) and at least 800 tall,
//   and every screen frame clips its content;
// - every component is named in the inventory (INVENTORY), once, and every inventory name is a component;
// - every frame listed in screens.md exists;
// - every root node is a component section frame (SECTIONS), a screen frame listed in screens.md (FRAMES), or a Note
//   instance named `Note / <frame>` for a listed frame; every screen frame has its note; inside a screen frame there are
//   only instances of inventory components, layout frames and text (no shapes, paths, icons, nested components, or
//   frames named like a component, which are detached copies).
// What it cannot tell: sizing behaviors (`fit_content`, `fill_container`) are not checked, including a fallback such as
// `fill_container(1440)`, which the dialog backdrop in `Settings / Remove skill` needs because an absolutely positioned
// node cannot fill its parent; positions (x/y) are not checked; a layout frame that redraws a component by hand is caught
// only when it is named like the component; replacement nodes inside an instance's `descendants` are checked for bound
// values but not for being inventory components; and overridden text is not checked against the component's meaning.

const VARS = GetVariables().variables ?? {};
const inventory = new Set(INVENTORY);
const frames = new Set(FRAMES);
const sections = new Set(SECTIONS);
const violations = [];
const counts = { nodes: 0, components: 0, sections: 0, screens: 0, notes: 0 };

const where = (c) => {
  const names = [];
  for (let x = c; x; x = x.parentCtx) names.unshift(x.node.name ?? x.node.id);
  return names.join(" / ");
};
const isVar = (v) => typeof v === "string" && v.startsWith("$");
const RAW_SCALE = /^(palette|space)-/;

function value(at, prop, v, zeroOk = true) {
  if (v === undefined) return;
  if (isVar(v)) {
    const name = v.slice(1);
    if (!(name in VARS)) violations.push(`unknown variable ${v} (${prop}): ${at}`);
    else if (RAW_SCALE.test(name)) violations.push(`${name.split("-")[0]} variable ${v} (${prop}): ${at}`);
  } else if (!(zeroOk && v === 0)) {
    violations.push(`unbound ${prop} ${JSON.stringify(v)}: ${at}`);
  }
}
const list = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
function paint(at, prop, fills) {
  for (const f of list(fills)) {
    if (typeof f === "string") value(at, prop, f, false);
    else if (f && f.type === "color") value(at, prop, f.color, false);
    else if (f) violations.push(`${prop} of type ${f.type}: ${at}`);
  }
}
function size(at, n, prop) {
  const v = n[prop];
  if (typeof v !== "number" || v === 0) return;
  if (n.type === "text" && (n.textGrowth ?? "auto") === "auto") return;
  const [, gridW, gridH] = String(n.context ?? "").match(/^asset grid=(\d+)(?:x(\d+))?\b/) ?? [];
  if (gridW) {
    const grid = Number(prop === "height" ? (gridH ?? gridW) : gridW);
    if (v % grid !== 0) violations.push(`${prop} ${v} is not a multiple of the asset grid ${grid}: ${at}`);
    return;
  }
  const [, max, token] = String(n.context ?? "").match(new RegExp(`^tokens\\b.*\\b${prop}(<?)=([\\w.-]+)`)) ?? [];
  if (!token) {
    violations.push(`fixed ${prop} ${v} without a size token in context: ${at}`);
    return;
  }
  const variable = VARS[token.replaceAll(".", "-")];
  if (!variable) violations.push(`unknown size token ${token} (${prop}): ${at}`);
  else if (max ? v > variable.value : variable.value !== v) {
    violations.push(`${prop} ${v} ${max ? ">" : "!="} ${token} (${variable.value}): ${at}`);
  }
}
const DESKTOP_WIDTH = 1440;
function screen(at, n, bounds) {
  if (n.type !== "frame") return;
  if (n.clip !== true) violations.push(`screen frame without clip: ${at}`);
  if (n.width === DESKTOP_WIDTH) {
    if (bounds.height < 900) violations.push(`desktop frame shorter than 900: ${at}`);
    return;
  }
  if (!/^tokens\b.*\bwidth=size\.panel\b/.test(String(n.context ?? ""))) {
    violations.push(`screen frame neither ${DESKTOP_WIDTH} nor size.panel wide: ${at}`);
  } else size(at, n, "width");
  if (bounds.height < 800) violations.push(`panel frame shorter than 800: ${at}`);
}
const TEXT = ["fontFamily", "fontSize", "fontWeight", "lineHeight"];
function props(at, n, full, isScreen = false) {
  paint(at, "fill", n.fill);
  paint(at, "stroke", n.stroke);
  const sw = n.strokeWidth;
  if (sw && typeof sw === "object") for (const [side, v] of Object.entries(sw)) value(at, `strokeWidth.${side}`, v);
  else value(at, "strokeWidth", sw);
  for (const v of list(n.cornerRadius)) value(at, "cornerRadius", v);
  for (const v of list(n.padding)) value(at, "padding", v);
  value(at, "gap", n.gap);
  for (const p of TEXT) {
    if (n[p] !== undefined) value(at, p, n[p], false);
    else if (full && n.type === "text") violations.push(`text without ${p}: ${at}`);
  }
  value(at, "letterSpacing", n.letterSpacing);
  for (const e of list(n.effect)) {
    if (e.type === "shadow") {
      value(at, "shadow offset x", e.offset?.x);
      value(at, "shadow offset y", e.offset?.y);
      value(at, "shadow blur", e.blur);
      value(at, "shadow color", e.color, false);
    } else if (e.type === "blur" || e.type === "background_blur") value(at, `${e.type} radius`, e.radius);
    else violations.push(`effect of type ${e.type}: ${at}`);
  }
  if (!isScreen) {
    size(at, n, "width");
    size(at, n, "height");
  }
  if (n.type === "icon") violations.push(`library icon (use an Icon component): ${at}`);
  for (const [key, o] of Object.entries(n.descendants ?? {})) tree(`${at} > ${key}`, o, Boolean(o.type));
}
function tree(at, n, full) {
  props(at, n, full);
  for (const child of n.children ?? [])
    if (typeof child === "object") tree(`${at} / ${child.name ?? child.id}`, child, true);
}

for (const name of Object.keys(VARS))
  if (RAW_SCALE.test(name)) violations.push(`${name.split("-")[0]} variable defined: ${name}`);

const componentName = new Map();
Get((n) => {
  if (n.reusable) componentName.set(n.id, n.name);
});
const seen = new Map();
const roots = new Map();
Get((n, c) => {
  counts.nodes++;
  const at = where(c);
  const isScreen = !c.parentCtx && frames.has(n.name);
  props(at, n, true, isScreen);
  if (isScreen) screen(at, n, c.bounds);
  if (n.reusable) {
    counts.components++;
    seen.set(n.name, (seen.get(n.name) ?? 0) + 1);
    if (!inventory.has(n.name)) violations.push(`component not in the inventory: ${at}`);
  }
  if (!c.parentCtx) {
    roots.set(n.name, n);
    return;
  }
  let root = c;
  while (root.parentCtx) root = root.parentCtx;
  if (!frames.has(root.node.name)) return;
  if (n.type === "ref") {
    const target = componentName.get(n.ref);
    if (!target || !inventory.has(target))
      violations.push(`instance of ${target ?? n.ref}, not an inventory component: ${at}`);
  } else if (n.type === "frame") {
    if (n.reusable) violations.push(`component defined inside a screen: ${at}`);
    else if (inventory.has(n.name)) violations.push(`frame named like a component (detached copy?): ${at}`);
  } else if (n.type !== "text")
    violations.push(`${n.type} in a screen (only instances, layout frames and text): ${at}`);
});
for (const [name, count] of seen) if (count > 1) violations.push(`component defined ${count} times: ${name}`);
for (const name of inventory) if (!seen.has(name)) violations.push(`missing component: ${name}`);

for (const [name, n] of roots) {
  if (sections.has(name)) {
    counts.sections++;
    if (n.type !== "frame") violations.push(`section is not a frame: ${name}`);
  } else if (frames.has(name)) {
    counts.screens++;
    if (n.type !== "frame") violations.push(`screen is not a frame: ${name}`);
    if (!roots.has(`Note / ${name}`)) violations.push(`missing note: Note / ${name}`);
  } else if (name?.startsWith("Note / ") && frames.has(name.slice("Note / ".length))) {
    counts.notes++;
    if (n.type !== "ref" || componentName.get(n.ref) !== "Note")
      violations.push(`note is not a Note instance: ${name}`);
  } else violations.push(`unlisted root node: ${name}`);
}
for (const f of FRAMES) if (!roots.has(f)) violations.push(`missing frame: ${f}`);

Print(JSON.stringify({ violations, counts }));
