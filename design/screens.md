# Screens and states

Every screen and state in [docs/ui.md](../docs/ui.md), the Pencil frame that shows it, and what the frame must make
visible. A frame named here is a root frame of [prq.pen](prq.pen), below the component sections: one column per screen,
in the order of the sections below, with the frames in table order. Desktop frames are 1440 wide and at least 900 tall,
panel frames `size.panel` (360) wide and at least 800 tall. To the right of each frame a `Note` instance named
`Note / <frame>` lists the state IDs the frame shows and the guides it relies on. Some frames show several states at once
(the list shows every row marker); the table says which.

The state ID is stable: code (#7) uses it for the gallery and for tests that pick a state.

## 1. PR list

| State ID | Frame | Must show |
| --- | --- | --- |
| `list.default` | PR list / Default | Header with pool status and settings; filter `Open \| All` on Open; rows sorted by last activity, each with PR state icon, title, repository and number, latest analyzed SHA, analysis status, last activity. Rows also show every marker: questions waiting, waiting for a local agent, failed job, possibly stalled, and one row with two at once (a failed job and 2 questions waiting) |
| `list.waiting-agent` | PR list / Default | A row whose job waits with no local agent present says "Waiting for a local agent" |
| `list.failed` | PR list / Default | A row with a failed job is marked failed, findable without opening it |
| `list.all` | PR list / All | Filter on All; closed and merged PRs appear with their state |
| `list.empty` | PR list / Empty | Explains that PRs appear when the GitHub App receives a webhook for the host's own pull request |
| `list.loading` | PR list / Loading | Skeleton rows in the list's layout |

## 2. PR detail

Desktop layout: header, then a main column (summary pinned above the conversation, composer at the bottom) and a
right rail (jobs, then version history).

| State ID | Frame | Must show |
| --- | --- | --- |
| `detail.default` | PR detail / Default | Summary of the latest analysis with SHA, time, model, tokens; conversation with question → answer pairs, each answer with its SHA, model, tokens; composer; rail with done jobs and the version list (latest selected, older ones done or superseded) |
| `detail.empty` | PR detail / Empty | No analysis yet: the summary area says an analysis is queued, or why it has not started |
| `detail.loading` | PR detail / Loading | Skeletons in the summary and conversation; the summary keeps its place |
| `detail.streaming` | PR detail / Streaming | An answer arriving: partial text under its question and a running status; the question appears once (no duplicate send) |
| `detail.summary-streaming` | PR detail / Summary streaming | The analysis of a new push arriving: partial summary text with a running status and the new SHA; the previous version stays listed in the rail |
| `detail.waiting-agent` | PR detail / Waiting for a local agent | A saved question marked waiting for a local agent since a time, saying it continues when one returns; the composer still accepts questions |
| `detail.running` | PR detail / Running on an agent | The job row names the agent ID and since when |
| `detail.queued` | PR detail / Question waiting behind a running turn | The running answer, and a later question shown as sent and waiting behind it |
| `detail.stalled` | PR detail / Possibly stalled | A claimed job with no result after 60 minutes: agent ID, elapsed time, Retry |
| `detail.failed` | PR detail / Failed | The failed job with its reason and Retry; the text the turn produced stays, marked incomplete |
| `detail.disconnected` | PR detail / Disconnected | Reconnecting banner; the last known content stays; the composer says it cannot send until the connection returns |
| `detail.earlier-version` | PR detail / Earlier version | An older SHA selected: its summary shown with a note that questions are answered at the latest analyzed head; a question naming a SHA and its answer showing that SHA |

## 3. Agent pool

A popover opened from the pool status in the header. Each frame shows the PR list with the popover open.

| State ID | Frame | Must show |
| --- | --- | --- |
| `pool.local` | Agent pool / Local agent present | Which agent IDs are present, last seen, waiting or holding a job; cloud available; jobs in flight |
| `pool.cloud-only` | Agent pool / No local agent | That new PRs go to cloud and existing local sessions wait |
| `pool.unavailable` | Agent pool / Unavailable | The status could not be read: the header button in its unavailable form and the popover saying so |
| `pool.loading` | Agent pool / Loading | The header button while the status is being read; the popover is closed |

## 4. Settings

| State ID | Frame | Must show |
| --- | --- | --- |
| `settings.default` | Settings / Default | Both prompts with text; the skills list with source, ref, pinned SHA, allowed tools; the register form |
| `settings.empty` | Settings / Empty | Empty prompt editors saying what each prompt is for; an empty skills list explaining what a skill is and how to register one |
| `settings.registering` | Settings / Registering | The register form busy while the ref is resolved and the skill fetched |
| `settings.register-review` | Settings / Review before registering | What will be pinned: name, description, source, SHA, allowed tools (or instructions only), files with scripts flagged; Register and Cancel |
| `settings.register-failed` | Settings / Register failed | The reason: URL or ref not found, no `SKILL.md`, invalid frontmatter, or the name already registered |
| `settings.saving` | Settings / Saving and saved | One prompt saving, the other saved |
| `settings.save-failed` | Settings / Save failed | A prompt whose save failed, with a way to retry |
| `settings.update` | Settings / Update review | The ref field that Update opens on a skill row (prefilled with the current ref, then "Review update"), holding the new ref, and below it the review: old → new ref and SHA and the change in allowed tools; Apply, which pins exactly the reviewed SHA, and Cancel, which leaves the skill as it is |
| `settings.remove` | Settings / Remove skill | A confirmation dialog whose safe action is Cancel |

## 5. Extension side panel

The PR detail at 360px: compact header, one pool status line, version menu, summary in a disclosure,
conversation, composer. The panel frames also check that long titles, agent IDs, metadata and code blocks fit.

| State ID | Frame | Must show |
| --- | --- | --- |
| `panel.default` | Panel / Default | All panel elements with a long PR title, an answer with a code block, and answer metadata |
| `panel.version-menu` | Panel / Version menu open | The version menu open: versions by SHA with status, the selected one checked |
| `panel.streaming` | Panel / Streaming | An answer arriving |
| `panel.summary-streaming` | Panel / Summary streaming | The analysis of a new push arriving in the summary disclosure: partial text and a running status |
| `panel.waiting-agent` | Panel / Waiting for a local agent | The waiting question and the compact job line |
| `panel.failed` | Panel / Failed | Compact job line with reason and Retry; incomplete text |
| `panel.disconnected` | Panel / Disconnected | Banner and the disabled composer with its reason |
| `panel.unavailable` | Panel / Status unavailable | The status line when the pool status cannot be read |
