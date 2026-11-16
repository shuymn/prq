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
- **Tokens:** the semantic tokens the component binds (palette tokens and the `space.*` scale are never bound directly;
  spacing is named by its role, `gap.*` between siblings and `inset.*` inside a container), by token path. In
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
| Icon | `Icon/<name>` — `name`: git-pull-request, git-merge, git-pull-request-closed, clock, x-circle, check-circle, alert, circle-slash, device-desktop, cloud, plug, sync, link-external, copy, check, x, chevron-down, chevron-right, info, history, comment, plus, trash, arrow-up, tools, repo, dot-fill, shield-check, file-code, gear, sidebar-collapse, sidebar-expand | `size.icon`; the path `glyph` is `color.fg.default`, and the parent overrides it with `color.fg.*` or a status `fg` | icons, color | yes |
| Spinner | `Spinner` — no props | `size.icon`, `color.border.default` (`track`), `color.accent.fg` (`arc`), `border-width.thick`; code: `duration.spinner`, `duration.spinner-reduced` | spinner, motion | yes |

Icons are GitHub Octicons 19 (MIT), 16px, drawn as the Octicon's SVG path. A component that shows an icon holds an
`Icon/<name>` instance named `icon` (or after its role, such as `chevron`); a screen swaps it by replacing that node
with another `Icon/<name>` instance.

An icon is centred on the first line of the text it leads. Where the text can take more than one line (Status, Notice,
ConnectionBanner, the PoolPopover agent rows, Message questions, field errors, the Composer's disabled reason, the
PromptEditor failure, the SkillReview source and file rows), the row aligns to the top and the icon sits in a `lead`
frame one line of that text high, centred in it: the frame holds the icon and `strut`, a zero-width text in the first
line's text style (`text.body-strong` gives 14 × 1.5 = 21, `text.small` 12 × 1.5 = 18), because a line height is not a
size token. In code the lead is `height: 1lh` in that text style with `align-items: center`. A row whose text stays on
one line centres the icon with `align-items: center`; Disclosure's chevron sits in a `size.control.sm` lead next to a
summary row of the same height, which centres both.

## Status and labels

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| Status | `Status/<state>` — `state`: done, running, waiting, stalled, failed, superseded | `text.small-strong`, `gap.tight`; per state: success, accent, `fg.muted`, attention, danger, `fg.muted` (`fg`) | color, spinner | yes |
| Badge | `Badge/<tone>` — `tone`: neutral, accent, success, attention, danger, done | `text.small-strong`, `<tone>.bg` + `<tone>.fg` (neutral: `bg.muted` + `fg.default`), `radius.full`, `inset.control-sm` (x) | color, single-line-overflow | yes |
| PrStateLabel | `PrStateLabel/<state>` — `state`: open, merged, closed | `text.small-strong`, `success.emphasis` / `done.emphasis` / `danger.emphasis`, `fg.on-emphasis` (text and icon), `radius.full`, `size.control.sm` (height), `inset.control-sm` (x), `gap.tight` | color | yes |
| Sha | `Sha` — no props | `text.code-small`, `fg.default`, `bg.muted`, `radius.sm`, `inset.inline` (x) | single-line-overflow, interest-triggered-tooltips | yes |
| RelativeTime | `RelativeTime` — no props | `text.small`, `fg.muted` | calculate-event-differentials, interest-triggered-tooltips | yes |

Status never relies on color alone: every state has its own icon (running: Spinner) and a text label (`label`).
PrStateLabel shows the PR state's Octicon (git-pull-request, git-merge, git-pull-request-closed) before its label.

