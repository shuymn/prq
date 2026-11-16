# Design

The visual design of the web UI and the vocabulary it shares with the code. The screens are designed in the Pencil
document [prq.pen](prq.pen); this directory holds it together with what the code is built from, so that a screen built
from the design looks like the design.

| File                                                                       | What it is                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [tokens.json](tokens.json)                                                 | The design tokens: the single source for the Pencil variables and the CSS custom properties in code                                                                                               |
| [components.md](components.md)                                             | The component inventory: each Pencil component ↔ the code component and its props, the tokens it uses, the `modern-web-guidance` guides it relies on, and whether it must fit the extension panel |
| [screens.md](screens.md)                                                   | Every screen and state in the brief ↔ the Pencil frame that shows it and what the frame must make visible                                                                                         |
| [prq.pen](prq.pen)                                                         | The Pencil document: variables, components and screen frames                                                                                                                                      |
| [pencil-variables.mjs](pencil-variables.mjs)                               | Applies `tokens.json` to the Pencil variables and reports any difference                                                                                                                          |
| [pencil-audit.js](pencil-audit.js), [audit-prelude.mjs](audit-prelude.mjs) | Check the Pencil document against the rules below and against the two tables                                                                                                                      |

The brief the design answers is [docs/ui.md](../docs/ui.md).

## Rules

- **Tokens, then components, then screens.** A screen uses only component instances and variable-bound values. A value
  that is not a token, or an element that is not in the inventory, is added there first.
