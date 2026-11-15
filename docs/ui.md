# UI brief

What the interface has to show and do, as the input for the visual design. The system behind it is in
[design.md](design.md). This page lists screens, states and data; it does not decide visual style beyond what the
design requires.

## Constraints

- **One user.** The host is the only user. There are no accounts, roles or sharing.
- **Desktop first.** A later Chrome extension will show a side panel on GitHub PR pages and should reuse components.
  Elements marked **[panel]** below must work in a narrow panel (about 360 px wide); the others may assume a full page.
- **One UI language.** All UI text is written in one language and is not translated. Summaries and answers read as the
  host's prompts and skills say; the UI does not interpret or label that language.
- **Local and cloud look the same.** The UI never says which kind of agent works on a job. It shows the agent ID only
  where a job is being worked on.
- **State is live.** The conversation streams over a WebSocket and survives disconnects; the UI shows connection state
  where it affects what the user can do.
- **Markdown output.** Summaries and answers are Markdown with code blocks; raw HTML is not rendered.

## Screens

### 1. PR list

Every pull request prq follows, across repositories.

| Element | Data |
| --- | --- |
| Row | repository, PR number, title, PR state (open, closed, merged), latest analyzed head SHA (short), analysis status, last activity time |
| Row badges | number of questions waiting, a failed-job marker, a "stalled" marker for a claimed job with no result after 60 minutes |
| Header | the pool status and budget summary (see screen 3), link to settings |

States:

- **Empty:** no PR yet. Explains that PRs appear when the GitHub App receives a webhook for the host's own pull request.
- **Loading:** list not yet received.
- **Waiting for a local agent:** rows whose jobs are waiting while no local agent is present show a waiting marker.
- **Failed:** rows with a failed job are marked and can be found without opening each one.
- **Budget exceeded:** cloud jobs are stopped; affected rows say so (see screen 3).

### 2. PR detail

One pull request: the summary, its history by version, the conversation and the jobs.

| Element | Data | Narrow panel |
| --- | --- | --- |
| Header | repository, number, title, PR state, link to the PR on GitHub | **[panel]** (compact) |
| Summary | the latest analysis (Markdown), the head SHA it was made for, the time, the model and tokens used | **[panel]** |
| Version history | the analyses by head SHA: SHA (short), time, status (done, running, waiting, failed, superseded). Selecting one shows that summary | **[panel]** (as a menu) |
| Conversation | the full history in saved order: user questions and answers. Each answer is paired with its question and shows the SHA it was answered against, the model and the tokens used | **[panel]** |
| Composer | text field and send. Disabled or marked while the connection is down | **[panel]** |
| Job status | for each job: target (head SHA or question), state (waiting, running, failed, done), and while running the agent ID that is working on it and since when | **[panel]** (inline, compact) |
| Job actions | "Retry" on a failed job and on a stalled job | **[panel]** |
| Stop | stop a running cloud turn (aborting is supported; interrupting is not) | **[panel]** |

States:

- **Empty:** the PR is known but has no analysis yet. Shows that an analysis is queued or why it has not started.
- **Loading:** history is loading; the summary area keeps its place.
- **Streaming:** an answer or summary arrives in parts. Shows partial text, a stop control, and no duplicate send.
- **Waiting for a local agent:** a question or analysis is saved but no local agent is present. Says it is waiting for
  an agent, since when, and that it continues when one returns; the composer still accepts questions.
- **Running on an agent:** shows which agent ID and since when.
- **Question waiting behind a running turn:** the question is shown as sent and waiting, since a new question cannot
  interrupt the running one.
- **Stalled:** a claimed job has no result after 60 minutes. Shows the agent ID and the time, with "Retry".
- **Failed:** shows the reason (error, step limit, token limit, budget) and "Retry"; the failed job stays in the list.
- **Budget exceeded:** cloud jobs for this PR are stopped; says why and until when (the daily budget).
- **Disconnected:** the connection to the server dropped; shows reconnecting and keeps the last known content.
- **Question about an earlier version:** the user names a SHA in the question; the answer shows that SHA.

### 3. Agent pool and budget

A status area available from the list and the detail screens. It may be a header element, a popover or a page.

| Element | Data | Narrow panel |
| --- | --- | --- |
| Local presence | whether any local agent is present, and per agent ID: last seen, whether it is waiting or holds a job | status line only |
| Cloud | always available, unless stopped by the budget | status line only |
| Daily cloud budget | tokens used today against the daily budget, the time it resets | **[panel]** (status line) |
| Jobs in flight | count of waiting, running and failed jobs | status line only |

States:

- **No local agent present:** shows that new PRs go to cloud and existing local sessions wait.
- **Local agent present:** shows which agent IDs.
- **Budget exceeded:** shows that cloud jobs are stopped, with the usage and the reset time.
- **Loading / unavailable:** the status could not be read.

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

## Open questions for the design

- **The UI language.** The single language of the interface text is not decided.
- **Summary and conversation layout.** Whether the summary is pinned above the conversation or is the first message of
  it, and how much of the version history shows at once.
- **Comparing versions.** Whether two summaries (two SHAs) can be viewed side by side, or only one at a time.
- **PR list scope.** Whether closed and merged PRs are shown by default, and how they are filtered.
- **Stalled threshold.** Whether the 60-minute mark is shown to the user or only the elapsed time.
- **Skill trust.** How much of a skill (description, `allowed-tools`, whether it has scripts) must be visible before it
  is registered or updated.
- **Pool and budget placement.** Header, popover or page, and how it appears in the narrow panel.
- **Extension access.** How the side panel reaches the API from a GitHub page, which depends on how Access is applied to
  it. This does not change the screens above, but it limits which of them the panel can show.