## Controls

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| Button | `Button/<variant>/<size>/<state>` — `variant`: primary, secondary, danger, invisible; `size`: md, sm; `state`: rest, hover, focus, disabled, busy (state is a design-only axis: in code it is CSS state, `disabled` and `busy` are props) | `accent.emphasis(-hover)`, `danger.emphasis(-hover)`, `bg.subtle`, `bg.muted`, `border.default`, `fg.on-emphasis`, `fg.default`, `fg.disabled`, `size.control.md/sm`, `radius.md`, `inset.control-md` / `inset.control-sm` (x, md/sm; no vertical padding), `gap.tight` (spinner and label), `text.body-strong` / `text.small-strong` (md/sm label); focus ring `border.focus` + `border-width.thick`, `radius.lg`, gap `focus.offset`; busy: Spinner | natural-interactions, accessibility, forms | yes |
| IconButton | `IconButton/<variant>/<size>/<state>` — `variant`: invisible, secondary; `size`: md, sm; `state`: rest, hover, focus (design-only, as in Button); icon and accessible name are props | `bg.subtle`, `bg.muted` (hover), `border.default`, `fg.muted` / `fg.default` (glyph), `border.focus` + `border-width.thick`, `focus.offset`, `size.control.md/sm` (square), `radius.md`, `radius.lg` (focus ring) | natural-interactions, accessibility, icons, interest-triggered-tooltips | yes |
| SegmentedControl | `SegmentedControl/<selected>` — `selected`: first, second; labels are props (`Open`, `All`) | `bg.subtle` + `border.default` + `border-width.thin` (track), `bg.muted` + a bottom indicator `accent.fg` + `border-width.thick` (selected segment), `fg.default` / `fg.muted`, `text.small-strong`, `size.control.sm` (segment), `inset.inline` (track around the segments, which makes the control `size.control.md` high), `gap.tight` (between segments), `inset.control-sm` (segment x), `radius.md` (track and segments) | accessibility, color (selection is fill and indicator, never weight or size) | yes |

Button looks: primary and danger are filled (`accent.emphasis`, `danger.emphasis`; hover the `-hover` token) with
`fg.on-emphasis`; secondary is `bg.subtle` with a `border.default` border and `fg.default` (hover `bg.muted`); invisible
has no fill and `fg.default` (hover `bg.muted`). Disabled is `bg.subtle` + `border.default` with `fg.disabled`
(invisible: `fg.disabled` only). Busy puts a Spinner (`spinner`) before the label, its arc in the label color. The text
node is `label`.

Control size per context (README "One control size per context"); a screen switches an instance to the component of
the right size and never resizes it:

- **md:** AppHeader (PoolStatus `form=button`, the settings IconButton invisible); the PR list toolbar ("Needs
  attention · N" Button secondary, RepoFilter, SegmentedControl, whose track is md around sm segments); PrHeader in both
  densities and the rail head ("Open on GitHub" Button secondary or IconButton invisible, the rail toggle); forms,
  dialog footers, Composer and the Settings page ("Send", "Save prompt", "Add skill", "Review update" and "Cancel" in
  the ref form, dialog actions, EmptyState actions).
- **sm:** rows (JobRow "Retry", SkillRow "Update" and "Remove"); inline notices and status lines (Notice and
  ConnectionBanner actions, the "Retry" of Summary `progress` and of the running lines, Message `failure`); CodeBlock
  copy; the VersionMenu trigger in the Summary heading and in the panel's Disclosure row.
- **Menu and list items** that are themselves the target (VersionItem in the rail and in the VersionMenu) are
  `size.control.md` tall, like any other item a pointer has to hit in a list.

The focus state draws the outline the code draws with `:focus-visible`: the button sits in a `focus-offset` frame inside
a ring frame (the component root) with a `border.focus` inner stroke of `border-width.thick` and `radius.lg`. The ring
frame's padding is the ring width (`border-width.thick`) and the `focus-offset` frame's padding is the gap
(`focus.offset`, 2px). The focus component is therefore 8px larger than the button; in code the outline takes no space.

The selected segment of SegmentedControl carries a bottom indicator, a one-side stroke of `border-width.thick` in
`accent.fg` (5.59:1 against `bg.subtle`), because its `bg.muted` fill alone is 1.16:1 and WCAG 1.4.11 asks for 3:1.

IconButton invisible md is the settings button at the end of AppHeader (gear, named "Settings") and the rail toggle in
the PR detail rail head (sidebar-collapse in the expanded rail, named "Collapse rail"; sidebar-expand in the collapsed
rail, named "Expand rail"), both with the glyph in `fg.muted`. On the Settings page the settings button is marked as the
current page (`aria-current="page"`) with the `bg.muted` fill and, because that fill alone is 1.16:1 against
`bg.subtle`, a bottom indicator of `border-width.thick` in `accent.fg` like the selected segment of SegmentedControl.
While a job has failed or is possibly stalled, the collapsed rail's toggle carries an `Icon/dot-fill` in `danger.fg` at
its top-right corner and its name says so ("Expand rail, a job needs attention"); in Pencil the screen places the two
instances in a `rail-toggle` frame without layout. In the PR list toolbar, Button secondary md is the "Needs attention
· N" filter: a toggle button (`aria-pressed`) that keeps the rows with a problem the host can act on (failed,
possibly stalled, waiting for a local agent), its label carrying their count; "New push not summarized" does not count.
It is shown only while N is above zero.