- **Same names.** A Pencil component is named after the React component, followed by its prop values (see
  [Components](#components)).
- **Semantic tokens only.** Components bind `color.*`, `gap.*`, `inset.*`, `size.*`, `radius.*`, `border-width.*`,
  `text.*` and `shadow.*`. The `palette.*` colors and the `space.*` scale exist only to be referenced by the semantic
  tokens, and Pencil does not get them. Spacing is picked by role: `gap.*` by how closely two siblings belong together
  (tight, related, group, section, page), `inset.*` by the kind of container (inline code, control, multi-line field,
  card, dialog, page, panel).
- **One control size per context.** Medium controls (`size.control.md`) for standalone actions: the toolbar, headers,
  forms, dialog footers and the composer. Small controls (`size.control.sm`) only inside dense content: table and job
  rows, skill rows, inline notices and answer status lines, code blocks. Controls in one row share a size. A list or
  menu item that is itself the target (a version) is `size.control.md` tall.
- **One text style per role.** `text.title`: the page's own title (a page heading, the PR title in the full PR
  header). `text.heading`: section, card and dialog headings, and the PR title in the compact (panel) header.
  `text.body`: content and descriptions; `text.body-strong`: names that identify a row (a PR title in the list, a skill
  name), field and editor labels (so they sit below the section heading), and medium control labels. `text.small`: metadata,
  captions, hints and times, in `color.fg.muted`; `text.small-strong`: table column headings and group labels (muted),
  small control labels, badges and status labels. `text.code` / `text.code-small`: code and SHAs. `text.input`: form
  fields. Every heading of the same level uses the same style on every screen.
- **One radius per kind.** `radius.sm`: inline code and SHAs; `radius.md`: controls, cards, notices, menus and code
  blocks; `radius.lg`: dialogs and popovers; `radius.full`: badges and pills.
- **Dark only.** The host uses dark mode, so there is one color scheme. Code sets `color-scheme: dark`.

## Tokens

### Format

`tokens.json` is a W3C Design Tokens (DTCG 2025.10) file: groups with `$type`, tokens with `$value` and
`$description`, references as `{group.token}`. Colors are sRGB color objects, dimensions `{ "value", "unit" }` objects
(spacing and sizes in `px`, font sizes in `rem`), typography a composite of `fontFamily`, `fontSize`, `fontWeight`,
`lineHeight` and `letterSpacing` (0 everywhere), and motion `duration` and `cubicBezier` tokens.

| Group                                                     | Holds                                                                       | In Pencil                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| `palette`                                                 | The raw colors                                                              | no (referenced by `color.*` only)             |
| `color`, `shadow`                                         | Semantic colors and the overlay shadow                                      | yes                                           |
| `space`                                                   | The spacing scale                                                           | no (referenced by `gap.*` and `inset.*` only) |
| `gap`, `inset`, `size`, `radius`, `border-width`, `focus` | Dimensions (`focus.offset` is the gap between a control and its focus ring) | yes                                           |
| `font`, `text`                                            | Font families and text styles                                               | yes                                           |
| `duration`, `easing`, `breakpoint`                        | Values only code uses (motion, layout breakpoint)                           | no                                            |

### Names

A token's name is its path. Path segments are lowercase letters, digits and `-`. The CSS custom property is `--`
followed by the segments joined with `-`, so two paths must never join to the same name.

| Token            | CSS                                                               |
| ---------------- | ----------------------------------------------------------------- |
| `color.fg.muted` | `--color-fg-muted: #9198a1`                                       |
| `space.3`        | `--space-3: 12px`                                                 |
| `text.body`      | `--text-body: 400 0.875rem/1.5 Inter, system-ui, sans-serif`      |
| `shadow.overlay` | `--shadow-overlay: 0px 8px 24px 0px rgb(0.39% 1.57% 3.53% / 0.8)` |
| `duration.open`  | `--duration-open: 0.1s`                                           |
| `easing.enter`   | `--easing-enter: cubic-bezier(0, 0, 0.2, 1)`                      |

### Generating CSS

The code generates its CSS custom properties from `tokens.json` (set up in #7) with Style Dictionary 5, which reads the
file as it is (`usesDtcg: true`, transform group `css`); the table above is its output. The font family tokens carry
the fallback stacks (Inter and JetBrains Mono are self-hosted). A `text.*` variable is a `font` shorthand, which
cannot hold letter spacing; Style Dictionary warns about it, and the value is 0.

## Pencil

### Keeping the variables in sync

`tokens.json` is the source. Pencil variables are flat colors, numbers and strings, so `pencil-variables.mjs` converts
the tokens: a variable is named like the CSS custom property without `--` (`color-bg-canvas`), dimensions become `px`
(1rem = 16px), a typography token becomes four variables (`text-body-font-family`, `-font-size`, `-font-weight`,
`-line-height`; letter spacing is 0, Pencil's default) and the shadow four (`shadow-overlay-color`, `-offset-x`,
`-offset-y`, `-blur`). Run `node design/pencil-variables.mjs` and pass its output to the Pencil MCP `execute` tool: it
replaces the document's variables and returns the differences that remain. An empty `diff` means Pencil matches the
file; `--check` only compares.

A variable changed in Pencil is copied into `tokens.json` by hand in the same change and synced again.

### Components

Pencil components have no variants, so each combination of a component's props is its own component, named
`<Component>/<value>/…` with the values in the order of the props in [components.md](components.md) (for example
`Button/primary/md/rest`, `Status/running`); a component without props is named `<Component>`. Text and repeated
content are not part of the name: an instance overrides the named text node, and turns off an optional part with
`enabled: false`.

Pencil drops a variable bound to a width or height, so a fixed size is the token's value with the token named in the
node's `context` (`tokens width=size.icon height=size.icon`). A size that fits its content up to a maximum records
`width<=size.column.repo` and shows the fitted width. The audit checks the value against the variable.

An asset drawn on a pixel grid, the BrandMark, is the exception: it stays crisp only at whole multiples of its grid, so
its sizes are not tokens. Each of its nodes records the grid instead (`asset grid=16`, or `asset grid=12x8` for the face
alone, width by height), and the audit accepts any width or height that is a multiple of it. Its colors are variables
like everywhere else. It is also placed on whole pixels: next to a name it centres on the name's cap height, or on its
x-height when the name is lowercase only ("prq"), rounded to the nearest whole pixel; a layout frame around it records
the offset in its `context`.

### Checking the document

`pencil-audit.js` reports every fill, stroke, radius, padding, gap, text property or shadow that is not bound to a
variable, every component that is not in the inventory, and every frame of [screens.md](screens.md) that is missing,
unlisted, has no note, or holds anything other than component instances, layout frames and text. Run it with the Pencil
MCP `execute` tool after the constants printed by `node design/audit-prelude.mjs`; an empty `violations` list means the
document follows the rules and has every frame.

### Document structure

| Root frames                      | Hold                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One per section of components.md | The components of that section                                                                                                                               |
| `<Screen> / <State>`             | A screen state: desktop frames 1440 wide and at least 900 tall, extension panel frames `size.panel` (360) wide and at least 800 tall, clipping their content |
| `Note / <Screen> / <State>`      | Next to each frame, the state IDs it shows and the `modern-web-guidance` guides it relies on                                                                 |

Components are at the top of the canvas and screens below them, one column per screen in the order of
[screens.md](screens.md).

Pencil saves the document as JSON, so changes show in a diff. It also writes a top-level `fileToken`, its handle for
share links and comments; the committed document leaves it out.
