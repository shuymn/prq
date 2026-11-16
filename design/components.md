# Component inventory

Every reusable element of the web UI, as it exists in the Pencil document [prq.pen](prq.pen) and as it will exist in
code. Pencil has no variants, so each combination of a component's props is its own Pencil component, named after the
React component followed by the prop values; the props keep their names and values in code. Screens are built only
from these components and the tokens in [tokens.json](tokens.json); an element or value that is missing is added here
or to the tokens first. How the pieces fit together is in [README.md](README.md).

The components sit at the top of the canvas, one root frame per section below (`Foundations`, `Status and labels`, ...)
with a title and the components in rows.

Columns:

- **Name ↔ props:** the Pencil name pattern, then each prop in the pattern and its values. In code, each `<prop>` is a
  prop of the same name. Text and repeated content are not part of the name: an instance overrides the named text node
  (for example `label`, `title`, `sha`) and turns off an optional node with `enabled: false`. A component without
  props is named like the React component.
- **Tokens:** the semantic tokens the component binds (palette tokens are never bound directly), by token path. In
  Pencil a token is the variable named like its CSS custom property (`color.fg.muted` → `$color-fg-muted`, typography
  split into `text-body-font-size` and so on).
- **Guides:** the `modern-web-guidance` guide IDs the design relies on. The implementation (#7) retrieves them again.
- **Panel:** **yes** when the component must work in the extension side panel (360px wide).

Pencil keeps variable bindings on fills, strokes, stroke widths, radii, padding, gaps, text properties and shadows, but
drops them on `width` and `height`. A fixed size that a token covers is therefore the token's value with the token
recorded in the node's `context`, `tokens width=size.icon height=size.icon`; [pencil-audit.js](pencil-audit.js) checks
that the number matches the variable. (`context` rather than `metadata`, because `execute` can set `metadata` only when
it inserts a node.)

## Foundations

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| Icon | `Icon/<name>` — `name`: git-pull-request, git-merge, git-pull-request-closed, clock, x-circle, check-circle, alert, circle-slash, device-desktop, cloud, plug, sync, link-external, copy, check, x, chevron-down, chevron-right, info, history, comment, plus, trash, arrow-up, tools, repo, dot-fill, shield-check, file-code | `size.icon`; the path `glyph` is `color.fg.default`, and the parent overrides it with `color.fg.*` or a status `fg` | icons, color | yes |
| Spinner | `Spinner` — no props | `size.icon`, `color.border.default` (`track`), `color.accent.fg` (`arc`), `border-width.thick`; code: `duration.spinner`, `duration.spinner-reduced` | spinner, motion | yes |

Icons are GitHub Octicons 19 (MIT), 16px, drawn as the Octicon's SVG path. A component that shows an icon holds an
`Icon/<name>` instance named `icon` (or after its role, such as `chevron`); a screen swaps it by replacing that node
with another `Icon/<name>` instance.

## Status and labels

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| Status | `Status/<state>` — `state`: done, running, waiting, stalled, failed, superseded | `text.small-strong`, `space.1`; per state: success, accent, `fg.muted`, attention, danger, `fg.muted` (`fg`) | color, spinner | yes |
| Badge | `Badge/<tone>` — `tone`: neutral, accent, success, attention, danger, done | `text.small-strong`, `<tone>.bg` + `<tone>.fg` (neutral: `bg.muted` + `fg.default`), `radius.full`, `space.2` | color, single-line-overflow | yes |
| PrStateLabel | `PrStateLabel/<state>` — `state`: open, merged, closed | `text.small-strong`, `success.emphasis` / `done.emphasis` / `danger.emphasis`, `fg.on-emphasis` (text and icon), `radius.full`, `space.2`, `space.1` | color | yes |
| Sha | `Sha` — no props | `text.code-small`, `fg.default`, `bg.muted`, `radius.sm`, `space.1` | single-line-overflow, interest-triggered-tooltips | yes |
| RelativeTime | `RelativeTime` — no props | `text.small`, `fg.muted` | calculate-event-differentials, interest-triggered-tooltips | yes |

Status never relies on color alone: every state has its own icon (running: Spinner) and a text label (`label`).
PrStateLabel shows the PR state's Octicon (git-pull-request, git-merge, git-pull-request-closed) before its label.

## Controls

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| Button | `Button/<variant>/<size>/<state>` — `variant`: primary, secondary, danger, invisible; `size`: md, sm; `state`: rest, hover, focus, disabled, busy (state is a design-only axis: in code it is CSS state, `disabled` and `busy` are props) | `accent.emphasis(-hover)`, `danger.emphasis(-hover)`, `bg.subtle`, `bg.muted`, `border.default`, `fg.on-emphasis`, `fg.default`, `fg.disabled`, `size.control.md/sm`, `radius.md`, `space.3` / `space.2` (padding md/sm), `space.2` / `space.1` (gap md/sm), `text.body-strong` / `text.small-strong`; focus ring `border.focus` + `border-width.thick`, `radius.lg`, gap `focus.offset`; busy: Spinner | natural-interactions, accessibility, forms | yes |
| IconButton | `IconButton/<variant>/<size>/<state>` — `variant`: invisible, secondary; `size`: md, sm; `state`: rest, hover, focus (design-only, as in Button); icon and accessible name are props | `bg.subtle`, `bg.muted` (hover), `border.default`, `fg.muted` / `fg.default` (glyph), `border.focus` + `border-width.thick`, `focus.offset`, `size.control.md/sm` (square), `radius.md`, `radius.lg` (focus ring) | natural-interactions, accessibility, icons, interest-triggered-tooltips | yes |
| SegmentedControl | `SegmentedControl/<selected>` — `selected`: first, second; labels are props (`Open`, `All`) | `bg.subtle` + `border.default` + `border-width.thin` (track), `bg.muted` + a bottom indicator `accent.fg` + `border-width.thick` (selected segment), `fg.default` / `fg.muted`, `text.small-strong`, `size.control.sm` (segment), `space.1`, `space.3`, `radius.md` / `radius.sm` | accessibility, color (selection is fill and indicator, never weight or size) | yes |

Button looks: primary and danger are filled (`accent.emphasis`, `danger.emphasis`; hover the `-hover` token) with
`fg.on-emphasis`; secondary is `bg.subtle` with a `border.default` border and `fg.default` (hover `bg.muted`); invisible
has no fill and `fg.default` (hover `bg.muted`). Disabled is `bg.subtle` + `border.default` with `fg.disabled`
(invisible: `fg.disabled` only). Busy puts a Spinner (`spinner`) before the label, its arc in the label color. The text
node is `label`.

The focus state draws the outline the code draws with `:focus-visible`: the button sits in a `focus-offset` frame inside
a ring frame (the component root) with a `border.focus` inner stroke of `border-width.thick` and `radius.lg`. The ring
frame's padding is the ring width (`border-width.thick`) and the `focus-offset` frame's padding is the gap
(`focus.offset`, 2px). The focus component is therefore 8px larger than the button; in code the outline takes no space.

The selected segment of SegmentedControl and the current page in AppHeader carry a bottom indicator, a one-side stroke
of `border-width.thick` in `accent.fg` (5.59:1 against `bg.subtle`), because their `bg.muted` fill alone is 1.16:1 and
WCAG 1.4.11 asks for 3:1. A screen that marks another nav item current moves the fill and turns the stroke on there.

## Feedback

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| Notice | `Notice/<tone>` — `tone`: info, attention, danger; `title`, `text` and optional `actions` (Button sm) are props | `<tone>.bg` fill (info: `accent.bg`), icon in `<tone>.fg` (info, alert, x-circle), `text.body-strong` (title), `text.body` (text), `fg.default`, `space.3`, `space.2`, `space.1`, `space.6` (text indent under the title), `radius.md`; `size.panel` (default width) | persistent-toast-notifications (critical states are inline), color, icons | yes |
| ConnectionBanner | `ConnectionBanner/<state>` — `state`: reconnecting, offline; offline has a "Retry now" Button sm | `attention.bg` / `danger.bg`, icon `plug` in `attention.fg` / `danger.fg`, `text.body`, `fg.default`, `space.4`, `space.2`; `size.panel` (default width) | persistent-toast-notifications, accessibility (assertive announcement on drop), color | yes |
| EmptyState | `EmptyState` — no props (`icon`, `title`, `text` and optional `actions` are props) | `border.muted` + `border-width.thin`, `fg.muted` (icon, text), `fg.default` + `text.heading` (title), `text.body`, `space.8`, `space.6`, `space.2`, `radius.md`; `size.panel` (default width) | card, typography | yes |
| Skeleton | `Skeleton/<shape>` — `shape`: line, block | `color.skeleton`, `radius.sm` (line) / `radius.md` (block) | motion (static or short shimmer) | yes |

Notice puts its icon and title in a `header` row and indents `text` and `actions` by `space.6` (icon plus gap), so the
text lines up under the title. Skeleton has no size tokens of its own: the component borrows `size.icon` (line height),
`size.header` (block height) and `size.popover` (width) as defaults, and screens size each instance to the content it
stands in for.

## Layout and navigation

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| AppHeader | `AppHeader` — no props (desktop; the current page and the pool status are props) | `bg.subtle`, `size.header` (height), `size.content` (default width; fills the page), `text.heading` (`product`), nav items `text.body-strong` with `fg.default` + `bg.muted` + a bottom indicator `accent.fg` + `border-width.thick` (current) / `fg.muted`, `size.control.md`, `radius.md`, `space.4`, `space.2`, `space.1`; contains PoolStatus `form=button` (`pool-status`) | navbar (current page marked by fill and indicator, not color alone), accessibility | no |
| PoolStatus | `PoolStatus/<form>/<state>` — `form`: button, line; `state`: local, cloud-only, unavailable, loading | button: `border.default` + `border-width.thin`, `radius.md`, `size.control.md`, `space.3`, `space.2`, `text.small-strong` (`label`), `text.small` + `fg.muted` (`jobs`, e.g. "1 running · 2 waiting"; off when unavailable or loading), chevron-down; line: `text.small`, `fg.muted`, `space.1`; dot-fill icon (`dot`) in `success.fg` (local) or `fg.muted`; loading uses Spinner | declarative-dialog-popover-control, viewport-aware-dropdowns, color (state is in the label), calculate-event-differentials | yes (`form=line`) |
| PoolPopover | `PoolPopover/<state>` — `state`: local, cloud-only, unavailable | `size.popover`, `bg.overlay`, `border.default` + `border-width.thin`, `radius.lg`, `shadow.overlay`, `space.4`, `space.2`, `space.1`; section headings `text.small-strong` + `fg.muted`; agent rows: device-desktop icon, agent ID `text.small-strong`, job and last seen `text.small` + `fg.muted`; cloud row: cloud icon + "Available"; jobs in flight: Badge neutral / accent / danger; cloud-only: "No local agent present. New PRs go to cloud; existing local sessions wait until their agent returns."; unavailable: Notice attention (no actions) and the cloud row | viewport-aware-dropdowns (centered or bottom fallback), declarative-dialog-popover-control, natural-interactions (Esc closes), calculate-event-differentials | yes (fits 320px) |
| Disclosure | `Disclosure/<open>` — `open`: true, false (label, meta and content are props) | chevron-right / chevron-down in `fg.muted`, `text.body-strong` (`label`), `text.small` + `fg.muted` (`meta`), `text.body` content indented `space.6`, `space.2`, `space.1`; `summary` row `size.control.sm` high (the 24px target); `size.panel` (default width) | accordion (chevron before the label, built on `<details>`), search-hidden-content | yes |

A frame that puts a component inside a Disclosure (the Summary in the panel) replaces the instance's `content` node
with that component's instance (a `descendants` entry with `type`). In code the content is the Disclosure's children.

## PR list

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| PrTableHeader | `PrTableHeader` — no props | `bg.subtle`, `text.small-strong` + `fg.muted`, `space.4`, `space.3`, `space.2`, Analysis and Updated headings in a `size.rail` wide cell (`rail`, as PrRow), Updated right-aligned, bottom rule `border.default` + `border-width.thin`, `size.content` (default width) | responsive-table (sticky header row, opaque background) | no |
| PrRow | `PrRow` — no props (one component; `analysis` is the analysis Status state: done, running, waiting, failed, superseded, with the label "Waiting for a local agent" when it waits on an absent local agent; `waitingQuestions`, `failedJobs` and `stalledJobs` are numbers that show the optional nodes `questions` (Badge accent "2 questions waiting"), `failed` (Status failed "1 failed job") and `stalled` (Status stalled "Possibly stalled") when above zero, so several conditions show at once; repository, number, title, SHA and time are props) | PR state icon (`state-icon`) in `success.fg` / `done.fg` / `danger.fg`, `text.body-strong` (`title`), `text.small` + `fg.muted` (`repo`, repository and number), Sha, analysis cell and time in a `size.rail` wide cell (`rail`) so the columns line up with PrTableHeader (the analysis cell fills and stacks its Status, Badge and markers with a `space.1` gap; time at the end, top-aligned), RelativeTime, `space.6` (meta indent under the title), `space.4`, `space.3`, `space.2`, `space.1`, bottom rule `border.muted` + `border-width.thin`, `size.content` (default width) | responsive-table (stacks into a card under the narrow breakpoint), single-line-overflow, color (each marker is a Status or Badge with icon or text) | no (stacks as a card) |

The component shows every condition at once (Status done "Analyzed", 2 questions waiting, 1 failed job, possibly
stalled); a screen turns off the markers a row does not have and swaps `analysis` for another Status. Pencil layouts
do not wrap, so the analysis cell stacks its markers; in code they wrap in a row with `space.2` / `space.1` gaps.

Row separators, blockquote rules and answer rules are a one-side stroke on the frame itself (`strokeWidth` with only
`bottom` or `left`, bound to a `border-width` token). In code they are borders.

## PR detail

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| PrHeader | `PrHeader/<density>` — `density`: full, compact | PrStateLabel, `text.small` + `fg.muted` (repository and number), `text.title` (full) / `text.body-strong` (compact) title, Button secondary sm "Open on GitHub" (full) / IconButton invisible sm with link-external (compact), `space.4`, `space.3`, `space.2`, `space.1`, `size.content` / `size.panel` (default width) | single-line-overflow, typography, accessibility (icon button named "Open on GitHub") | yes (`density=compact`) |
| CodeBlock | `CodeBlock` — no props (code and language are props) | `bg.subtle`, `border.default` + `border-width.thin`, `radius.md`, `space.3`, `space.2`, `text.code` + `fg.default`; copy is an IconButton secondary sm (opaque, bordered) with the copy glyph, named "Copy code"; `size.panel` (default width) | copy-button, component-specific-light-dark-theme, sanitize-untrusted-html | yes |
| Markdown | `Markdown` — no props (rendered content; the specimen shows every styled element) | h2 `text.heading`, h3 `text.body-strong`, paragraphs and lists `text.body` + `fg.default` (bullets `fg.muted`), links `accent.fg` underlined, inline code `text.code-small` on `bg.muted` + `radius.sm`, CodeBlock, table `border.default` + `border-width.thin` + `radius.md` with `bg.subtle` header and `text.small(-strong)` cells, blockquote rule `border.default` + `border-width.thick` with `fg.muted` text, `space.1`–`space.3`; default width `size.dialog`. A Pencil text has one style, so inline code and links are separate texts in a row (`inline`); in code they flow inline within the text | sanitize-untrusted-html, typography (measure ≤ 80ch), color | yes |
| Summary | `Summary/<state>` — `state`: ready, loading, streaming, empty (SHA, time, model, tokens and content are props) | `border.default` + `border-width.thin`, `radius.md`, `space.4`, `space.3`, `space.2`, `space.1`; header `text.heading` + Sha + RelativeTime, model and tokens `text.small` + `fg.muted`; body: Markdown (ready), Skeleton lines and block (loading), partial text + caret `accent.fg` (`border-width.thick` × `size.icon`) with Status running "Writing" in the header (streaming), Notice info "Analysis queued" with the reason, e.g. "Waiting for a local agent since 10:02. It starts when one returns." (empty); `size.content` (default width) | sanitize-untrusted-html, motion (caret and skeleton static or short), typography, persistent-toast-notifications (reason inline) | yes |
| VersionItem | `VersionItem/<status>/<selected>` — `status`: done, running, waiting, failed, superseded; `selected`: true, false (SHA and time are props) | leading slot (`lead`) `size.icon` with check in `fg.default` when selected, `accent.bg` fill (selected), Sha, Status, RelativeTime, `size.control.md` (height), `space.2`, `radius.md`; `size.popover` (default width) | menu (menuitemradio with a check, not color alone), single-line-overflow | yes |
| VersionMenu | `VersionMenu/<open>` — `open`: false, true | trigger: `border.default` (closed) / `border.strong` + `bg.subtle` (open) + `border-width.thin`, `radius.md`, `size.control.md`, `space.3`, `space.2`, history icon, Sha, Status, chevron-down; menu: `bg.overlay`, `border.default`, `radius.md`, `shadow.overlay`, `space.1`, `size.popover`, VersionItems | menu (aria-haspopup, visible open style, Esc closes), viewport-aware-dropdowns, declarative-dialog-popover-control | yes |
| JobRow | `JobRow/<state>/<density>` — `state`: waiting, running, stalled, failed, done; `density`: full, compact (full is one line, for widths above `size.rail`; compact is two lines, used in the desktop rail and the panel; target, agent, times and reason are props) | target `text.small` + `fg.muted` with Sha, Status, meta `text.small` + `fg.muted` (agent ID and since, wait reason, failure reason, or agent, duration and tokens), Button secondary sm "Retry" on running, stalled and failed (full: at the end of the line; compact: at the end of the second line, `meta-row`, after the meta, so the first line keeps the target and Status within `size.rail`), `space.4`/`space.3` (x), `space.2`, `space.1`; `size.content` / `size.panel` (default width) | calculate-event-differentials (since and elapsed times), color, natural-interactions | yes (`density=compact`) |
| Message | `Message/<role>/<state>` — `role`: question, answer; `state`: sent, queued, waiting-agent (question); streaming, complete, incomplete (answer). Only these six components exist: `Message/question/sent`, `Message/question/queued`, `Message/question/waiting-agent`, `Message/answer/streaming`, `Message/answer/complete`, `Message/answer/incomplete` | question: comment icon `fg.muted`, "You" `text.small-strong`, RelativeTime, `text.body` indented `space.6`, Status waiting with the reason (queued, waiting-agent); answer: indented `space.6` with a left rule `border.default` + `border-width.thick` and `space.3` before the text, Markdown body (paragraph, plus the code block when complete), Status running "Answering" + caret `accent.fg` (streaming), Status failed "Incomplete — step limit reached" (incomplete), meta `text.small` + `fg.muted`: "Answered at" + Sha, then model and tokens as a separate item with a `space.2` gap; `space.1`–`space.3`; `size.panel` (default width) | card (question/answer pair), sanitize-untrusted-html, scroll-target-on-load, color | yes |
| Composer | `Composer/<state>` — `state`: idle, focus, disabled | field `bg.canvas` (`bg.subtle` disabled), `border.strong` (`border.default` disabled) + `border-width.thin`, focus `border.focus` + `border-width.thick`, `radius.md`, `space.3` / `space.10` (bottom, room for three lines), `text.input` with `fg.muted` placeholder; footer hint `text.small` + `fg.muted`, Button primary md "Send" (disabled when disconnected); disabled reason: plug icon `attention.fg` + `text.small` + `fg.default`; `space.2`; `size.panel` (default width) | forms, ime-safe-enter-submit, form-fields-automatically-fit-contents, accessibility (aria-disabled keeps it focusable and explains why) | yes |

Pencil layouts do not wrap. In code the answer meta wraps with a `space.2` gap and no separator at a line start, and
Status labels wrap under their icon in narrow widths. The panel frames show the wrapped meta by overriding the
instance's `meta` to a vertical layout (`space.1`), since "Answered at" + Sha and the model and tokens do not fit one
line at 360px.

## Settings

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| TextField | `TextField/<state>` — `state`: rest, focus, invalid, disabled (label, hint, value, placeholder and error are props) | label `text.small-strong` + `fg.default`, hint `text.small` + `fg.muted` above the input, input `bg.canvas` (`bg.subtle` disabled) + `border.strong` (`border.default` disabled) + `border-width.thin`, `radius.md`, `size.control.md`, `space.3`, `text.input` (`fg.disabled` when disabled); focus `border.focus` + `border-width.thick`; invalid border `danger.fg` + error line x-circle and `text.small` in `danger.fg`; `space.1` inside the field; `size.panel` (default width) | forms, validate-input-after-interaction, accessible-error-announcement, color | yes |
| TextArea | `TextArea/<state>` — `state`: rest, focus, invalid (as TextField) | as TextField, multi-line input with `space.3` padding and `space.10` at the bottom (three lines) | forms, form-fields-automatically-fit-contents, validate-input-after-interaction, accessible-error-announcement | yes |
| PromptEditor | `PromptEditor/<status>` — `status`: idle, empty, saving, saved, failed (title, purpose and text are props) | title `text.heading`, purpose `text.body` + `fg.muted`, TextArea rest with its `label` and `hint` off (the title is its label; the empty placeholder says what the prompt is for), Button primary md "Save prompt" (busy while saving), status `text.small`: "Saving…" `fg.muted`, check-circle `success.fg` + "Saved at 10:02" `fg.muted`, x-circle + "Save failed…" in `danger.fg`; `space.3`, `space.1`; `size.dialog` (default width) | forms, accessibility (polite live region for "Saved"), light-dismiss-a-dialog (never light-dismiss edits), color | no |
| SkillRow | `SkillRow/<state>` — `state`: rest, update-ref, update-review (name, description, source, ref, SHA and allowed tools are props) | name `text.body-strong`, description `text.body` + `fg.muted`, repo icon + source and ref `text.small` + `fg.muted`, Sha, allowed tools as Badge neutral (or an "Instructions only" note), Button secondary sm "Update" and danger sm "Remove"; "Update" opens the ref form below the row (update-ref, `ref-form`, `space.2`, bottom-aligned): TextField rest "Ref" prefilled with the current ref, Button primary md "Review update" and invisible md "Cancel"; update-review keeps the field with the chosen ref (its buttons off) and shows SkillReview `mode=update` below it, padding `space.3` above and below, bottom rule `border.muted` + `border-width.thin`, `space.4`, `space.3`, `space.2`, `space.1`; `size.content` (default width) | card, single-line-overflow, accordion (details) | no |
| SkillRegisterForm | `SkillRegisterForm/<state>` — `state`: idle, registering, failed | title `text.heading`, three TextFields (GitHub URL, Path, Ref), Button primary md "Review skill" (busy while registering, with "Resolving main and fetching the skill…" `text.small` + `fg.muted`), Notice danger with the reason (failed), `space.4`, `space.2`; `size.dialog` (default width) | forms (no autocorrect on URL, path, ref), validate-input-after-interaction, accessible-error-announcement (server errors shown the same way), light-dismiss-a-dialog (never light-dismiss) | no |
| SkillReview | `SkillReview/<mode>` — `mode`: register, update | `bg.subtle`, `border.default` + `border-width.thin`, `radius.md`, `space.4`, `space.2`, `space.1`; title `text.heading`, description `text.body` + `fg.muted`, repo icon + source and ref, git-merge icon + "Pinned to" Sha (register) or old ref + Sha → new ref + Sha (update: `ref-old`, `ref-new` in `text.small` + `fg.default`; the source line then leaves out the ref), shield-check + allowed tools as Badge neutral (or "No allowed-tools: instructions and references only"); update also shows the change in allowed tools as Badge success "Added: …" (`tool-added`) and Badge danger "Removed: …" (`tool-removed`), each turned off when there is none, file-code icon + path `text.code-small` with Badge attention "script" on scripts, Button primary md "Register at a1b2c3d" / "Apply update to e4f5a6b" (confirms the reviewed SHA) and invisible "Cancel"; `size.dialog` (default width) | dialog (if shown modal), accordion, search-hidden-content, color | no |
| Dialog | `Dialog` — no props (title, text and actions are props) | `size.dialog`, `bg.overlay`, `border.default` + `border-width.thin`, `radius.lg`, `shadow.overlay`, `space.6`, `space.3`, `space.2`, title `text.title`, text `text.body`; actions: Button secondary md "Cancel" (the safe action, shown focused) and danger md "Remove skill" | dialog (native `<dialog>`, autofocus the safe action, visible cancel), light-dismiss-a-dialog (not for destructive confirms) | no |

An editable field at rest (TextField, TextArea and with it PromptEditor, Composer) draws its boundary in `border.strong`
(6.23:1 against `bg.canvas`) to meet WCAG 1.4.11; `border.default` (1.92:1) stays on cards, rows, dividers and disabled
fields.

Updating a skill takes a new ref: "Update" opens the ref field with the current ref, "Review update" resolves it and
fetches the skill, and the review shows the old and new ref and SHA and the change in allowed tools. "Apply update to
…" pins exactly the reviewed SHA; "Cancel" leaves the skill as it is.

## Annotations

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| Note | `Note` — no props (`text` holds the state IDs and the guide IDs a frame shows); design-only, not in code | `attention.bg`, `radius.md`, `space.3`, `text.small` + `fg.default`; `size.popover` (default width) | — | — |
