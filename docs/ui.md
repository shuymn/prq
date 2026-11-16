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
- **Markdown output.** Summaries and answers are Markdown with code blocks; raw HTML is not rendered.

## Screens

### 1. PR list

Every pull request prq follows, across repositories.

| Element | Data |
| --- | --- |
| Row | repository, PR number, title, PR state (open, closed, merged), latest analyzed head SHA (short), analysis status, last activity time |
| Row badges | number of questions waiting, a failed-job marker, a "possibly stalled" marker for a claimed job with no result after 60 minutes |
| Header | the pool status (see screen 3), link to settings |

States:

- **Empty:** no PR yet. Explains that PRs appear when the GitHub App receives a webhook for the host's own pull request.
- **Loading:** list not yet received.
- **Waiting for a local agent:** rows whose jobs are waiting while no local agent is present show a waiting marker.
- **Failed:** rows with a failed job are marked and can be found without opening each one.

Scope: open PRs are shown by default; a filter `Open | All` adds closed and merged PRs, whose rows show their state.
There is no repository filter, because one host follows a few repositories and rows are sorted by last activity.

### 2. PR detail

One pull request: the summary, its history by version, the conversation and the jobs.

| Element | Data | Narrow panel |
| --- | --- | --- |
| Header | repository, number, title, PR state, link to the PR on GitHub | **[panel]** (compact) |
| Summary | the latest analysis (Markdown), the head SHA it was made for, the time, the model and tokens used | **[panel]** |
| Version history | the analyses by head SHA: SHA (short), time, status (done, running, waiting, failed, superseded). Selecting one only displays that summary; questions are still answered at the latest analyzed head unless the question names a SHA | **[panel]** (as a menu) |
| Conversation | the full history in saved order: user questions and answers. Each answer is paired with its question and shows the SHA it was answered against, the model and the tokens used | **[panel]** |
| Composer | text field and send. Disabled or marked while the connection is down | **[panel]** |
| Job status | for each job: target (head SHA or question), state (waiting, running, failed, done), and while running the agent ID that is working on it and since when | **[panel]** (inline, compact) |
| Job actions | "Retry" on any claimed or failed job, at any time (the host may know the local session is gone before the stalled mark appears) | **[panel]** |

States:

- **Empty:** the PR is known but has no analysis yet. Shows that an analysis is queued or why it has not started.
- **Loading:** history is loading; the summary area keeps its place.
- **Streaming:** an answer or summary arrives in parts. Shows partial text and no duplicate send.
- **Waiting for a local agent:** a question or analysis is saved but no local agent is present. Says it is waiting for
  an agent, since when, and that it continues when one returns; the composer still accepts questions.
- **Running on an agent:** shows which agent ID and since when.
- **Question waiting behind a running turn:** the question is shown as sent and waiting, since a new question cannot
  interrupt the running one.
- **Possibly stalled:** a claimed job has no result after 60 minutes, and the UI starts showing it as possibly stalled.
  Shows the agent ID and the elapsed time. "Retry" is available before this point too.
- **Failed:** shows the reason (error, step limit, token limit, or the provider refusing a call, such as at its spend limit) and "Retry"; the failed job stays in the list.
  Text the turn had already produced stays in the conversation, marked incomplete.
- **Disconnected:** the connection to the server dropped; shows reconnecting and keeps the last known content.
- **Question about an earlier version:** the user names a SHA in the question; the answer shows that SHA.

Layout:

- **The summary is pinned above the conversation**, as its own section in the same scroll, not as the first message.
  The version selector changes only the summary, while the conversation is one continuous history; making the summary a
  message would mix versions into that history.
- **Desktop:** a main column (header, summary, conversation, composer at the bottom) and a right rail with the jobs and
  the full version history (it scrolls when long).
- **Panel:** one column: compact header, the pool status line, the version history as a menu, the summary
  in a disclosure (open by default), the conversation and the composer; jobs are shown inline and compact.
- **One version at a time.** Two summaries are not shown side by side: the purpose is understanding the PR as it is
  now, and two columns of Markdown do not fit the panel.

### 3. Agent pool

A status area available from the list and the detail screens (see Placement below).

| Element | Data | Narrow panel |
| --- | --- | --- |
| Local presence | whether any local agent is present, and per agent ID: last seen, whether it is waiting or holds a job | status line only |
| Cloud | always available | status line only |
| Jobs in flight | count of waiting, running and failed jobs | status line only |

States:

- **No local agent present:** shows that new PRs go to cloud and existing local sessions wait.
- **Local agent present:** shows which agent IDs.
- **Loading / unavailable:** the status could not be read.

Placement: on desktop, a status button in the app header (local agent presence and jobs in flight) opens a popover with
the details above. In the panel it is one status line with no popover.

### 4. Settings

| Element | Data |
| --- | --- |
| Analysis prompt | a multi-line editor for the free-form prompt used for summaries, with save |
| Answer prompt | a multi-line editor for the free-form prompt used for answers, with save |
| Skills list | one row per registered skill: name, description, source (GitHub URL, path), ref, pinned commit SHA, the tools its `allowed-tools` permits |
| Skill actions | remove; update to a new ref (shows the SHA change before applying) |
| Register a skill | fields for GitHub URL, path and ref, with a submit |

The prompts are plain text, such as "Write in Japanese. Polish the final text with the yomiyasu skill." There is no
language field.

States:

- **Empty prompts:** the editors are empty and say what the prompt is used for.
- **Empty skills list:** explains what a skill is and how to register one.
- **Registering:** the ref is being resolved and the skill fetched.
- **Register failed:** the URL or ref was not found, there is no `SKILL.md`, the frontmatter is invalid, or the name
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