## Feedback

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| Notice | `Notice/<tone>` — `tone`: info, attention, danger; `title`, `text` and optional `actions` (Button sm) are props | `<tone>.bg` fill (info: `accent.bg`), icon in `<tone>.fg` (info, alert, x-circle), `text.body-strong` (title), `text.body` (text), `fg.default`, `inset.card`, `gap.tight` (icon and the text column), `gap.related` (title, text and actions), `radius.md`; `size.panel` (default width) | persistent-toast-notifications (critical states are inline), color, icons | yes |
| ConnectionBanner | `ConnectionBanner/<state>` — `state`: reconnecting, offline; offline has a "Retry now" Button sm | `attention.bg` / `danger.bg`, icon `plug` in `attention.fg` / `danger.fg`, `text.body`, `fg.default`, `inset.card`, `gap.tight` (icon and text, in `message`), `gap.related` (message and button); `size.panel` (default width) | persistent-toast-notifications, accessibility (assertive announcement on drop), color | yes |
| EmptyState | `EmptyState` — no props (`icon`, `title`, `text` and optional `actions` are props) | `border.muted` + `border-width.thin`, `fg.muted` (icon, text), `fg.default` + `text.heading` (title), `text.body`, `inset.card`, `gap.related`, `radius.md`, Button secondary md in `actions`; `size.panel` (default width) | card, typography | yes |
| Skeleton | `Skeleton/<shape>` — `shape`: line, block | `color.skeleton`, `radius.sm` (line) / `radius.md` (block) | motion (static or short shimmer) | yes |

Notice is a row of the icon (in its `lead` slot) and a column with `title`, `text` and `actions`, so the text lines up
under the title by layout rather than by an indent. Skeleton has no size tokens of its own: the component borrows `size.icon` (line height),
`size.header` (block height) and `size.popover` (width) as defaults, and screens size each instance to the content it
stands in for.

