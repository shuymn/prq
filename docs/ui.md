# UI brief

What the interface has to show and do, as the input for the visual design. The system behind it is in
[design.md](design.md). This page lists screens, states and data. The visual design answering it is the Pencil document
`design/prq.pen`; its tokens, components and the frame for each state are in [design/](../design/README.md).

## Constraints

- **One user.** The host is the only user. There are no accounts, roles or sharing.
- **Desktop first.** A later Chrome extension will show a side panel on GitHub PR pages and should reuse components.
  Elements marked **[panel]** below must work in a narrow panel (about 360 px wide); the others may assume a full page.
- **One UI language: English.** All UI text is written in English and is not translated. Summaries and answers read as
  the host's prompts and skills say; the UI does not interpret or label their language.
- **Dark only.** The host uses dark mode, so the UI has one color scheme (`color-scheme: dark`) and no theme switch.
- **Output looks the same whichever agent made it.** Summaries and the conversation do not show which agent produced
  them. The operational parts do name the agent (an agent ID, or cloud): the job status, the agent pool and the
  explanations of why something is waiting.
- **State is live.** The conversation streams over a WebSocket and survives disconnects; the UI shows connection state
  where it affects what the user can do.
- **New version.** After a deploy, a tab still running the old bundle shows a notice to reload; it does not block
  anything (see [Caching](design.md#caching)).
- **Markdown output.** Summaries and answers are Markdown with code blocks; raw HTML is not rendered.

## Screens

### 1. PR list

Every pull request prq follows, across repositories. The list is for getting back to a PR; processing is
shown only where the host has to act.

| Element         | Data                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Row             | one compact line at a fixed height: PR state (open, closed, merged), repository (in its own column, not muted: the host tells PRs apart by it; only the name when every PR has the same owner, `owner/name` otherwise), title (truncated) and PR number, the latest event and its time ("Summary 12 min ago", "Answer 3 min ago", "Push received 2 min ago") |
| Status          | short text in its own column, only while something is unresolved: "Summary failed", "Answer failed", "Possibly stalled", "Waiting for a local agent"; and "New push not summarized" while the latest summary is for an older head. One label at a time, in the order of the [PR ledger](design.md#pr-ledger). Empty for a healthy row                        |
| Header          | the product mark and name with the deployed version (`vX.Y.Z`, muted), the pool status (see screen 3), a settings button                                                                                                                                                                                                                                     |
| Column headings | Repository, Pull request, Status, Last activity: rows are a table                                                                                                                                                                                                                                                                                            |

Rows are in the order of their latest event: a push received, a question sent, a summary or an answer completed.
Claims, heartbeats and streaming do not move a row. Routine progress (queued, running, done) is not shown in the list.

States:

- **Empty:** no PR yet. Explains that PRs appear when the GitHub App receives a webhook for the host's own pull request.
- **Loading:** list not yet received.
- **Waiting for a local agent:** rows whose work waits while no local agent is present say so.
- **Failed:** rows with an unresolved failure say what failed and can be found without opening each one.

Filters: open PRs are shown by default; `Open | All` adds closed and merged PRs, whose rows show their state. A
repository menu narrows the list to one repository. "Needs attention" with its count appears only when a PR has an
unresolved problem the host can act on (a failure or a possibly stalled job to retry, work waiting for a local agent to
start), and keeps those rows. "New push not summarized" does not count, nor does a failure a later retry resolved.

### 2. PR detail

One pull request: the summary, its history by version, the conversation and the jobs.

| Element         | Data                                                                                                                                                                                                                                                                                         | Narrow panel                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Header          | repository, number, title, PR state, link to the PR on GitHub                                                                                                                                                                                                                                | **[panel]** (compact)         |
| Summary         | the latest analysis (Markdown), the head SHA it was made for, the time, the model and tokens used                                                                                                                                                                                            | **[panel]**                   |
| Version history | the analyses by head SHA: SHA (short), time, status (done, running, waiting, failed, superseded). Selecting one only displays that summary; questions are answered at the latest analyzed head, and a question about another commit is answered by reading that commit, in the answer's text | **[panel]** (as a menu)       |
| Conversation    | the full history in saved order: user questions and answers. Each answer is paired with its question and shows the SHA it was answered against, the model and the tokens used                                                                                                                | **[panel]**                   |
| Composer        | text field and send. Disabled or marked while the connection is down                                                                                                                                                                                                                         | **[panel]**                   |
| Job status      | for each job: target (head SHA or question), state (waiting, running, failed, done), and while running the agent ID working on it, or cloud, and since when                                                                                                                                  | **[panel]** (inline, compact) |
| Job actions     | "Retry" on any claimed or failed job, at any time (the host may know the local session is gone before the stalled mark appears)                                                                                                                                                              | **[panel]**                   |

States:

- **Empty:** the PR is known but has no analysis yet. Shows that an analysis is queued or why it has not started.
- **Loading:** history is loading; the summary area keeps its place.
- **Streaming:** an answer or summary arrives in parts. Shows partial text and no duplicate send. Streaming runs in
  the cloud: its line says cloud and when the turn started, without Retry, since a running cloud job cannot be retried.
- **Waiting for a local agent:** a question or analysis is saved but no local agent is present. Says it is waiting for
  an agent, since when, and that it continues when one returns; the composer still accepts questions.
- **Running on an agent:** shows which agent ID and since when.
- **Question waiting behind a running turn:** the question is shown as sent and waiting, since a new question cannot
  interrupt the running one.
- **Possibly stalled:** a claimed job has no result after 60 minutes, and the UI starts showing it as possibly stalled.
  Shows the agent ID and the elapsed time. "Retry" is available before this point too.
- **Failed:** shows the reason (error, step limit, token limit, or the provider refusing a call, such as at its spend
  limit) and "Retry" next to what failed: at the summary for an analysis, under the incomplete answer for a question.
  Text the turn had already produced stays in the conversation, marked incomplete. The failed job stays in the jobs
  list.
- **Disconnected:** the connection to the server dropped; shows reconnecting and keeps the last known content. When
  reconnecting keeps failing (for example, the sign-in expired), it offers Reload.
- **Question about an earlier version:** the user names a SHA in the question; the answer shows the SHA it was
  answered at and addresses the named commit in its text.
- **Send failed:** the server refused a question, or the connection dropped before it was saved. The question stays in
  the conversation, marked "Not sent" (or "Couldn't confirm it was sent" when checking failed), with Try again and
  Discard. Send stays off until it is saved or discarded, the draft stays editable, and reloading the page loses it.

Layout:

- **The summary is pinned above the conversation**, as its own section in the same scroll, not as the first message.
  The version selector changes only the summary, while the conversation is one continuous history; making the summary a
  message would mix versions into that history.
- **The page is about the summary and the conversation.** The summary heading shows its SHA and time with a version
  menu, so another version can be picked with the rail collapsed. While a newer push is analyzed, the shown summary
  stays readable with a line saying a newer head is being summarized. When an earlier version is shown, the composer
  says that questions are answered at the latest analyzed head. Model and token figures are muted.
- **Desktop:** a main column (header, summary, conversation, composer at the bottom) and a right rail with the full
  version history and the jobs (it scrolls when long). A toggle collapses the rail, and the main column widens.
- **Panel:** one column: compact header, the summary in a disclosure (open by default) whose heading is the version
  menu, the conversation and the composer. Operational lines (the pool, a job) appear only where they explain content
  that is blocked or failed.
- **One version at a time.** Two summaries are not shown side by side: the purpose is understanding the PR as it is
  now, and two columns of Markdown do not fit the panel.

### 3. Agent pool

A status area available from the list and the detail screens (see Placement below).

| Element        | Data                                                                                                  | Narrow panel     |
| -------------- | ----------------------------------------------------------------------------------------------------- | ---------------- |
| Local presence | whether any local agent is present, and per agent ID: last seen, whether it is waiting or holds a job | status line only |
| Cloud          | always available                                                                                      | status line only |
| Jobs in flight | count of waiting, running and failed jobs                                                             | status line only |

States:

- **No local agent present:** shows that new PRs go to cloud and existing local sessions wait.
- **Local agent present:** shows which agent IDs.
- **Loading / unavailable:** the status could not be read.

Placement: on desktop, a status button in the app header (local agent presence and jobs in flight) opens a popover with
the details above. In the panel it is one status line with no popover.

### 4. Settings

| Element         | Data                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analysis prompt | a multi-line editor for the free-form prompt used for summaries, with save                                                                                                    |
| Answer prompt   | a multi-line editor for the free-form prompt used for answers, with save                                                                                                      |
| Skills list     | one row per registered skill: name, description, source (repository and path), ref, pinned commit SHA, the tools its `allowed-tools` permits                                  |
| Skill actions   | remove; update to a new ref (shows the SHA change before applying)                                                                                                            |
| Add a skill     | a dialog with one field: the GitHub link to the skill's `SKILL.md` (`https://github.com/<owner>/<repo>/blob/<ref>/<path>/SKILL.md`), which gives the repository, ref and path |

The prompts are plain text, such as "Write in Japanese. Polish the final text with the yomiyasu skill." There is no
language field.

States:

- **Empty prompts:** the editors are empty and say what the prompt is used for.
- **Empty skills list:** explains what a skill is and how to register one.
- **Registering:** the ref is being resolved and the skill fetched.
- **Register failed:** the link is not a GitHub link to a `SKILL.md`, the repository or ref was not found, there is no `SKILL.md`, the frontmatter is invalid, or the name
  is already registered.
- **Saving / saved / save failed** for the prompts.
- **Update available or applied:** after choosing a new ref, shows the old and new SHA.

Skill trust: registering and updating are two steps. The first resolves the ref and fetches the skill without saving
it, and shows what would be pinned: name, description, source, the commit SHA (old and new for an update), the tools
its `allowed-tools` permits (or that it has none, so in the cloud it contributes instructions and references only),
and its files with scripts flagged. Confirming pins exactly that SHA; it does not resolve the ref again.

## Open questions

- **Extension access.** How the side panel reaches the API from a GitHub page, which depends on how Access is applied to
  it. This does not change the screens above, but it limits which of them the panel can show. It is decided with the
  extension (#10).