## Layout and navigation

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| AppHeader | `AppHeader` — no props (desktop; the current page and the pool status are props) | `bg.subtle`, `size.header` (height), `size.content` (default width; fills the page), `text.heading` (`product`), `inset.page` (x), `gap.group` (start and end); the `end` group (`gap.related`) holds PoolStatus `form=button` (`pool-status`) and the settings IconButton invisible md with gear (`settings`; `bg.muted` on the Settings page) | navbar, accessibility, icons, interest-triggered-tooltips | no |
| PoolStatus | `PoolStatus/<form>/<state>` — `form`: button, line; `state`: local, cloud-only, unavailable, loading | button: `border.default` + `border-width.thin`, `radius.md`, `size.control.md`, `inset.control-md` (x), `gap.tight`, `text.body-strong` (`label`, a medium control's label), `text.small` + `fg.muted` (`jobs`, e.g. "1 running · 2 waiting"; off when unavailable or loading), chevron-down; line: `text.small`, `fg.muted`, `gap.tight`; dot-fill icon (`dot`) in `success.fg` (local) or `fg.muted`; loading uses Spinner | declarative-dialog-popover-control, viewport-aware-dropdowns, color (state is in the label), calculate-event-differentials | yes (`form=line`) |
| PoolPopover | `PoolPopover/<state>` — `state`: local, cloud-only, unavailable | `size.popover`, `bg.overlay`, `border.default` + `border-width.thin`, `radius.lg`, `shadow.overlay`, `inset.card`, `gap.group` (sections), `gap.related` (a heading and its rows; the badges), `gap.tight` (an icon and its text); section headings `text.small-strong` + `fg.muted`; agent rows: device-desktop icon, agent ID `text.body-strong`, job and last seen `text.small` + `fg.muted`; cloud row: cloud icon + "Cloud" `text.body-strong` + "Available"; jobs in flight: Badge neutral / accent / danger; cloud-only (`text.body`): "No local agent present. New PRs go to cloud; existing local sessions wait until their agent returns."; unavailable: Notice attention (no actions) and the cloud row | viewport-aware-dropdowns (centered or bottom fallback), declarative-dialog-popover-control, natural-interactions (Esc closes), calculate-event-differentials | yes (fits 320px) |
| Disclosure | `Disclosure/<open>` — `open`: true, false (label, meta and content are props) | chevron-right / chevron-down in `fg.muted`, `text.body-strong` (`label`), `text.small` + `fg.muted` (`meta`), `text.body` content; a row of the chevron (in a `lead` frame `size.control.sm` high) and a `column` with the `summary` row and the content, `gap.tight` both ways, so the content lines up under the label; `gap.related` (label and meta); `summary` row `size.control.sm` high (the 24px target); `size.panel` (default width) | accordion (chevron before the label, built on `<details>`), search-hidden-content | yes |

A frame that puts a component inside a Disclosure (the Summary in the panel) replaces the instance's `content` node
with that component's instance (a `descendants` entry with `type`). In code the content is the Disclosure's children.
In the panel the summary row is "Summary" (the `label` set to `text.heading`, the level of the desktop Summary
title) followed by the version menu: the frame replaces the Disclosure's `meta` with
a VersionMenu `open=false` instance, so the SHA and time appear once. In code the menu button sits next to `<summary>`
in the same row, not inside it, since a button inside `<summary>` would toggle the disclosure. The Summary inside the
Disclosure turns off its `header` (ready) or its `title` and `version` (streaming, which keeps the running Status).

In the PR detail rail, done jobs collapse into one Disclosure `open=false` whose `label` is the count ("2 done") and
whose `meta` is off; the jobs that are waiting, running, stalled or failed stay listed above it.

## PR list

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| PrTableHeader | `PrTableHeader` — no props | The muted headings and a rule, no fill and no table border: `text.small-strong` + `fg.muted`, one line `size.row` high, `inset.control-md` (x), `gap.group` (columns), `gap.related` (after the leading column), bottom rule `border.default` + `border-width.thin` (stronger than the rows' `border.muted`, so it separates the headings from the first row), `size.page` (default width); columns as PrRow: an unnamed leading column `size.icon` wide (the new dot), Repository (as wide as PrRow's), Pull request (fills), Status (`size.column.problem`) and Last activity (`size.column.event`, right-aligned) | responsive-table (sticky header row; in code its background is `bg.canvas`, the page's, so it stays opaque without showing a band) | no |
| PrRow | `PrRow` — no props (one component; its props are `title`, `repository`, `number`, `state` (open, merged, closed), `event` (summary, answer, push, question), `eventTime`, `isNew` and `problem` (none, summary-failed, answer-failed, stalled, waiting-agent, unsummarized-push); an instance overrides the texts, swaps `state-icon` and `problem`, and turns off `new` and `problem`) | one line `size.row` high, `size.page` (default width), `inset.control-md` (x), `gap.group` (columns); `start`: `lead` (`size.icon` wide, holds `new`, an `Icon/dot-fill` in `accent.fg` named "New") and `repo-cell` (fits the longest repository name the list shows, or the "Repository" heading if wider, up to `size.column.repo`; the header and every row of a list share that width; clips: `repo`, `text.body` + `fg.default`), `gap.related` apart; `pr-cell` (fills, clips, `gap.tight`): PR state icon (`state-icon`) in `success.fg` / `done.fg` / `danger.fg`, `title-clip` with `title` (`text.body-strong` + `fg.default`, one line) and `number` (`text.body` + `fg.muted`, "#42"); `problem-cell` (`size.column.problem`): `problem`, a Status — failed (danger) "Summary failed" or "Answer failed", stalled (attention) "Possibly stalled", waiting (`fg.muted`) "Waiting for a local agent", or waiting with the history icon "New push not summarized"; `event-cell` (`size.column.event`, right-aligned, `gap.tight`): `event` (`text.small` + `fg.muted`: "Summary", "Answer", "Push received", "Question sent") and RelativeTime (`time`); bottom rule `border.muted` + `border-width.thin` | responsive-table (stacks into a card under the narrow breakpoint), single-line-overflow (the title truncates with an ellipsis, the number stays; a long repository truncates its owner first), color (a problem is a Status with icon and text; the new dot has the accessible name "New") | no (stacks as a card) |
| RepoFilter | `RepoFilter` — no props (the current repository, or "All repositories", is the `label` prop; the menu it opens lists the followed repositories) | `bg.subtle`, `border.default` + `border-width.thin`, `radius.md`, `size.control.md` (height), `inset.control-md` (x), `gap.tight`, repo icon (`icon`), `text.body-strong` + `fg.default` (`label`), chevron-down (`chevron`) | viewport-aware-dropdowns, declarative-dialog-popover-control, natural-interactions | no |

A row shows what the host reads the list for: the repository, the pull request and its latest event. Processing is not
a column: the row has no analysis, question or job state, only a problem label while a problem is unresolved, and the
new dot while a summary or an answer arrived after the host last opened the PR. The component shows the new dot and the
"Answer failed" problem; a screen turns off what a row does not have. The repository column shows the repository name
alone (`prq`) while every PR in the list has the same owner, and `owner/repo` once the list mixes owners; the list
decides once for all its rows, and RepoFilter's label follows the same rule ("All repositories", or `prq`). Pencil
clips a title that does not fit; in code it truncates with an ellipsis and `#42` stays visible, which the frames show
by setting the long title's `title-clip` to fill the cell.

The PR list toolbar puts the page title on the left and the filters on the right (`gap.related`), `gap.page` above the table: Button secondary md
"Needs attention · N" (only while N is above zero), RepoFilter and SegmentedControl `Open | All`.

Row separators, blockquote rules and answer rules are a one-side stroke on the frame itself (`strokeWidth` with only
`bottom` or `left`, bound to a `border-width` token). In code they are borders.

## PR detail

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| PrHeader | `PrHeader/<density>` — `density`: full, compact | PrStateLabel, `text.small` + `fg.muted` (repository and number), title `text.title` (full: the page's title) / `text.heading` (compact, so a long title takes at most two lines in the panel), Button secondary md "Open on GitHub" (full) / IconButton invisible md with link-external (compact), `gap.group` (heading and action), `gap.related` (meta line and title; state label and repository), `size.content` / `size.panel` (default width) | single-line-overflow, typography, accessibility (icon button named "Open on GitHub") | yes (`density=compact`) |
| CodeBlock | `CodeBlock` — no props (code and language are props) | `bg.subtle`, `border.default` + `border-width.thin`, `radius.md`, `inset.card`, `gap.related`, `text.code` + `fg.default`; copy is an IconButton secondary sm (opaque, bordered) with the copy glyph, named "Copy code"; `size.panel` (default width) | copy-button, component-specific-light-dark-theme, sanitize-untrusted-html | yes |
| Markdown | `Markdown` — no props (rendered content; the specimen shows every styled element) | h2 `text.heading`, h3 `text.body-strong`, paragraphs and lists `text.body` + `fg.default` (bullets `fg.muted`), links `accent.fg` underlined, inline code `text.code-small` on `bg.muted` + `radius.sm` + `inset.inline` (x), CodeBlock, table `border.default` + `border-width.thin` + `radius.md` with `bg.subtle` header, rows `size.row` high, cells `inset.control-md` (x), heading cells `text.small-strong` + `fg.muted` and body cells `text.body`, blockquote rule `border.default` + `border-width.thick` with `fg.muted` text and `inset.card` after the rule, `gap.group` (blocks), `gap.related` (list items), `gap.tight` (bullet and text, inline runs); default width `size.dialog`. A Pencil text has one style, so inline code and links are separate texts in a row (`inline`); in code they flow inline within the text | sanitize-untrusted-html, typography (measure ≤ 80ch), color | yes |
| Summary | `Summary/<state>` — `state`: ready, loading, streaming, empty (SHA, time, model, tokens, content and the optional `progress` and `notice` are props) | `border.default` + `border-width.thin`, `radius.md`, `inset.card`, `gap.group` (header, notice, body, meta), `gap.tight` (title row and progress line), `gap.related` (in the title row; progress `info` and Retry); header: `title` "Summary" (`text.heading`) and the version menu trigger (`version`, VersionMenu `open=false`: SHA, time, chevron), so another version can be picked with the rail collapsed; model and tokens (`meta`, `text.small` + `fg.muted`) below the body (ready, streaming), with each frame's own figures; ready has two optional parts, both shown in the component and turned off by a screen that does not need them: `progress`, one line under the title (sync icon + "Summarizing" + Sha in `text.small` + `fg.muted` while a newer head is analyzed; for a possibly stalled analysis the alert icon and the text in `attention.fg` with the agent and elapsed time, and Button secondary sm "Retry" `gap.related` after `info`), and `notice`, a Notice danger with the failure reason and "Retry" above the body when the analysis of a newer head failed; body: Markdown (ready), Skeleton lines and block (loading), partial text + caret `accent.fg` (`border-width.thick` × `size.icon`) with the running line after the version: Status running "Writing", the agent and since when (`agent`, `text.small` + `fg.muted`) and Button secondary sm "Retry" (streaming; Retry is offered on a claimed job at any time, before the stalled mark), one Status waiting line with the reason, e.g. "Waiting for a local agent since 10:02 — continues when it returns" (empty); `size.content` (default width) | sanitize-untrusted-html, motion (caret and skeleton static or short), typography, persistent-toast-notifications (failures and reasons inline), menu | yes |
| VersionItem | `VersionItem/<status>/<selected>` — `status`: done, running, waiting, failed, superseded; `selected`: true, false (SHA and time are props) | leading slot (`lead`) `size.icon` with check in `fg.default` when selected, `accent.bg` fill (selected), Sha, Status, RelativeTime, `size.control.md` (height), `inset.control-md` (x), `gap.related`, `radius.md`; `size.popover` (default width) | menu (menuitemradio with a check, not color alone), single-line-overflow | yes |
| VersionMenu | `VersionMenu/<open>` — `open`: false, true | trigger: Sha, RelativeTime and chevron-down (the shown version's SHA and time, nothing else), `border.default` (closed) / `border.strong` + `bg.subtle` (open) + `border-width.thin`, `radius.md`, `size.control.sm` (height), `inset.control-sm` (x), `gap.tight`; menu (statuses live here) `gap.tight` below the trigger: `bg.overlay`, `border.default`, `radius.md`, `shadow.overlay`, `inset.card`, `size.popover`, VersionItems | menu (aria-haspopup, visible open style, Esc closes), viewport-aware-dropdowns, declarative-dialog-popover-control | yes |
| JobRow | `JobRow/<state>/<density>` — `state`: waiting, running, stalled, failed, done; `density`: full, compact (full is one line, for widths above `size.rail`; compact stacks the job in `info`, used in the desktop rail and the panel; target, agent, times and reason are props) | target `text.small` + `fg.muted` with Sha, Status, meta `text.small` + `fg.muted` (agent ID and since, wait reason, failure reason, or agent, duration and tokens), Button secondary sm "Retry" on running, stalled and failed (full: at the end of the line; compact: to the right of `info`, centered, `gap.related` apart); compact `info` has the target and Status on the first line and the meta below (`meta-row`, `gap.related`), the same for every state; `inset.control-md` (x; no vertical padding, the list's `gap.group` spaces the rows), `gap.related`, `gap.tight` (target label and Sha); `size.content` / `size.panel` (default width) | calculate-event-differentials (since and elapsed times), color, natural-interactions | yes (`density=compact`) |
| Message | `Message/<role>/<state>` — `role`: question, answer; `state`: sent, queued, waiting-agent (question); streaming, complete, incomplete (answer). Only these six components exist: `Message/question/sent`, `Message/question/queued`, `Message/question/waiting-agent`, `Message/answer/streaming`, `Message/answer/complete`, `Message/answer/incomplete` | question: a row of the comment icon `fg.muted` and a `column` (`gap.tight` both ways) with the header ("You" `text.small` + `fg.muted` and RelativeTime, `gap.related`) and the content (`text.body`, then Status waiting with the reason on queued and waiting-agent, `gap.related`), so the text lines up under "You" by layout; answer: an empty `lead` frame `size.icon` wide and `gap.tight`, so the answer lines up with the question text, then a left rule `border.default` + `border-width.thick` and `inset.card` before the text, lines `gap.related`, Markdown body (paragraph, plus the code block when complete), caret `accent.fg` and the `running` line: Status running "Answering", the agent and since when (`agent`, `text.small` + `fg.muted`) and Button secondary sm "Retry" (streaming; Retry is offered on a claimed job at any time), Status failed with the reason, "Incomplete — step limit reached", and Button secondary sm "Retry" after it (`failure`, `gap.related`) under the incomplete text (incomplete); waiting-agent's Status says "Waiting for a local agent since 10:02 — continues when it returns" and fills the column, its label wrapping (two lines at `size.panel`), meta `text.small` + `fg.muted`: "Answered at" + Sha, then model and tokens as a separate item, `gap.related` ("Answered at" and its Sha `gap.tight`); `size.panel` (default width) | card (question/answer pair), sanitize-untrusted-html, scroll-target-on-load, color | yes |
| Composer | `Composer/<state>` — `state`: idle, focus, disabled | field `bg.canvas` (`bg.subtle` disabled), `border.strong` (`border.default` disabled) + `border-width.thin`, focus `border.focus` + `border-width.thick`, `radius.md`, `inset.control-md` / `inset.textarea` (bottom, room for three lines), `text.input` with `fg.muted` placeholder; footer hint `text.small` + `fg.muted`, Button primary md "Send" (disabled when disconnected); disabled reason: plug icon `attention.fg` + `text.small` + `fg.muted` (`gap.tight`); optional `context` line above the field while an earlier version is shown: "Questions are answered at" + Sha + "(latest)" in `text.small` + `fg.muted`, `gap.tight` (shown in the component, turned off by screens that show the latest version); lines and footer `gap.related`; `size.panel` (default width) | forms, ime-safe-enter-submit, form-fields-automatically-fit-contents, accessibility (aria-disabled keeps it focusable and explains why) | yes |

Pencil layouts do not wrap. In code the answer meta wraps with a `gap.related` gap and no separator at a line start, and
Status labels wrap under their icon in narrow widths. The panel frames show the wrapped meta by overriding the
instance's `meta` to a vertical layout (`gap.related`, lines of one block), since "Answered at" + Sha and the model and tokens do not fit one
line at 360px.

## Settings

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| TextField | `TextField/<state>` — `state`: rest, focus, invalid, disabled (label, hint, value, placeholder and error are props) | label `text.body-strong` + `fg.default` (it labels a medium control), hint `text.small` + `fg.muted` above the input, input `bg.canvas` (`bg.subtle` disabled) + `border.strong` (`border.default` disabled) + `border-width.thin`, `radius.md`, `size.control.md`, `inset.control-md` (x), `text.input` (`fg.disabled` when disabled); focus `border.focus` + `border-width.thick`; invalid border `danger.fg` + error line x-circle and `text.small` in `danger.fg`; `gap.tight` inside the field (label, hint, input, error); `size.panel` (default width) | forms, validate-input-after-interaction, accessible-error-announcement, color | yes |
| TextArea | `TextArea/<state>` — `state`: rest, focus, invalid (as TextField) | as TextField, multi-line input with `inset.control-md` padding and `inset.textarea` at the bottom (three lines) | forms, form-fields-automatically-fit-contents, validate-input-after-interaction, accessible-error-announcement | yes |
| PromptEditor | `PromptEditor/<status>` — `status`: idle, empty, saving, saved, failed (title, purpose and text are props) | title `text.body-strong` (an editor label, a level below the Settings section headings "Prompts" and "Skills"), purpose `text.body` + `fg.muted`, TextArea rest with its `label` and `hint` off (the title is its label; the empty placeholder says what the prompt is for), Button primary md "Save prompt" (busy while saving), status `text.small`: "Saving…" `fg.muted`, check-circle `success.fg` + "Saved at 10:02" `fg.muted`, x-circle + "Save failed…" in `danger.fg`; `gap.group` (head, editor, footer), `gap.tight` (title and purpose; status icon and text), `gap.related` (Save and status); `size.dialog` (default width) | forms, accessibility (polite live region for "Saved"), light-dismiss-a-dialog (never light-dismiss edits), color | no |
| SkillRow | `SkillRow/<state>` — `state`: rest, update-ref, update-review (name, description, source, ref, SHA and allowed tools are props) | name `text.body-strong`, description `text.body` + `fg.muted`, repo icon + source and ref `text.small` + `fg.muted`, Sha, allowed tools as Badge neutral (or an "Instructions only" note), Button secondary sm "Update" and danger sm "Remove"; "Update" opens the ref form below the row (update-ref, `ref-form`, `gap.related`, bottom-aligned): TextField rest "Ref" prefilled with the current ref, Button primary md "Review update" and invisible md "Cancel"; update-review keeps the field with the chosen ref (its buttons off) while the SkillReview `mode=update` dialog is open over the page, `inset.control-md` on every side, bottom rule `border.muted` + `border-width.thin`, `gap.group` (main and ref form; info and actions), `gap.related` (lines of `info`, badges, actions), `gap.tight` (icon and source); `size.content` (default width) | card, single-line-overflow, accordion (details) | no |
| SkillRegisterForm | `SkillRegisterForm/<state>` — `state`: idle, registering, failed | the "Add skill" dialog: `bg.overlay`, `border.default` + `border-width.thin`, `radius.lg`, `shadow.overlay`, `inset.dialog`, `gap.section` (title, `body` and footer), `gap.group` (in `body`: the field and the failure Notice), `gap.related` (footer); title "Add a skill" `text.heading`, one TextField "SKILL.md URL" (a GitHub link to the `SKILL.md`; its branch or tag is pinned to a commit), footer at the end: Button secondary md "Cancel" and primary md "Review skill" (busy while registering, with "Resolving main and fetching the skill…" `text.small` + `fg.muted` before the buttons), Notice danger with the reason (failed); `size.dialog` (default width) | dialog, forms (no autocorrect on the URL), validate-input-after-interaction, accessible-error-announcement (server errors shown the same way), light-dismiss-a-dialog (never light-dismiss) | no |
| SkillReview | `SkillReview/<mode>` — `mode`: register, update | a dialog: `bg.overlay`, `border.default` + `border-width.thin`, `radius.lg`, `shadow.overlay`, `inset.dialog`, `gap.section` (head, facts, actions), `gap.tight` (title and description; each fact's icon and text), `gap.related` (fact lines, badges, files); title `text.heading`, description `text.body` + `fg.muted`, repo icon + source and ref, git-merge icon + "Pinned to" Sha (register) or old ref + Sha → new ref + Sha (update: `ref-old`, `ref-new` in `text.small` + `fg.muted`; the source line then leaves out the ref), shield-check + allowed tools as Badge neutral (or "No allowed-tools: instructions and references only"); update also shows the change in allowed tools as Badge success "Added: …" (`tool-added`) and Badge danger "Removed: …" (`tool-removed`), each turned off when there is none, file-code icon + path `text.code-small` with Badge attention "script" on scripts, `actions` at the end of the dialog (right-aligned, `gap.related`) like SkillRegisterForm and Dialog: Button secondary md "Cancel" first, then primary md "Register at a1b2c3d" / "Apply update to e4f5a6b" (confirms the reviewed SHA); `size.dialog` (default width) | dialog, accordion, search-hidden-content, color | no |
| Dialog | `Dialog` — no props (title, text and actions are props) | `size.dialog`, `bg.overlay`, `border.default` + `border-width.thin`, `radius.lg`, `shadow.overlay`, `inset.dialog`, `gap.section` (head and actions), `gap.tight` (title and text, in `head`), `gap.related` (actions), title `text.heading`, text `text.body`; actions: Button secondary md "Cancel" (the safe action, shown focused) and danger md "Remove skill" | dialog (native `<dialog>`, autofocus the safe action, visible cancel), light-dismiss-a-dialog (not for destructive confirms) | no |

An editable field at rest (TextField, TextArea and with it PromptEditor, Composer) draws its boundary in `border.strong`
(6.23:1 against `bg.canvas`) to meet WCAG 1.4.11; `border.default` (1.92:1) stays on cards, rows, dividers and disabled
fields.

Adding a skill starts from "Add skill" (Button secondary md) in the Skills heading, which opens SkillRegisterForm as a
dialog; "Review skill" resolves the link and replaces it with the SkillReview `mode=register` dialog. Updating a skill
takes a new ref: "Update" opens the ref field with the current ref, "Review update" resolves it and fetches the skill,
and the SkillReview `mode=update` dialog shows the old and new ref and SHA and the change in allowed tools. "Apply
update to …" pins exactly the reviewed SHA; "Cancel" leaves the skill as it is. Every dialog sits on a
`bg.backdrop` backdrop that covers the page.

## Annotations

| Component | Name ↔ props | Tokens | Guides | Panel |
| --- | --- | --- | --- | --- |
| Note | `Note` — no props (`text` holds the state IDs and the guide IDs a frame shows); design-only, not in code | `attention.bg`, `radius.md`, `inset.card`, `text.small` + `fg.default`; `size.popover` (default width) | — | — |
