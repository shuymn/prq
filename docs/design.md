# Design

What prq is, how it is built, and the rules its parts follow. Library and platform choices are in
[decisions.md](decisions.md), the screens to design are in [ui.md](ui.md), and what the prototype showed is in
[spikes.md](spikes.md).

## Purpose and principles

prq is an application for understanding your own pull requests. It is for one person: the one who hosts it. It follows the
pull requests that person opens across several repositories. For each one it writes a summary that takes the code around
the diff and the task behind it into account, not only the diff, and it lets the host keep asking questions in the same
conversation.

- **The core is language-neutral and minimal.** It decides nothing about how a summary or an answer should read. The
  host writes that in instructions (two prompts and a set of skills, see [Instructions and
  skills](#instructions-and-skills)), and the model decides when to use them. The analysis notes, which only the model
  reads, are language-neutral too. The UI text is written in one language and is not translated.
- **Local and cloud agents are treated alike.** An analysis can run in a local AI session on a subscription (Claude
  Code, Codex or another; prq does not name one) or in a cloud agent that calls an LLM with an API key. Summaries and the
  conversation look the same whichever agent made them; only the operational parts (job status, the pool, explanations
  of waiting) name the agent.
- **Agents form a pool.** A cloud agent is always in the pool. A local agent is in the pool only while `prq` is
  running, and when one is present it is preferred over cloud.
- **A local agent is woken by the AI's own mechanism.** The AI session starts a background `prq wait` and resumes when
  the command ends. There is no resident program. While the AI session is closed nothing wakes up on its own; jobs stay
  queued and the next `wait` returns them.
- **One conversation per pull request.** A question never starts from zero, and the conversation the host sees is never
  lost.
- **The owner of a session is fixed.** When a PR session receives its first job (the first push or question), the pool
  decides whether it is `cloud` or `local`, and the session keeps that owner. There is no handoff between the two. A `local` session whose agent is away waits;
  it only gets slower, and the conversation continues when an agent returns. A handoff is added if that turns out to
  hurt in use.
- **GitHub API use is minimal.** Events arrive by webhook and code comes from git.
- **Detect rather than over-engineer.** Only the host uses the system, so unlikely mistakes are not designed away;
  they are made visible (see [Observability](#observability)). Two things are enforced from the start: the entry points
  open to the internet (webhook signature, Access) and the billing limits.
- **Few layers.** The only abstraction between local and cloud is the minimum that lets them share one set of rules.
- **A browser extension comes later.** A Chrome extension will show the summary and a question box on GitHub PR pages.
  The UI and the API are shaped so its components can be reused.

## Architecture

```
GitHub App (webhook; Contents, Pull requests and Issues read)
   │
Worker (Hono)
   /webhook   bypasses Access; HMAC check; accepts only PRs whose author is the host
   others     Access (the host's email in a browser, or a service token for prq)
   │
   ├─ PrSession (AIChatAgent, one instance per PR, name = owner~repo~n)
   │    source of truth for the conversation (full history, AI SDK UIMessage)
   │    owner (cloud | local, fixed at the first job) and job state
   │    model context (after compaction) and the analysis notes
   │    cloud owner: streamText with tools in onChatMessage; reads the code in its Workspace
   │    local owner: input is only stored → notify Hub → prq claims → the answer is appended
   │
   └─ Hub (Agents SDK Agent, one instance)
        ledger of PRs (for the list), agent pool (local presence), queue of notifications for local agents
        instructions: the two prompts and the registered skills (pinned to commit SHAs)

Local: prq (CLI, one binary) wait / claim / context / checkout / submit / reconcile
UI:    React + Vite (Workers Static Assets), connected to PrSession with useAgentChat
```

- **Worker.** Hono routes. `/webhook` verifies the GitHub signature. Every other path sits behind Access and verifies the
  Access JWT itself.
- **PrSession.** One `AIChatAgent` per pull request. It holds the conversation, the owner, the jobs, the model context
  and the analysis notes, and it is the only place that decides job state. The instance name is `owner~repo~n`:
  `routeAgentRequest` takes path segments as the name without percent-decoding, so `/` and `#` cannot be used, and `~`
  is safe in URLs and cannot appear in a GitHub owner or repository name. The name is canonical (`sessionName` in
  `@prq/protocol`): owner and repository in lower case, since GitHub treats them case-insensitively, and the number
  without leading zeros, so one pull request has one instance.
- **Agents routes.** `/agents/*` serves a WebSocket to the Hub named `hub` or to a PrSession under its canonical name,
  and a GET of a session's stored history (`/agents/pr-session/<name>/get-messages`). Any other request (another name,
  a case variant, a leading zero, a percent-encoded `~`, a binding the Agents SDK does not know, a sub-agent path or any
  other path below an instance, a plain HTTP request to an instance) gets 404 before the SDK router runs, so it creates
  no instance. Only `names.ts` addresses a Durable Object.
- **Hub.** One `Agent` instance, named `hub`, that holds the PR ledger for the list view, the pool (which agent IDs are
  present), the notification queue for local agents, and the instructions (the two prompts and the skill registry). It
  does not hold job state; it asks PrSession (`peek`, `claim`). Each ledger entry keeps what a list row shows (see
  [PR ledger](#pr-ledger)).
- **Model.** The cloud agent's model is any provider with an OpenAI-compatible chat completions API, through the AI
  SDK's `@ai-sdk/openai-compatible`, built once per isolate from four secrets: `MODEL_BASE_URL` (the API's https
  root), `MODEL_API_KEY`, `MODEL_ID` and `MODEL_CONTEXT_TOKENS` (the model's context window in tokens, since providers
  do not report it reliably). The window is at least 16,384: below that the system prompt, the tool definitions and one
  cut tool result leave no room for a conversation, and every turn would compact. With none of the four set (or all
  four empty, as the tests' runtime sets them), a cloud job fails `cloud agent not configured`; with some set or one
  malformed, it fails `cloud agent misconfigured: <each variable and what is wrong with it>`, never a value, and
  `prq.config.invalid` is logged. `pnpm run check:provider`
  in `packages/server` shows what a provider does with the requests a turn makes, and `pnpm run check:tools` runs a
  turn's tool loop against it over an in-memory repository, with a window small enough that the tools are withdrawn.
- **prq CLI.** Runs on the host's machine, talks to the Worker over HTTP with a service token, and uses the host's own
  git and `gh`.
- **Workspace.** The cloud workspace of a PrSession: a Durable Object driving a container with a checkout of the PR
  that the agent searches and reads with tools. Its only way out is `GitEgress`, a Worker entrypoint that lets git
  fetches from github.com through with the installation token.
- **UI.** A React app served by the same Worker. State lives on the server; the `useAgentChat` and `useAgent` hooks
  keep the client in sync, and screen-only state is local `useState`.

## State and rules

### Owner and jobs

PrSession keeps the owner and the job state in one place and processes `claim`, `submit` and retry one after another.

- When a PrSession receives its first job (the first push or question), the system shall look at the Hub pool and set
  the owner to `local` if any local agent is present, otherwise `cloud`; opening the PR in the UI decides nothing. When
  two first jobs race, the first decision wins. The owner does not change afterwards, and all analyses and questions of
  the session are handled by it.
- `local` is a kind, not a binding to one AI session. Any local agent in the pool may claim a pending job, because the
  conversation and the notes are in PrSession and the worktree can be rebuilt.
- A job has a `jobId` and a target. An analysis is identified by the PR and its head SHA; an answer by the message ID of
  the question. Every `claim` issues a new `claimId` and records the agent ID that made it. A job also has a run
  (`run`), 1 at first, which advances each time the job goes back to waiting (a retry, or a push back to its superseded
  head), in the statement that does it; a claim returns it, and a submit names the run its answer was produced under.
- A job is `pending` (waiting), `claimed` by a local agent, `finalizing` while its submit appends the result, `running`
  in the cloud agent, `done`, `failed` or `superseded`. Each change is one SQL statement guarded by the state it
  expects (and the claim), so a state is never read in one step and changed in another, and the same statement
  advances the job's revision (`rev`), which the session view shows. The next job is the oldest waiting answer, then
  the waiting analysis, for both owners.
- When an agent calls `wait` or `claim`, the system shall return that agent ID's own claimed, unfinished job before any
  new job, with a new `claimId`. A process that was killed and restarted can therefore continue at once, and an answer
  that arrives late from the old process is rejected. A resume is a claim: it also sets the claim time again.
- A job claimed by one agent ID shall not be returned to another agent ID.
- When a `submit` arrives, the system shall accept it only if `jobId`, `claimId`, the agent ID, the target (head SHA
  or question message ID) and the run match the current state, so an answer produced before the job last went back to
  waiting is never accepted.
  When the submit that completed a job arrives again (the same `claimId`, run, agent ID and target), the system shall
  return the result already recorded and shall not add it to the
  conversation a second time; any other submit to a completed job is rejected.
- A submit waits for the conversation to settle (`waitUntilStable`) before it enters the history write queue: the SDK
  counts a client's save as pending until the save returns, so waiting inside the queue could wait on a save queued
  behind the submit. Inside the queue it reads the job again, checks it, moves it from `claimed` to `finalizing` (the
  point at which it wins), appends the answer as message `<kind>-<jobId>` (`answer-<jobId>` for a question,
  `analysis-<jobId>` for an analysis), and marks the job `done`. A retry or resume before that point makes the submit
  fail as a stale claim; a retry while the job is `finalizing` is refused, and a resume does not return it. A submit
  that fails on the way leaves the job `claimed` for the agent to submit again. A local agent cannot report a failure:
  an unfinished job stays claimed until the host retries it.
- When a submit gets 409 `stale_claim`, `prq` shall claim again once and, only if that claim returns the same job in
  the same run at the same `workspaceSha`, resubmit the answer under the new `claimId` with the run the answer was
  produced under; the server accepts it only if no retry came since. When the claim returns the same job and run at
  another `workspaceSha`, `prq` shall keep the claim and drop the answer: a resume fixes the workspace again, and the
  stored answer would be labelled with the new commit though it was written at the old one. Otherwise (another job, a
  newer run, no job, or 409 `stale_claim` again) `prq` shall drop the answer and work on what the claim returned. A
  claim that lands after its route answered 503 can replace the `claimId` the agent holds (see
  [Notification and wait](#notification-and-wait-prq-wait)), and this recovers it without accepting an answer from
  before a retry, whichever order the retry and the late claim came in, or one labelled with a workspace it was not
  written at.
- `context` gives a local agent what it works on its claimed job from: the pull request (canonical), its details
  (null before its first webhook), the job as its claim fixed it, and the conversation. The job's `workspaceSha` is
  fixed at the claim: an analysis's head; for an answer, the head of the latest completed analysis, else the current
  head, else none. Only the job's current claim, held by the same agent ID, gets it; any other claim gets 409
  `stale_claim`. The conversation comes in pages, and a whole response (the pull request, the details, the job, the
  messages and the cursor) takes at most 8 MiB as UTF-8 JSON: a response crosses a Durable Object RPC call, whose limit
  is 32 MiB of serialized data, and V8 serializes a string with characters beyond Latin-1 at two bytes per code unit,
  so 8 MiB keeps a page well inside the limit. A page leaves room for the details at their longest (the lengths
  `PrDetails` allows, above GitHub's own) and for a cursor naming the conversation's longest message ID. A response's
  `nextCursor` names where the next page starts (a message and an offset in its text) and is null on the last page.
  The conversation is append-only, so a cursor stays valid while messages are added; the next page then includes them.
  A message larger than a page comes in parts, each carrying `part` (its offset and the message's whole length), and
  its parts joined are the message. A cursor that names no place in the conversation gets 400 `bad_request`. A page
  that cannot hold even the first character of its message within the budget is refused with 500 `internal` (logged
  as `prq.context.overflow`) rather than sent over it; bounded IDs and details keep that to rows stored before the
  bounds.
- A job carries no text of unbounded length, in a claim or in a context: an answer's question is the message its
  target names, which the agent reads from the context's pages. A claim's response therefore stays small however long
  the question is.
- While no local agent is present, the jobs of a `local` session wait, questions included.
- A job that was claimed but never submitted (the AI session was closed, for example) is not returned automatically.
  The UI shows which agent ID has been working on it and since when, and starts showing it as possibly stalled after 60
  minutes. "Retry" is available on any claimed or failed job at any time, because the host may know the session is gone
  before that mark appears. A retry puts the job back to pending and changes the `claimId`, so an answer that arrives
  late from the earlier claim is rejected. A retry of an analysis whose head is no longer the current one supersedes
  it instead, its claim ended the same way, and answers `superseded`: only the current head's analysis waits. Which of
  the two applies is decided in the retry's statement, against the head at that moment.
- A failed job is kept as `failed` with its reason and can be retried from the UI. The UI retries a job through
  `POST /api/pr/:owner/:repo/:number/jobs/:jobId/retry`; owner and repository are accepted in any case and address the
  one session of the pull request.
- A retry carries the job's `rev` from the view the UI shows (`expectedRev`). The session applies it only while the job
  is still at that revision, checked in the statement that changes it, and otherwise answers 409 `stale_job`, after
  which the UI reads the view again. A retry sent again, or one that lands late, therefore never undoes a change made
  after the view it came from (a claim, another retry, a new failure), even when the job is back in the state the view
  showed. A refused retry changes no job state; any wake it armed only runs `settle`.
- A cloud session hands its next waiting job to the cloud agent in the same step that made the job waiting, one job
  at a time (the job is `running` until its turn ends). While no cloud agent is configured, that step instead marks
  the job `failed` with "cloud agent not configured"; no model is called and nothing is streamed. A running job that
  `settle` finds after the configuration was removed fails the same way, rather than waiting for one that may not come.
- The cloud agent runs a job as one chat turn of the Agents SDK, bound to the job. The hand-over sets the job
  `running` under a new turn ID and counts a start of its run, then starts the turn through `saveMessages`, whose
  function binds the turn to the job inside the turn's exclusive slot, right before that turn's `onChatMessage`; it
  stores no request message. Only the turn that took the binding calls the model, and only while the job is still
  running under its turn ID. A chat request's turn makes jobs and calls no model, and a binding that no
  `onChatMessage` took is cleared when its turn ends.
- A job with a workspace commit (every analysis, and an answer after a push) runs only in a workspace at that commit;
  without one it fails "workspace: not available" with no model call, so no result is stored that was produced
  without the code it is about. A question asked before any push has no workspace commit and runs without one.
- When the SDK's turn has ended, the session commits it inside the history write queue, against the job's state and
  turn ID: a commit whose job has moved on (a restart, a retry) appends nothing and is logged as `prq.turn.stale`. A
  turn whose final finish reason is `stop` and whose result holds answer text that is not blank appends that result as
  `<kind>-<jobId>`, without reasoning and with only the tool parts whose result is settled, its metadata naming the
  cloud model and the run's usage; the job then becomes `done` in one statement that also clears a failure it had and
  advances `rev`. Any other ending (an error, a cancel, the output limit, the content filter, any other finish reason,
  or a `stop` with no answer text, "the model returned no answer text") fails the job with the reason, so the host can
  retry it, and text already produced is appended as `<kind>-<jobId>-r<run>-incomplete`, marked incomplete with the
  reason, which leaves `<kind>-<jobId>` for a later success.
- After a reset, `settle` takes each running cloud job whose turn is no longer live and, in one statement guarded by
  that turn, marks it `done` when its result is stored, fails it with the stored reason when its run's incomplete text
  is stored (either way the commit stopped between its append and its statement, and the run had ended), starts it
  again under a new turn while its run has had fewer than 3 starts, or fails it "the turn was interrupted 3
  times by restarts; retry to run it again". Two restarts cover a deploy or an eviction, and a turn that brings the
  object down every time cannot restart forever. A commit that failed is taken up the same way at the next `settle`.
  The SDK's own durable recovery cannot be turned off and is declined in `onChatRecovery`: its retry needs the turn's
  user message last, which an analysis never has and an answer loses once a later question is stored, and its
  continuation rewrites the last assistant message, which may be another job's.

### Intake

UI, webhook and CLI input all enter through PrSession.

- When the UI sends a message, it arrives in `onChatMessage`. PrSession runs no turn there: it creates a job for every
  user question that has none (deciding the owner at the session's first job) and hands the jobs on, to the Hub for a
  `local` session and to the cloud agent for a `cloud` one. A question can already be stored when a later turn starts,
  which is why every question without a job gets one, not only the last message.
- Which questions wait for a job is kept in its own table, not found by reading the history. The history write that
  adds questions (one at a time, in the write queue) writes an intake row for each before storing it, so a stored
  question always has its job or its row, however long the history. Creating jobs reads the intake rows inside the same
  queue, where no question is between its row and its insert: a row whose question is not stored was left by a write
  that failed or stopped, and is dropped. Each job is created in one step with the removal of its row.
- An analysis is made per push, at the pushed head SHA: GitHub sends one `pull_request` event per push, and the commits
  inside a push are not analyzed one by one.
- When a webhook arrives, it goes to the PrSession, not to the Hub. The session stores the verified delivery in its
  inbox as the first step of the call, before anything awaits, and arms a wake; the route answers once that returns,
  and `settle` takes the delivery in at the wake, seconds later. A delivery the route acknowledged is therefore never
  lost to a failure after the answer: taking it in marks it processed in the same storage step as its effect, so it is
  taken in once, and a step that fails leaves it stored for settle's retry. A delivery is stored once per
  `X-GitHub-Delivery`, which a redelivery from GitHub repeats: one whose ID is stored gets `duplicate` and changes
  nothing. Processed rows are kept, so a redelivery is known whenever it comes; there is one small row per event of
  one pull request.
- When the session is not reached within the route's bound (5 s, under the 10 s after which GitHub counts a delivery
  failed), the route answers 503 and GitHub records the delivery as failed; GitHub does not send it again by itself. The
  recovery is to redeliver it from the GitHub App's recent deliveries. A call that stored it after the 503 makes the
  redelivery a duplicate, so it is taken in once either way.
- Webhooks are ordered by what GitHub says, not by when the session gets to them, and without prq's clocks. A push
  (`opened`, `reopened`, `synchronize`) makes its SHA the current head when its `pull_request.updated_at` is later than
  the current head's, or is the same second and the push moved from the current head (`synchronize`'s `before`) or is
  the current head. `opened` and `reopened` carry no `before` and are ordered by time alone. A push that does not
  become current creates no job.
  - Guaranteed: pushes at least a second apart end with the latest one current, in whatever order they are taken in,
    and a force-push back to A (`before` B, `after` A) makes A current again. A lost delivery is healed by the next
    push a second or more later, whatever that push moved from.
  - Not guaranteed: `updated_at` has whole seconds, and `before` cannot order a same-second sequence that returns to an
    earlier head. A force-push sequence A, B, A, B within one second whose middle A is taken in last leaves A current,
    and a delivery lost inside a same-second chain (A, B, C with B lost) leaves A current, because C names a head the
    session never saw. A same-second push not linked to the current head leaves the head as it is.
  - What heals them: the next push, a second or more later; and, with the GitHub App configured, head reconciliation
    (below). The limit is accepted because it takes several pushes within one second, the head it leaves is the one
    shown with the pull request, and the next push corrects it.
- Head reconciliation keeps one invariant: in GitHub's order (whole seconds, and within one second the `before` links),
  the head is never older than a push taken in, and an answer from GitHub's API becomes the head only when it is at
  least as new as every push taken in.
  - A push of the head's second that is kept out, or that moves the head to another head through `before`, is a tie
    and marks the session with that second. A push of a later second clears the mark, since it is newer than every
    state of the tied second, so the mark is always empty or the head's second.
  - While the session is marked, `settle` reads the pull request once (its head and `updated_at`) with a token of the
    App installation the deliveries name; one read is in flight at a time, and a settle never reads twice. The answer
    is judged against the session as it is when the answer lands. If a push was taken in since the read was sent, the
    answer is discarded and the mark waits for settle's retry wake. An answer older than the head (an earlier
    `updated_at`, or the head's second with a head that a push of that second already taken in had left, unless that
    second's `before` links return to it) is a failed try. Any other answer is adopted: a different head becomes
    current as a push makes it (analyses folded, created or revived), and the head is dated by the answer's
    `updated_at`, so a late push stamped in that second ties rather than counting as newer.
  - A failed try (a lagging answer, a network error, a 5xx or 429, or no answer within 10 s) waits for settle's retry
    wake; after 5 the mark is cleared and logged. Any other 4xx clears it, and the next push heals the head as before.
    Edits that move `updated_at` are safe: an answer is one snapshot, and edits never move the head's time.
  - Guaranteed: when a same-second tie's deliveries have all been taken in, the head becomes GitHub's, unless a push
    is taken in after the read was sent; that read is discarded and the next one decides.
  - Not guaranteed: `before` cannot order a same-second return (A, B, A, B), so a lagging answer inside one can be
    adopted until the next push a second or more later. A delivery lost inside a same-second return reads the same
    as a lagging answer: the head before the return can stay until the next push, or until the lost delivery is
    redelivered from the App's recent deliveries, which completes the return for the next read. Without the App
    configured, there is no reconciliation and the limits above stay as they are.
- If an analysis job for the current head SHA already exists (waiting, claimed, running, done or failed), the system
  shall create no job and leave that job as it is; a push back to an already analyzed head (after a force-push, for
  example) shows that head's stored summary, and a failed one stays failed until the host retries it. A new delivery
  of the current head therefore changes nothing. `edited` and `closed` update the title and the state (`merged` when
  merged) and create no job; only a push moves the head, except that a session with no head takes the event's. The
  details other than the head (title, state, base, URL) follow the webhook with the latest `updated_at`, whether or not
  it moved the head; among webhooks of the same second the last one taken in wins.
- Analysis jobs that have not started are folded into the latest head: every push supersedes the waiting analyses of
  the other heads, so if A is running and B and C arrive, only C runs after A. A push back to a superseded head makes
  its job wait again, with the same `jobId` and a new run, so no answer from before the fold is accepted. A retry of an
  old head's analysis folds it the same way (see [Owner and jobs](#owner-and-jobs)).
- A waiting question runs before the next analysis.
- The server appends its own messages (a local answer, a cloud result or its incomplete text) through its own insert
  inside the history write queue, which decides what is new against the history as it is then, never against a stale
  `this.messages`. No request message is stored: a cloud turn starts through `saveMessages` with a function that
  returns the history unchanged.
- The stored conversation is append-only: whatever a client sends, a stored message keeps its content and place and
  none is removed. A client adds questions only: a chat request carries the client's whole list, and PrSession adds
  the user messages whose IDs are not stored, after the stored ones. A new answer, system message or user message with
  metadata (which marks a message the server added) in a chat request is dropped and logged as `prq.chat.refused`;
  answers come from the server. A chat request whose messages are not all in the current `UIMessage` form, or that
  would add a message whose ID is not 1 to 256 characters (`MessageId`), is refused whole before anything is stored
  (no message, intake row or job) and answered with a failed response for its ID, which ends the request in the SDK's
  client. A stored message is echoed whatever its ID, so a row from before the bound does not refuse every later
  request. Every history write goes through one queue, so each starts from the history the previous one left.
- The Agents SDK's own history writes go through the same entry as a chat request and may add questions only: the
  streamed message at the end of a turn, a partial after an error or a cancel, an orphaned stream after a reset or on a
  resume, and a repair of interrupted tool calls add nothing, and each message dropped is counted by role in
  `prq.chat.dropped` (never its text). A cloud result enters only through its commit.
- After each write PrSession sends the stored history to every connection, the sender included, and a client replaces
  its list with it. These are the only chat lists the server sends: the Agents SDK's relay of a client's list to the
  other connections before the save is dropped. The history is read within the budget the SDK keeps it in memory
  under (`hydrationByteBudget`, 32 MiB). A longer history goes as `{ "type": "prq:history-changed" }`
  (`HistoryChangedMessage` in `@prq/protocol`) instead, since its most recent part would replace the whole list a
  client has; the UI then reloads the history through `get-messages`, which streams all of it.
- A connection the SDK is resuming a stream to (between its offer and the client's acknowledgement, when the SDK's own
  frames skip it) gets these lists too: the SDK sends no history after a resume, so a question stored during the
  handshake would otherwise be missing, and the list holds stored messages only, while a streamed result is stored at
  its commit, so the list and the replayed chunks never describe the same message.
- The client frames other than a chat request that write history (`cf_agent_chat_clear`, `cf_agent_chat_messages`,
  `cf_agent_tool_result`, `cf_agent_tool_approval`) are refused and logged as `prq.chat.refused`. prq has no
  client-side tools.
- A local answer never replaces the whole conversation. PrSession checks the question's message ID against the latest
  history and appends one answer through its own insert, which runs no turn and still reaches connected clients.
- History keeps the order in which messages were saved: a question sent during a turn comes before that turn's answer,
  and a local answer comes last. Each answer carries the message ID of its question in `metadata`, and the UI uses it to
  pair them.

### Notification and wait (`prq wait`)

- `prq` declares an agent ID when it connects (`--agent-id` or `PRQ_AGENT_ID`, the host name by default). Two AI sessions
  on one machine need two IDs. The ID is self-declared and is not authentication: every local agent uses the same
  service token.
- `wait` only receives a notification and never removes a job. A job stays until PrSession `claim`s it.
- When a local job becomes waiting (created or retried), PrSession writes an outbox row in the same storage step and
  delivers it to the Hub (`notify`) right after. Before any write that can create work (storing new questions, a
  retry), PrSession schedules a wake (`settle`, an Agents SDK schedule), so whenever work exists a wake already exists.
  A wake is a new schedule row each time: an idempotent one would match the row of a `settle` that is running and
  vanish when that run ends.
- `settle` runs from the wake and at every start. It takes in the stored webhook deliveries, creates the jobs of the
  questions with intake rows, finishes each `finalizing` job inside the history write queue (`done` when its message
  exists, else back to `claimed`), runs the cloud hand-over, schedules any held claim's missing `claimAged` check
  whose deadline is still ahead, and delivers the outbox (`notify` and the [PR ledger](#pr-ledger) entry, each on its
  own). A failed delivery keeps the row
  and schedules a retry (5 s, doubling to 60 s) only when no `settle` is scheduled for a later second; the check and
  the schedule run under one lock, so failures during a Hub outage leave one retry, not one per failure.
- Outbox rows and the Hub's notification rows carry a generation taken from a counter in the same object that only
  grows. A delivery or a check deletes the row only if its generation is still the one it read, so a row that was
  deleted and written again during a slow call is kept.
- The Hub keeps the sessions it was notified of in a queue. A check asks each queued session (`peek`) whether it has
  the agent's own claimed job or a waiting one, and drops a session that has no open job. A `claim` asks the queued
  sessions for the agent's own claimed job first, then for a waiting one. Each call to a session is bounded as a whole,
  the session's start included, and a session that does not answer in time is skipped and stays queued.
- A call the Hub stopped waiting for keeps running and can still land. So each `claim` is one attempt, numbered from the
  Hub's counter, and a session takes a claim only from an attempt newer than every attempt that agent has claimed
  under there: a session call from an older attempt changes nothing once a newer one has claimed. The session keeps
  each agent's newest claiming attempt apart from the jobs and advances it in the claim's transaction, so a retry,
  which clears a job's claim, does not lower it.
- `wait` checks the queued sessions when it starts and returns `ready` at once if the agent has its own claimed job or
  a waiting one. Otherwise it sleeps until a `notify` wakes it and checks again, and returns `timeout` after
  `min(timeoutMs, 25 s)`. A notify that lands during a check advances the Hub's counter; the wait reads the counter
  before each check and compares it after, so it checks again rather than sleep past that notify. While an agent ID is
  in `wait` it counts as present, and the start and the end of a `wait` count as contacts, as `claim` and `submit` do.
- The Worker passes `wait` to the Hub as an HTTP request rather than an RPC call: the request's signal fires when the
  agent's request goes away (the `enable_request_signal` compatibility flag), and the Hub then ends that wait at once.
  An RPC callee never learns that its caller has gone. The waits in flight live only in the Hub's memory.
- Each route bounds its calls to the Hub and the sessions as a whole, their start included: 30 s, and for `wait` its own
  bound plus 30 s, so 55 s at most. These are the application's budgets, not a platform limit: a Worker may take any
  time to answer a client that is still connected. When the bound passes, the route answers 503 `unavailable`, which
  `prq` and the UI take as a reason to try again, and the call keeps running; nothing orders where it lands against
  what the client does after the 503. A late submit stores its answer once, and the agent's resend gets `duplicate`. A
  claim that reaches the Hub after the 503 is a newer attempt than the agent's resend, so it can take the job under
  another `claimId`; the agent's submit then gets 409 `stale_claim`, and the agent claims again and, when that claim
  returns the same job in the same run at the same workspace, resubmits under the run its answer was produced under,
  which the server accepts only if no retry came since. The workspace counts because a resume fixes it again and the
  stored answer is labelled with it (see [Owner and jobs](#owner-and-jobs)). A late retry applies only if nothing
  changed the job after the view it came from, and otherwise gets 409 `stale_job`. A `wait` is aborted, which ends it
  in the Hub. A late `context` only reads.
  A contact the Hub could not record (see [Presence](#presence)) is not acknowledged either: the route answers 503
  `unavailable` before it calls the session, and `prq` tries again.
  The webhook route is bounded at 5 s instead, under GitHub's own limit (see [Intake](#intake)). A delivery its session
  stores after the 503 is taken in like any other, GitHub's redelivery of it is then a duplicate, and which head is
  current follows GitHub's order, not when either lands, within that order's same-second limits.
- An authentication failure (a redirect, 401 or 403) during `wait` is told apart from an ordinary timeout and ends with
  an error, so the AI notices it.
- The connection between `prq` and the Hub is an HTTP long-poll with the service token in a header.
- The local AI's procedure, `skills/prq/SKILL.md`, is one round of: `wait` → `claim` → work → `submit` → start
  `wait` again in the background. The last step is mandatory, because it is what wakes the AI for the next job. Every
  outcome of a job ends there, except exit 3, which stops the session until the host fixes the setup (see
  [Local CLI](#local-cli-prq)).

### Local CLI (`prq`)

- **Install.** `prq` is one file: `bun build --compile` makes it from `packages/cli/src/main.ts` (`pnpm run build` in
  `packages/cli` writes `packages/cli/dist/prq`; Bun's `--target` builds for another platform), and the host puts it on
  its `PATH`. The host's machine then needs neither this repository nor Node or pnpm. A release workflow that builds the
  binaries for each platform and attaches them to a release, with build provenance attestations, comes with release
  versioning (#8); until then the host builds its own. The source uses no Bun-only API, so Node 24 runs it as well
  (`node packages/cli/src/main.ts`); the unit tests run its modules there, and the end-to-end tests run the compiled
  binary. `prq --version` prints `v` + `packages/cli/package.json` `version`, and `prq --help` the usage.
- **Configuration**, only from the flags and the environment the AI session runs the commands in. No file in the
  working directory is read: the build turns off the `.env` and `bunfig.toml` a Bun-compiled binary otherwise loads
  from there, which would set variables or run code depending on where `prq` runs. Environment variables rather than a
  config file: a file would hold the same secret, readable by the same AI, and direnv or mise can scope the variables
  per directory.
  - `PRQ_URL` (required): the Worker's origin, `https:`, or `http:` only for `localhost`, `127.0.0.1` and `[::1]`, so
    the service token never crosses a network in clear text. There is no default: one would send the token to a server
    nobody named.
  - `PRQ_ACCESS_CLIENT_ID` and `PRQ_ACCESS_CLIENT_SECRET` (required): the Access service token, sent as
    `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Access turns them into the `Cf-Access-Jwt-Assertion` the
    Worker verifies. They are never written to stdout, stderr or a file.
  - The agent ID: `--agent-id`, else `PRQ_AGENT_ID`, else the host name, as `AgentId` (printable ASCII without spaces,
    at most 128 characters). An invalid one, such as a host name with other characters, asks for `--agent-id`.
  - `PRQ_HOME`: the state root (below); without it `$XDG_STATE_HOME/prq`, else `~/.local/state/prq`.
  - `PRQ_CLONE_ROOTS`: the directories that hold the host's clones as `<owner>/<repo>` or `github.com/<owner>/<repo>`,
    absolute and separated by `:`; only `checkout` reads it (see Checkout below).
  - `PRQ_VERSION_NOTICE=0` turns the version notice off (see [Versions](#versions)).
- **Output.** stdout carries one JSON line, the command's result, or nothing when the command failed (exit 1 or 3).
  Every result has `next`, the step the AI takes next, so each command restates the procedure at the moment it
  applies. stderr carries notices (the version, a retry, an ended claim) and errors, each line starting `prq:`.
- **Exit codes:** 0 done; 1 anything else; 2 `wait` timed out; 3 a setup failure only the host can fix: an
  authentication failure, no service token configured, or a configuration the command refuses (`PRQ_URL`, the agent
  ID, `PRQ_HOME`, and for `checkout` `PRQ_CLONE_ROOTS`); 4 claim mismatch, when the claim a command works under no
  longer holds (for `submit`, the answer was dropped). Exit 3 is the one the procedure stops at: restarting or waiting
  again would fail the same way, while the procedure answers exit 1 from `wait` by waiting again.

  | Command                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
  | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `prq wait [--timeout <seconds>]` (default 1500) | Polls `/cli/wait`, each poll asking for the time left up to 25 s, until it answers `ready`: `{"status":"ready","next":"claim"}`, 0. When the deadline passes after an answered poll, `{"status":"timeout","next":"wait"}`, 2; while the server was unavailable, 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
  | `prq claim`                                     | Calls `/cli/claim`. A job: saves the claim as the agent's record, then prints the server's answer with `dir` (the claim's job directory), `answer` (`<dir>/answer.md`), `saved` (whether that file exists) and `next` (`answer` when it does, else `context`), 0. No job: removes the record and prints `{"job":null,"next":"wait"}`, 0. A record of another directory that the claim replaced or removed gets a stderr line: that claim ended, and its answer must not be submitted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
  | `prq context`                                   | Reads `/cli/context` under the agent's record, from no cursor until `nextCursor` is null, and joins each message sent in parts: a part continues where the text collected so far ends, with the same whole length, and pages that do not join that way end with exit 1. Writes `context.json` (the pull request, the details, the job and the whole messages) into the claim's directory and, for an answer job, `question.md`: the text of the user message `job.target.messageId` names. Prints `dir`, `pr`, `details`, `job`, `messages` (their count), `context`, `question` (its path, or null), `answer` and `next` (`checkout` when the job has a workspace, `workspaceSha`, else `answer`), 0. When the claim no longer holds (409 `stale_claim`, 404 `unknown_job`): `{"status":"stale_claim","next":"claim"}`, 4, the record kept for the next claim to replace                                                                                                                                                                                                                                                                                                                           |
  | `prq checkout [--clone <dir>]`                  | Adds a detached worktree of the job's workspace (`workspaceSha`) at `<dir>/worktree`, from the host's clone (see Checkout below), first reading the context as `prq context` does when `context.json` is missing. Prints `path`, `sha`, `base` (the base commit, or null with a stderr notice when it could not be fetched), `clone` and `next` (`answer`), 0. A job without a workspace (a question before any push): `{"path":null,"sha":null,"base":null,"next":"answer"}`, 0, and no git runs. No clone found, a commit that cannot be fetched, git failing or not finishing in time, the worktree moved off the job's commit, or a worktree path holding what prq did not make: exit 1, the files left as they are. The claim no longer holds while it reads the context: as `prq context`, 4                                                                                                                                                                                                                                                                                                                                                                                                  |
  | `prq submit`                                    | Sends `answer.md` of the record's directory, as written, under the record's claim and run; a missing or blank answer, or one over `MAX_ANSWER_CHARS` UTF-16 code units, is exit 1 before any request. Accepted, or `duplicate` for a resend after a lost response: removes the record and prints `{"status":…,"messageId":…,"next":"wait"}`, 0. 409 `stale_claim`: claims once (as `prq claim` does, its claim becoming the record) and resubmits under the new `claimId` with the original run only when the claim returns the same job in the same run at the same `workspaceSha` (a resume fixes the workspace again, and the stored answer is labelled with it; see [Owner and jobs](#owner-and-jobs)); otherwise drops the answer and prints `{"status":"dropped","reason":…,"claim":…,"next":…}`, 4, with `reason` `workspace_moved` when only the workspace moved, else the refusal's code, and `claim` and `next` as `prq claim` gives them (`claim` null for no job). 404 `unknown_job` or 409 `target_mismatch`: dropped without a claim, the record removed. 500 or a server unavailable past the retry window: exit 1, the record and the answer kept, so a rerun sends the same answer |
  | `prq reconcile`                                 | For the start of a session. With a record, reads the first page of its context (a read; a claim would take new work): the claim holds, and `next` is `answer` when an answer is saved in its directory, else `context`; 409 `stale_claim`, and the record and its directory stay with `next` `claim`, since a late claim of the same agent replaces the `claimId` as a retry does, and the next claim tells whether it resumed the same run (same directory, its saved answer found again); 404 `unknown_job`, and the record is removed with `next` `wait`. No record: `next` `wait`, no request; an unreadable one: a stderr line and `next` `claim`. Then cleans up (see Cleanup below). Prints `claim` (the record's claim with `dir`, `answer` and `saved` as `prq claim` prints them, or null), `removed` (the paths removed), `kept` (`{agentId, dir}` for each directory another agent's record names, `{dir, reason}` for each whose worktree path holds what prq did not make, and for `jobs/` itself when it is a symlink) and `next`, 0                                                                                                                                                 |

- **Requests.** Every request is a JSON `POST` with the service token headers, no redirect followed, and a timeout. Its
  body is built through the route's `@prq/protocol` schema, so a bad local value fails before it is sent. A 2xx body
  must parse with the route's response schema; one that does not ends the command with exit 1 naming the route, and is
  never printed as a result. Any 3xx, 401 or 403 is an authentication failure: exit 3, no retry, and one stderr line
  naming it, after the version notice when the response's version differs (the Worker's 401 carries it). Access answers
  a bad service token before the Worker (a 403, or a redirect to its sign-in page), and the Worker answers 401 to a
  token it refuses. A 503, whatever its body (Access's keys unavailable, a Durable Object that did not answer, a contact
  the Hub could not record, an edge failure), a network failure and the client's timeout are retried: 503 is the
  server's one "try again", and every route is safe to send again (see
  [Notification and wait](#notification-and-wait-prq-wait)). 409 `stale_claim` and 404 `unknown_job`, and for a
  submit 409 `target_mismatch`, say the claim no longer holds, which `context` and `submit` answer with exit 4 (above).
  Any other status ends the command with exit 1.
- **Timeouts and retries.** The client waits 5 s longer than a route's bound: `ROUTE_CALL_MS` (30 s) plus 5 s for
  `claim`, `context` and `submit`, and for `wait` the wait's bound plus `ROUTE_CALL_MS` plus 5 s, from the constants
  the server's routes use (`@prq/protocol`). The route's own 503 then arrives before the client gives up, and a client
  timeout is a network or edge failure. A retry comes 1 s after a failure, doubling to 15 s, with one stderr line per
  streak of failures. A command other than `wait` starts no attempt later than 60 s after its first, whichever of its
  requests the attempt is for (a context's pages, a submit's claim and resubmit), and then ends with exit 1, within
  60 s plus one request's timeout, under the 120 s a foreground command gets by default in Claude Code; the record and
  any answer are kept, so a rerun continues. `wait` retries until its deadline.
- **Checkout.**
  - **The clone** is the first of `--clone <dir>`, the repository holding the working directory, and, for each
    `PRQ_CLONE_ROOTS` entry, `<root>/<owner>/<repo>` and `<root>/github.com/<owner>/<repo>` (directory names matched
    without case; `PRQ_CLONE_ROOTS=$(ghq root)/github.com` covers a ghq layout) that has a remote naming the job's
    repository. A remote is read by its URL as configured (`remote.<name>.url`, not rewritten by `insteadOf`):
    `https://github.com/<owner>/<repo>`, `git@github.com:<owner>/<repo>` or `ssh://git@github.com/<owner>/<repo>`, with
    or without `.git`, compared without case. `origin` when it names the repository, else the first such remote by
    name, so a fork clone whose `upstream` is the repository works. None: exit 1 naming each place tried and how to
    point prq at the clone. prq never clones: a clone of a large or private repository into a place the host did not
    choose is the host's decision.
  - **The fetch** runs only when the clone lacks the commit (`git cat-file -e`): `git fetch --no-tags
    --no-write-fetch-head --refmap= --no-prune --no-recurse-submodules --no-auto-maintenance <remote>
    pull/<n>/head`, then the same fetch by the commit's SHA (an answer's workspace may be a head that a force-push left
    behind `pull/<n>/head`). It brings objects and changes nothing else in the clone: the empty `--refmap=` keeps a
    configured refspec such as `+refs/pull/*/head:refs/remotes/origin/pr/*` from updating a remote-tracking ref, and
    the other options keep tags (`remote.<name>.tagOpt`), `FETCH_HEAD`, pruning (`fetch.prune`; with an explicit
    refspec git prunes nothing anyway), submodules (`fetch.recurseSubmodules`) and automatic maintenance (which can
    prune the host's worktree registrations) out of it. The base is fetched the same way by its SHA; one that cannot be
    is a stderr notice and `base` null, since the AI can still read the code. No ref, `HEAD` or `FETCH_HEAD` of the
    clone changes; the fetched commits stay reachable from the worktree's `HEAD`, which gc counts.
  - **The worktree.** `checkout.json` (the clone and the SHA) is written into the job directory, then `git worktree
    add --detach <dir>/worktree <sha>` runs in the clone. A rerun reuses the worktree there, with whatever the AI wrote
    in it, when it is still the recorded clone's (as Cleanup below checks) and its `HEAD` is detached at the job's
    commit; the directory's name does not keep the AI from moving `HEAD`, so a worktree moved off the commit, detached
    elsewhere or on a branch, is exit 1 naming where it is, its files left alone. Anything else at the path (a symlink,
    another repository's worktree) is exit 1 too, with nothing removed. prq writes
    nothing inside a worktree: its files (the context, the question, the answer, later the prompts and skills) live in
    the job directory beside it, so a commit that makes `.prq` a symlink out of the tree, or tracks a file prq would
    write, cannot redirect or overwrite anything, and `git status` in the tree is the commit's own. Outside the clone,
    job files stay out of the host's `git status` and IDE; one tree per claim directory keeps concurrent agents apart.
  - **git as prq runs it.** Always `git -C <clone>` on the clone it resolved, without the variables that point git at
    another repository (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
    `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_NAMESPACE` and the rest of what `git rev-parse
    --local-env-vars` lists): git sets them for a hook, so a `prq` run from inside one would otherwise act on the
    hook's repository. None of the clone's hooks runs (`core.hooksPath` names the empty `git-hooks/` of the state
    root): they are the host's tooling for its own checkouts and commits, not for a job's. The clone's config still
    applies, so filters such as Git LFS's and credential helpers work. `GIT_TERMINAL_PROMPT=0`: a missing credential
    fails instead of waiting for input the AI cannot give.
  - **Timeouts.** A fetch or a worktree add gets 25 min (it depends on the repository's size and the network; under
    the 30 min Claude Code gives a background command), a local query 60 s. Each git runs in a process group of its
    own with the programs it starts (a filter such as Git LFS's smudge, a credential helper, ssh). A git that does not
    end in time gets SIGTERM to its group, then SIGKILL 5 s later, and the command ends with exit 1. A worktree add that
    failed or did not finish is removed by its exact path, with whatever it left in the directory. Since a signal to
    `prq` does not reach a group of its own, `prq` passes SIGINT, SIGTERM or SIGHUP on to each running group as it
    came, stops the group as a timeout does (SIGKILL to what is left of it 5 s later), waits for git to exit, and then
    ends by that signal, with nothing printed; a SIGKILL to `prq` leaves its git running.
- **Cleanup**, by `reconcile` and by `checkout` before it adds a worktree, removes the job directories no record names.
  It lists `jobs/` and then reads every agent's record: a job directory is created only after the record that names it,
  so one listed first is never newer than its record. The records it reads must be those of the job directories it
  lists, so nothing is removed while `jobs/` is a symlink (a stderr line and `jobs/` in `kept`), and no command creates
  or writes a job directory through one: `claim` (`submit`'s too, when a `stale_claim` makes it claim again), `context`
  and `checkout` end with exit 1 before any request, saving nothing. A `jobs/` leading to another state root's would let
  this root's cleanup remove the directories, answers and worktrees of the agents whose records are there, and that
  root's cleanup remove this root's. Each entry no record names is removed unless
  it holds the working directory: a symlink is unlinked, never followed; a job directory's worktree is removed from the
  clone its `checkout.json` names by its exact path (`git -C <clone> worktree remove --force --force <dir>/worktree`,
  which also removes one whose directory is gone, or one a stopped add left locked), then the directory. The worktree is
  removed only when it is that clone's: `<dir>/worktree` is not a symlink (never followed), the clone registers exactly
  that path, and the directory's git uses the clone's common git directory (`git rev-parse --git-common-dir`), so a
  symlink to a host worktree, or another repository's worktree at a path prq's used to have, is never touched. Such a
  directory is kept, with a stderr line and an entry in `reconcile`'s `kept` giving the reason. An entry whose name is
  not a job directory's is left alone. Never `git worktree prune`: it would also drop the host's registrations of
  worktrees that are only unreachable, such as one on an unmounted volume. A worktree that cannot be removed keeps its
  directory the same way, and an unreadable record (it may name any directory) stops all removal until it is replaced.
  What stays is one directory per agent ID with a record; a record left by an agent ID that never runs again keeps its
  directory until the host deletes the record, and `reconcile` lists other agents' directories under `kept`. Another
  agent's claim is never probed: a context under its ID would count as its contact (see [Presence](#presence)).
- **Local state**, under the state root:

  ```
  agents/<sha256(agentId) hex>.json         the agent's current claim: {agentId, claim, savedAt}
  jobs/<jobId>-r<run>-<workspaceSha|none>/  one claim's work: its job, run and workspace
    context.json  question.md               written by prq context (question.md for an answer job)
    answer.md                               written by the AI, read by prq submit
    checkout.json                           written by prq checkout before it adds the worktree: {clone, sha}
    worktree/                               the git worktree; prq writes nothing inside it
  git-hooks/                                empty: the hooks directory of every git call prq makes
  ```

  The record is the one place a `claimId` lives between processes, one per agent ID, since an agent ID is one AI
  session working one job at a time. `claim` writes it through a temporary file and a rename, so a reader sees the old
  record or the new one, and creates the job directory only after the record that names it. The file name is a hash:
  agent IDs are case-sensitive while macOS file systems usually are not, and an ID can contain `/`. A claim that resumes
  the same job, run and workspace names the same directory, so an answer saved there before a restart is found again; a
  retry or a moved workspace names another, so an answer written under the earlier claim stays apart from the new one.
  `submit` reads the answer only from the record's directory, so an answer is bound to its run and workspace by where
  it is: it is never sent under a later run or labelled with a later workspace, even when the AI runs `prq claim` in
  the middle of a job. The record, `context.json` and `question.md` are written through a temporary file and a rename,
  so a reader sees a whole file. The state moves as a whole, by pointing `PRQ_HOME` elsewhere: the records and the job
  directories they name stay under one root, which Cleanup relies on.

### Versions

- The Worker and the web UI it serves are deployed together and share one version, `vX.Y.Z`; the UI shows it next to
  the product name. The CLI carries the version it was built with. How releases set the version is decided with the
  deploy setup.
- Every `/cli/*` response, including errors and `wait` timeouts, carries the server's version in a `Prq-Version`
  header (named in `@prq/protocol`); response bodies do not change. Every `prq` command that calls `/cli/*` compares
  it with its own version as plain strings, so a pre-release or build differs from the release. On a mismatch it
  writes one line to stderr, once per invocation however often `wait` reconnects, naming both versions (for example
  "prq v0.3.0 talks to a v0.4.0 server; update prq if a command fails"). It is a notice, not an error: stdout and the
  exit code stay the same. A response without the header (a failure before the Worker, such as at Access) is not
  compared. Setting `PRQ_VERSION_NOTICE=0` turns the notice off.
- The web UI learns the server's version from a message the server sends on every WebSocket connection to the Hub and
  to a PrSession, since a browser cannot read WebSocket response headers:
  `{ "type": "prq:version", "version": "vX.Y.Z" }` (`ServerVersionMessage` in `@prq/protocol`). It follows the Agents
  SDK's own frames, so the UI picks it out by its type. The UI compares it with its own build version the same way and
  shows the reload notice described in [Caching](#caching).

### Presence

- Registering in the pool is the `prq` connection itself, and presence is kept per agent ID. There is no registration
  command.
- An agent ID counts as present while it is in `wait`, and while it holds an unfinished claim (up to 60 minutes after
  the claim). Presence ends 10 minutes after neither applies, so a long analysis does not make presence lapse and send
  new PRs to cloud. Exactly: an agent ID is present while it is in `wait`, or less than 10 minutes after its last
  contact (the start and the end of a `wait`, a `claim`, a `submit`, a `context`), or while it holds a claim made less
  than 70 minutes ago (60 minutes of the claim, then the 10-minute tail).
- The Hub learns the claims from the [PR ledger](#pr-ledger) entries. Each entry gives a claim's age by its session's
  clock, and the Hub places the claim on its own clock by that age, so no time from one object's clock is compared
  with another's. When an entry no longer lists a claim (a submit or a retry ended it), the Hub counts the agent as
  seen when the claim stopped applying: at that moment, or 60 minutes after the claim if that came first. Presence
  then ends 10 minutes later, and a claim retried after 60 minutes does not make its agent present again.
- When any one agent ID is present, "a local agent is present" is true.
- The Hub's view carries whether a local agent is present and how many agent IDs are, which the header's status shows.
  The pool's details come from `GET /api/agents`, read when the pool opens: every present agent ID by ID, at most 100
  and 64 KiB a page, with its last contact (none when the Hub has had none from it), whether it is in a `wait` and
  whether it holds a claim. They are not in the view, so a contact sends the UI nothing. A contact and a pool page read
  only what can make an agent present: the contacts and the claims recent enough, each a range of an index on its time,
  and the waits in memory, then for each present agent its last contact and its latest claim, one row each however many
  claims it has held. An agent's row stays after its presence ends (one row an agent ID, which is the host name by
  default), and is read again only once the agent is present again.
- The Hub runs `presenceEnded` at the first whole second at or after the next time a present agent's presence ends
  (re-checked when it runs, since the scheduler stores whole seconds), so the list and "Waiting for a local agent"
  follow presence without any other event. Every change to the pool or the ledger, and the Hub's start, arms it when
  no run is due by then, and only then sets the Hub's view, so the view never shows a presence that nothing is armed to
  end. A contact whose run cannot be armed (or whose view cannot be set) fails, and its route answers 503; a lost run
  is armed again at the next contact or the Hub's next start.

### PR ledger

The Hub's entry per PR is what the list shows without asking each PrSession. PrSession sends the entry's fields to the
Hub whenever a push arrives, a question is saved, one of its jobs changes state, or a claim reaches 60 minutes (an
alarm set at the claim). The Hub adds only what it owns itself: whether a local agent is present.

- **Delivery:** an entry goes through the session's outbox like a notify. The step that changes the entry writes the
  outbox row `ledger` with the next generation of the session's counter, and that generation is the entry's
  revision; the entry is built from the session as it is when the row is read, in the same step. The Hub stores an
  entry only when its revision is newer than the stored one, decided in the statement that stores it, so an older
  entry that lands late (an overlapping or retried delivery) changes nothing and is logged; one at the stored
  revision is a redelivery. A failed delivery keeps the row for a retry, and a row written again during a delivery
  stays for the next one, so the newest entry reaches the Hub. A claim and a submit arm the wake before their change,
  so a session that stops before delivering delivers when its wake runs.
- **Latest event:** a push received, a question sent, a summary completed or an answer completed, with its time. Rows
  are ordered by it. Claims, heartbeats and streaming are not events. A push is an event when it changes the head
  (the first push, or a newer head); a push of the current head, or an edit or a close, is not. A question's event is
  when it gets its job. The time is the session's when it took the event in; rows are ordered newest first, rows
  without an event last.
- **Problem:** at most one label, the first that applies in this order:
  1. _Summary failed_ — the analysis of the current head failed and it has no completed analysis. Clears when one
     completes. Only the current head's analysis counts: an older head's analysis, failed and then superseded or left
     behind by a push, is no longer the PR's problem, and the current head's completed summary clears the label
     whatever became of it. A job's failure stays from the statement that fails it to the statement that completes it,
     whatever happens between: a retry does not clear it, so the label stays until the retried analysis completes. The
     label follows the current head: an older head's failed analysis stops counting when a push moves the head, and
     counts again if a push returns to its head before it completes (its retry while the head was older superseded it,
     and the push revives it).
  2. _Answer failed_ — a question's latest job failed. Clears when a retry of it completes (the failure stays through
     the retry).
  3. _Possibly stalled_ — a claimed job has no result 60 minutes after its claim. Clears when the job completes, fails
     or is retried. Every claim and resume schedules `claimAged` at the first whole second at or after 60 minutes after
     the claim; when it runs it checks the claim again: before the deadline it schedules itself for it, and for a claim
     that has ended it changes nothing. The session view marks the job `stalled` as well. A claim past its deadline
     whose check was lost (a stop before it was scheduled, a failed schedule) is found by the session's next `settle`,
     which sends its entry. Each claim's stall is recorded when its entry is written, so it is sent once: neither a
     later `settle` nor the check sends it again.
  4. _Waiting for a local agent_ — a `local` session has waiting work (sent by PrSession) and no local agent is
     present (known to the Hub). Clears when an agent is present again.
  5. _New push not summarized_ — the current head has no completed analysis. It is derived from the current head, not
     from the latest completed summary, so a completed analysis of an older head does not clear it and a push back to
     an analyzed head does not set it.
     "Needs attention" counts the PRs whose problem is one of the first four.
- **The view:** the Hub's Agent state (`HubView` in `@prq/protocol`), which only the server sets, which has the same
  size whatever the number of PRs and agents, and which is broadcast only when it changed: whether a local agent is
  present and how many agent IDs are, the jobs of every PR (waiting, running, and failed: an unresolved failure as the
  labels count one, so a retried job counts as failed until it completes, and an older head's analysis does not count),
  the "Needs attention" count, how many owners the PRs' repositories have, and the ledger's version (advanced by every
  entry the Hub stores). A contact alone changes none of it. The Hub keeps each count as it stores each entry, in the
  step that stores it, from what the entry changes (for "Needs attention", whether the row needs it with an agent
  present and without one), so no count reads every row.
- **The rows:** the UI reads the rows (`LedgerRow`: details, owner, latest event, problem, its jobs and up to 8 of the
  claims held in it) a page at a time from `GET /api/ledger`, behind Access and bounded like every route. A page holds
  at most 500 rows and 256 KiB, in the list's order: latest event first, rows without one last, then the session name
  descending. Its cursor names the last row's place in that order, and the next page starts after that place however
  rows change meanwhile, so no row that kept its place is listed twice or left out. A row that a newer event moves
  ahead of the cursor is left out of the pass under way, which the changed version tells: the UI reads the pages again
  when the version or presence changes (a row's problem depends on presence).
- **Filters:** the list's filters are the page's: `state=open` (the default: open PRs, and those whose state no webhook
  has given yet) or `all`, combined with `repo=owner/name` (any case) or not. "Needs attention" is its own list,
  `attention=1`: the rows whose problem needs attention as presence is when the page is read, in every state and
  repository, which are the rows the count counts. It takes neither `state` nor `repo`, and a query with either is
  refused (400) rather than read without a bound: a narrower list would no longer be the one the count counts. The
  cursor keeps its meaning under each filter. Each of the six lists (`open` and `all`, each with `repo` and without;
  attention with a local agent present and without one) has an index that holds only its rows, in the list's order, and
  the query names it (`INDEXED BY`), so a page is one range of that index and reads no row it leaves out, whatever plan
  the runtime's SQLite would choose. One index a list is the fewest, since an index serves a list only by holding its
  rows alone in the list's order, and no two lists keep the same rows. Four are partial, so a row is in two of them (the
  whole list, its repository) and in two more while open and one or two more while it needs attention.
- **Repositories:** the menu reads the repositories with rows a page at a time from `GET /api/repos` (by owner/name,
  at most 200 and 64 KiB a page), in GitHub's display case once an entry has given it. A page rather than the view: the
  repositories have no bound, the menu needs every one of them, and it is read only when it opens, so the view stays
  the same size and a new repository does not change it. The view's owner count says whether a row can name its
  repository without the owner.

### Instructions and skills

How a summary or an answer should read is the host's decision, written as instructions. The core holds the mechanism
and no judgment: there is no stage in the pipeline that "polishes" or translates text.

- **Two free-form prompts**, edited in settings: one for analysis (the summaries) and one for answers. An example is
  "Write in Japanese. Polish the final text with the yomiyasu skill." A prompt is plain text; the core does not parse it.
- **Skills in the Agent Skills format.** A skill is a directory with a `SKILL.md` (frontmatter with `name` and
  `description`) and optional `references/` and `scripts/`. The host registers a skill by the GitHub link to its
  `SKILL.md` (`/blob/<ref>/<path>/SKILL.md`), which names the repository, ref and path. The ref is a commit SHA (a
  permalink) or a branch or tag, which may contain `/`: the segments after `blob/` are split at the longest prefix that
  names a branch or tag, or at the first segment when it is a commit SHA (as GitHub does). The preview shows the
  resolved ref and path, so a wrong split is seen before confirming. The system resolves the ref to a commit SHA and
  pins the skill to it; a permalink is already pinned, and updating it means pasting a new link.
  Registering and updating take two steps: a preview resolves the ref and fetches the skill without saving it, so the
  host sees what would be pinned (see [ui.md](ui.md#4-settings)), and confirming pins the previewed SHA without
  resolving the ref again. The Hub stores the registration and the pinned contents. A skill is only re-read from GitHub
  when the host updates it to a new ref. An example is `skills/yomiyasu` of `nanaism/yomiyasu` (MIT).
- **Context budget.** Only each skill's `name` and `description` stay in the model context. The body and the files it
  refers to are loaded on demand through two tools: `activate_skill(name)` returns the `SKILL.md` body, and
  `read_skill_resource(name, path)` returns a file inside that skill's directory (path-checked, so it cannot leave it).
  Injecting every `SKILL.md` body into every turn was rejected because the cost grows with the number of skills,
  whether or not they are used.
- **When a skill is used is the model's decision**, made from the descriptions and the two prompts. The core has no
  dedicated step for any skill.
- **Scripts run in the cloud workspace.** A skill's script runs in the workspace container (its image includes `python3`) and only
  as far as the skill's `allowed-tools` frontmatter permits. In the Agent Skills format `allowed-tools` lists
  pre-approved tools, and prq has no interactive approval step, so a skill that declares none cannot run scripts: it
  contributes instructions and references only. The pinned SHA means a skill's code does not change under the host.
- **Local runner.** `prq context` returns the two prompts and materializes the registered skills into the job's
  directory beside its worktree (for example `skills/<name>/`), so the local AI reads them as files. Never inside the
  worktree: a commit controls every path in its tree (see Checkout in [Local CLI](#local-cli-prq)), and the files do
  not depend on whether `checkout` ran first. It reads the conversation page by page, following `nextCursor`, joins a
  message sent in parts, finds an answer's question there by the message ID its job names (see
  [Owner and jobs](#owner-and-jobs)), and writes the context and the question into the job's directory (see
  [Local CLI](#local-cli-prq)). A local agent may also use skills it already has on its own machine.

What is left out on purpose:

- **No output-language setting.** Language is part of the prompts, not a field the core interprets. A setting would
  force the core to know where it applies (summary, answer, notes, UI) and would still not express other style needs.
- **No per-repository or per-PR prompt overrides.** There is one host and one scope. They are added if the single
  scope proves too coarse.
- **No skill marketplace or discovery.** The host registers a URL it already knows.
- **No arbitrary code hooks** beyond skill scripts in the workspace.

### Model context

The full conversation (PrSession's UIMessages) is never trimmed. Only the context passed to the model is assembled, for
each job before its model call, as: the analysis notes + the projection after the cut point + the job's own question,
or an analysis's task.

- **The projection.** The results stored so far in storage order, which is commit order (every result is appended at
  its job's end), each answer preceded by its question wherever that question is stored. Incomplete texts are left
  out, and so is every question without a stored answer (waiting, running or failed). A question therefore enters
  together with its answer, the results of jobs that ran before this one are kept wherever they were stored, and the
  projection only grows at its end. It is read from storage, root to leaf, never from the history the SDK keeps in
  memory (`this.messages`), which holds only the most recent part within `hydrationByteBudget`: an older result would
  otherwise drop out of a long conversation's context unseen. The stored messages up to the question's position were
  the alternative; they drop the results committed after the question was stored and keep earlier open questions.
- **The job's own part.** An answer's question is read by the job's target, never as the last user message. An
  analysis gets the task "Summarize the pull request at head `<sha>`.", which is not stored. Before them comes the
  system prompt: the pull request, its details (or that no webhook has arrived), and the job (the head an analysis
  summarizes, or the commit an answer is about, or that no push has been seen yet).

Compaction follows the approach of Pi (`pi-coding-agent`, MIT license). The prompts and procedure that are copied keep
Pi's copyright notice (`pr-session/compaction.ts`). Its input is the projection: a question still waiting for its job is
never summarized, and once answered it enters the kept part with its answer, wherever it was stored.

- **Trigger.** When the context exceeds the model's context length minus a reserve, the system shall compact. It checks
  after an answer has been committed (after the turn) and compacts then, before the next job is handed over; one
  compaction took 14 to 23 seconds in the prototype. While it runs, the cloud seam, which every hand-over of a waiting
  job goes through (a question, a push, a retry, settle, a commit), starts no job, so a job that arrives meanwhile waits
  and reads the compacted context (recovery and a refusal's re-run give the running job a new turn and start no other);
  the compaction's end, however it ended, opens the seam. At a turn's start, a context already over is compacted first
  (a compaction a restart lost, or one a refusal asked for), unless a compaction failed at the same end of the
  projection: that one is not repeated until a new result is committed. A request the provider refuses for the context's
  length (the `context_length_exceeded` code, or a message about a request over the window, also after a retry) counts
  the context as the whole window: the job is compacted and run again once per run, and a second refusal fails it with
  the provider's reason.
- **Parameters.** At windows of 131,072 tokens or more, the reserve, the kept part and the notes' output limit are Pi's
  defaults (16,384, 20,000 and 8,192 tokens); below, they are shares of the window (one eighth, three tenths, one
  fifth), so none exceeds it. That does not make a summary request fit the window: the count that triggers compaction
  is the provider's, the kept part is an estimate, and a window can be made smaller. Each summary request is sized
  instead (see Failure below).
- **Token count.** The usage that the provider returned for the previous response is the main source, and only messages
  added since then are estimated. The estimate is characters ÷ 3, or a ratio measured in the session. Characters ÷ 4
  under-counted Japanese text and diffs by 1.3 to 1.7 times. The measurement is the last committed turn's last model
  call (its input and output), kept with the result it ended with and the notes revision its context was built on; it
  counts only while the notes are at that revision, so after a compaction the count is the estimate of the new context
  (the notes, the kept part and what came after) until a model call measures it.
- **Tools.** A job with a workspace commit reads the code through four tools, each a git command at that commit, so a
  path resolves in the commit's tree only and a symlink is its link text, never followed: `list_files` (the paths, all
  or under a path), `read_file` (a file with line numbers), `grep` (an extended regular expression, each match as
  `path:line:text`) and `diff` (the change from the merge base: the changed files with their line counts, or one file's
  patch; when the history does not reach the merge base, the two tips, and the result says so). What a tool takes from
  the model follows `--end-of-options` or `--`, so it is never read as an option. A failure (a missing path, a bad
  pattern, a workspace that did not answer) comes back to the model as `error: …` text, and the turn goes on. A question
  asked before any push has no workspace commit and gets no tools.
- **Pages.** A tool result is at most 12,000 characters. A longer output comes in pages, and a note at the end of a
  page says where the next one starts: a line, and a character inside a line longer than a page, so any part of a
  large file or of a minified line can be reached. The output before a page is read and dropped as it streams, never
  kept.
- **Overrun inside one turn.** Compaction between turns cannot prevent it, so a turn measures the room it has left: the
  model's window, less the reserve, less the newest request the provider measured (its input and output tokens), less
  characters ÷ 3 of what was added after it (the tool results taken since). Before the turn's first response, its
  request is the context count (see Token count below): the same measure compaction is triggered by, so a turn under
  the limit is offered its tools. Only without a measurement is the whole request estimated; its characters ÷ 3 ran
  well above the provider's count of the same context. The newest measurement already holds every earlier step, so a
  long turn is never charged twice for what it read. Each tool result, an `error: …` text included, is cut to the room
  left, in the order results complete; when less room is left than one result needs, the next model call is offered no
  tools and the agent answers from what it has read. Under `toolChoice: "none"`, which would have kept the tool
  definitions in the cached prefix, DeepSeek wrote its tool call as the answer's text. Offered no tools, it still did
  after a dozen tool calls in one analysis at a 20,000-token window; a system line saying the tools were gone did not
  stop it, and its answers then told later turns so, which stopped calling the tools they were offered. At the
  production window tools are withdrawn only after about a million tokens in one turn, so this is a known limit of
  small windows, not a failure path. A measurement taken on a call offered no
  tools lacks the tool definitions (about 850 tokens for the four), so the next turn's first request can run that much
  over the count; the reserve holds it. A turn has no step limit: it goes on while the model calls tools (see
  [Billing limits](#billing-limits)).
- **Cut point.** Going back from the newest message, the system keeps the most recent part (Pi's default: 20,000
  tokens). The cut falls at a question, at an analysis's first step (an analysis stores no request), or at a step
  boundary inside a result; a tool call and its result are one part of a step, so they are never separated. If the cut
  falls inside a turn, the first half of that turn is summarized separately; this step is required, because it happens
  every time when the amount kept is smaller than one turn. While later cuts stay inside the same turn, the steps each
  one removes update that turn's summary, not the history's; it folds into the history's summary once a cut leaves the
  turn. The cut never moves back: the next one starts from it, and the projection only grows at its end.
- **Analysis notes.** Everything before the cut point is summarized into fixed sections. If notes already exist, they are
  updated, not rewritten: keep, add, and drop what became stale. Pi's Goal / Constraints / Progress / Key Decisions /
  Next Steps / Critical Context become, for PRs: purpose, overview of the change, decisions, the user's interests and
  preferences, open questions, key facts. Six sections were enough in the prototype. File paths and function names stay
  verbatim, and a list of the files that were read is appended.
- **How to write the notes.** "Decisions" uses the user's own words and gives a reason only if the user gave one. "The
  user's interests and preferences" lists only what the user said; left alone, the model adds guesses.
- **Size.** The notes have no size limit. In the prototype they grew from 3,560 to 13,406 characters, but that was with a
  20k-token context window compacted six times in 16 turns. Two things follow, and they are different claims. The
  displayed history is never lost: a summary that stopped at the output limit is not adopted, and the full history is
  never changed. Whether the model can keep answering well depends on the notes fitting the real context window. That
  holds for the expected use (a conversation about one PR, a few compactions at real window sizes), and it is checked on
  real PRs after deployment, looking at answer quality after compaction.
- **Reasoning.** When a turn ends, the model's reasoning is removed from the context.
- **Storage and insertion.** PrSession stores the notes apart from the history (`prq_notes`): the history's summary,
  the summary of a turn the cut falls inside, the notes assembled from them, the target SHA, a revision, the cut (the
  message and the step within it) and the files read. Notes are adopted only at the revision they
  were built from, so a compaction that another one overtook is discarded. The model receives them, after the system
  prompt, as a message that says the conversation before this point was compacted into the following summary (Pi's
  notice), then the projection's kept part (a split turn's kept steps as a partial assistant message), then the job's
  own question or task. The full history is not changed: no Sessions overlay is stored (see
  [decisions.md](decisions.md)).
- **Failure.** A summary that stalled, errored, ended other than `stop` (its output limit included) or is empty once
  what prq generated is removed is not adopted. prq recognizes its own text by its exact rendering at the reply's
  edges, peeled until none is left: a tag it wraps the notes or a request's parts in (`summary`, `previous-summary`,
  `conversation`) around the whole reply, and at its end a file list exactly as prq renders it from the previous
  notes' files or the new ones; the notes are assembled with the same recognition. Anything else is the summary's own,
  a tag it names or a list it gives as an example included. Each summary request, estimated as a turn's are
  (characters ÷ 3) with the notes' output limit added, fits the window: a part too large for one request is summarized
  in batches, oldest first, each updating the summary of the ones before, and a step too large for a request alone
  fails the compaction rather than being cut, which would leave its end in neither the notes nor the kept part. So a
  session whose window was lowered below one of its steps cannot compact, and its next job over the window fails with
  the provider's reason. The notes and the cut are adopted only once every batch has succeeded. Each batch is one
  streamed call under the same bounds as a turn's model requests (see [Billing limits](#billing-limits)) and the
  notes' output limit, and it is tried once more, so the gate's longest hold grows with the batches: when the provider
  stops sending, each attempt ends within 120 s of its last output, at most two attempts per batch, and a provider
  still streaming is not cut, as for a turn. A provider that counts the request higher than the estimate may still
  refuse it; that attempt fails like any other. When compaction fails, the stored notes and history stay as they were,
  and the next job runs on the full context.
- Everything before the cut point is in the notes, so no message leaves the context without being reflected in them.
- The notes are language-neutral: the compaction prompt does not ask for a particular language, and the prompts for
  analysis and answers decide how the final text reads.
- Notes come from compaction, which runs on the cloud model inside cloud turns, so a local session has none: a local
  agent reads the whole conversation through `prq context` and manages its own window.

Adoption test: for the largest PR the system is meant to handle (a large diff plus search results), the model still
answers what was decided earlier after compaction. See [spikes.md](spikes.md) for how the prototype met it.

### Workspace (cloud)

- **One Workspace per PrSession.** A Durable Object (`Workspace`, named as its session) drives its own container
  (`basic`, image from `packages/server/Dockerfile`: Alpine pinned by digest, `git`, `ca-certificates`, `python3`). The
  container stops after 30 minutes without a request, and a stopped container loses its disk. `/agents/workspace/…` is
  not served: only the session reaches it.
- **Prepare.** A job's checkout is made at its workspace commit: `git init`, `fetch --depth=1 --no-tags` of the commit
  and its base by SHA, `checkout --detach` of the commit, then deepen (doubling, at most 8 rounds) until `merge-base`
  answers. A `HEAD` that is not the commit fails the prepare. The steps are data (argv lists in
  `packages/server/src/workspace-git.ts`), so the Workspace runs them in the container and a Node test runs them with
  real git. A prepare ends after 30 minutes, and a fetch that moves under 1,000 bytes/s for 60 s ends sooner.
- **Reuse only through a ready record.** A checkout is reused only when the Workspace's stored ready record names the
  commit and the record's random token is in `.git/prq-ready` in the checkout (a stopped container loses the file).
  The record is written last, after the token file, once everything above completed; it is cleared before any change.
  A ready checkout of another commit keeps its objects and fetches what is missing. Anything else is wiped and rebuilt
  from empty. Reusing a checkout whose `HEAD` is at the commit was rejected: a prepare cut during a deepen leaves
  `.git/shallow.lock` and a partial `shallow` file with `HEAD` already there, and the next fetch fails on the lock.
- **Commands.** Each tool call is one git command in the checkout. Its output is read as it streams: what comes before
  the requested page is only counted, the page collects at most 4 bytes per character a result may hold (48,000), and
  then the process is killed. A command ends after 60 s. Output never crosses RPC uncapped.
- **A container lost mid-turn.** Every call names its commit, and when the container is not running or the checkout is
  not ready for that commit, the call prepares the same commit first. When that fails, the turn ends and the job fails
  `workspace: lost and could not be rebuilt: <reason>`, which the host can retry, rather than handing the model an
  error it cannot act on.
- **One rebuild at a time, owned by the Workspace.** Every call carries its turn's sequence number
  (`prq_session.turn_seq`, advanced at each start). The Workspace stores the newest sequence it has seen and the
  highest released one, so a reset forgets neither. A call acts only while its sequence is the newest and not released,
  checked again after every await and before every container operation; an older turn's call is refused and touches
  nothing. Calls of one turn for one commit share the prepare in flight. A newer turn aborts an older turn's prepare
  and waits for it to settle; it never waits out the older one's bounds. When a turn ends, the session sends
  `release` (waited for at most 10 s, after the commit), which aborts only a prepare of that turn or an older one.
- **After a reset.** The new instance's constructor starts one cleanup, and every container operation waits for it:
  the old instance's prepare may still run. A container not running, or a `pkill -KILL -x` of every process the
  Workspace starts (git and its helpers, `rm`, `cat`, and the `sh` that writes the ready token; never the image's own
  process) answering within 10 s, ends it. Otherwise the container is stopped and confirmed stopped within 30 s; when
  that is not confirmed either, every call fails `workspace: could not clean up after a restart: <reason>` until a
  newer turn tries again.
- **Setup per instance.** A running container does not show that it was set up: a prepare cut short after `start()`
  (an abort, a failed call, a reset) leaves it without its interception or idle stop. Each instance therefore sets up
  the running container before its first command, and again after a setup that did not complete or for another
  installation. Each call sets a rule or a timeout, so a repeated setup replaces what an earlier one left.
- **Egress.** The container has no internet. Every HTTP and HTTPS request it makes is intercepted and sent to
  `GitEgress` (`packages/server/src/egress.ts`), which lets through only the two requests of a git fetch from
  `github.com` (`GET …/info/refs?service=git-upload-pack` and `POST …/git-upload-pack`). It replaces any credentials
  the container sent with the installation token and hands a redirect back to git instead of following it.
  Everything else gets 403 and reaches no upstream (`prq.egress.denied`); a token that cannot be had gets 502. Which
  repositories are reachable follows from the installation token's scope, so there is no per-repository allow list.
  The token never enters the container. A job whose session knows no installation (no webhook carried one) fails
  `workspace: …` before the container starts.
- The image includes `python3` for skill scripts (see [Instructions and skills](#instructions-and-skills)). Scripts get
  no network beyond the same restriction.
- This restriction applies only to traffic from inside the container. LLM calls and external tools (web search, for
  example) are made by PrSession on the Worker side and are not restricted by it. If tests are run in the container
  later, the destinations they need (an npm registry, for example) are added then.
- **Tests and the owner's check.** Tests run with containers off (`dev.enable_containers: false` in `wrangler.jsonc`,
  which the CLI's wrangler test harness reads too), so CI needs no Docker; the Workspace's tests drive a fake container.
  `pnpm run check:workspace` in `packages/cli` runs the real container in wrangler's local runtime (see
  [AGENTS.md](../AGENTS.md)).

### Caching

All data is private to the host and changes live, so prq caches only what is immutable or identified by a commit, and
nothing in between is shared. Application data that can be cached is keyed by something that cannot change (a content
hash, a commit SHA); everything else is read fresh.

Browser and edge:

- Built assets (scripts, styles, fonts) have content-hashed names and are served with
  `Cache-Control: public, max-age=31536000, immutable`. The HTML shell (`/`, `/index.html` and every UI route that falls
  back to it) is served with `no-cache`, so the next load after a deploy fetches the new bundle.
- Every response the Worker generates is `Cache-Control: no-store`, errors included: `/api/*`, `/cli/*` and the Agents
  SDK's HTTP endpoints under `/agents/*` (the conversation history the UI fetches when it opens a PR). The Cloudflare
  cache and the Cache API are not used for them: every response is private and behind Access.
- The UI keeps no data cache. It loads a PR's history over HTTP when it opens it; after that, conversation, jobs and the
  Hub's view come over the Agents SDK WebSocket, which resyncs the state after each successful reconnect. The ledger's
  rows come over HTTP in pages, read again when the Hub's view says the ledger or presence changed, and so do the
  present agents and the repositories, read when the pool or the repository menu opens. There is no
  service worker and no offline mode. Browser storage holds only view preferences (the rail collapsed, the list
  filters).
- When reconnecting keeps failing (an expired Access session fails every attempt, and a WebSocket cannot follow the
  sign-in redirect), the UI offers to reload the page, which lets Access sign in again.
- A tab opened before a deploy keeps running the old bundle. The server sends its version on every WebSocket connection
  (see [Versions](#versions)); when it differs from the UI's build version, or a lazily loaded asset fails to load, the
  UI shows a non-blocking notice to reload.

Server:

- **Per commit, stored once.** A completed analysis is stored per head SHA and not run again for that SHA (see
  [Intake](#intake)); a failed one stays retryable (see [Owner and jobs](#owner-and-jobs)). A pinned skill's contents
  are stored per commit SHA (see [Instructions and skills](#instructions-and-skills)). Both are immutable, so they need
  no invalidation.
- **Derived views.** The Hub's ledger is a copy that PrSession pushes on every change (see [PR ledger](#pr-ledger)), not
  a cache with a lifetime.
- **Credentials.** A GitHub installation token is reused until shortly before it expires (it lasts an hour), through
  `@octokit/auth-app`'s own cache. Access's signing keys are cached by `jose`'s remote key set, which refetches an unknown
  key ID subject to its defaults (30-second cooldown, 10-minute maximum age). Both caches belong to auth objects created
  once per isolate and reused across requests; they are lost when the isolate is evicted, which only costs a refetch.
- **Model prompt cache.** Providers may cache a repeated prompt prefix; it is best effort. The model context puts what
  changes least first — system prompt, the host's prompt, the tool definitions and the skill list (sorted by name), the
  analysis notes — and appends messages and tool results (including skill activations) after it, keeping earlier steps
  as they were. A prefix still misses after a prompt or skill edit, a switch between the analysis and answer prompts,
  the removal of reasoning at the end of a turn, a compaction, or the provider's eviction. Savings are judged from the
  provider's reported cache hits, not assumed.
- **Workspace.** A container starts from empty each time (see [Workspace (cloud)](#workspace-cloud)); a checkout cache
  (snapshots or a backup) is added only if the start time turns out too slow.

### Authentication boundary

- There are two Access applications. `/webhook` bypasses Access. The rest of the host is allowed for the host's email
  (browser) or a service token (`prq`). Agents SDK's WebSocket path (`/agents/:binding/:name`) is inside the protection.
- On every protected path the Worker verifies `Cf-Access-Jwt-Assertion` with `jose`: an RS256 signature from the team's
  key set, the audience, a fixed issuer (the team's domain) and an expiry, which the token must carry. A caller that
  passes Access is treated as the host; the host and the service token are not told apart per path. The verification
  stays so that a request reaching the Worker without passing Access (through a `workers.dev` address, for example) is
  refused with 401.
- The team domain and the application's audience are secrets. When either is missing or malformed, the Worker shall
  refuse every protected request with 500 instead of verifying with a check left out (`jose` skips the audience check
  when it is given none).
- When the key set cannot be fetched or used (a network error, a timeout, an answer that is not a key set, a key that is
  malformed or cannot be imported), the Worker shall answer 503, not 401, so that `prq` does not read it as an
  authentication failure; the next request fetches again. A token naming a key the set does not hold is a 401.
- When a webhook arrives, the system shall accept it only if `X-Hub-Signature-256` is `sha256=` and the HMAC-SHA256 of
  the raw body under the webhook secret (compared in constant time), the event is `pull_request`, and
  `pull_request.user.id` is the host's. `sender` is whoever made the update, not necessarily the PR author. A delivery
  that is refused (401 for the signature, 400 for a payload outside GitHub's shape, with details longer than
  `PrDetails` allows, or without `X-GitHub-Delivery`) or ignored (another event, author or action; 200) reaches no
  PrSession. When the webhook secret or the host's ID is missing or malformed, the Worker shall refuse every delivery
  with 500; the Access check needs neither.
- The GitHub App's ID and private key (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) are secrets, both or neither. With
  neither, the Worker makes no GitHub API call (no head reconciliation); with one, or a malformed one, it logs
  `prq.config.invalid` naming the variable and makes none either. The private key is stored as PKCS#8: GitHub issues
  PKCS#1, which the WebCrypto-based path in workerd cannot read, so convert it once with `openssl pkcs8 -topk8` before
  storing it. `pnpm run check:github` in `packages/server` mints an installation token and reads a pull request with
  it; `pnpm run check:reconcile` in `packages/cli` does the same through the Worker in wrangler's local runtime, after
  two signed deliveries of that pull request tie within one second. Neither prints the key, a JWT or a token.

### Observability

- Workers observability (logs) is enabled. Webhook receipt, job state changes, head reconciliation's reads
  (`prq.head.*`), LLM and tool errors, and compactions are logged with the PR key and `jobId`. A claim that reaches 60
  minutes is logged (`prq.job.stalled`), and so is a ledger entry the Hub refuses as older than the one it has
  (`prq.ledger.stale_rev`).
- The Workspace logs each prepare with its commit, whether it reused, updated or rebuilt the checkout, and its time
  (`prq.workspace.prepared`), a prepare that failed (`prepare_failed`), a cleanup after a reset that failed
  (`cleanup_failed`), and a release the session could not deliver (`release_failed`). The egress logs each request it
  refused with its host, method and path, never the query or a header (`prq.egress.denied`), and a token it could not
  get (`prq.egress.token_failed`).
- When a cloud job's run ends (`done` or `failed`), `prq.job.usage` logs the PR key, `jobId`, kind, run, outcome, the
  model, the steps (model calls), the input, output and cached input tokens, the time from the run's first start to its
  end (`wallMs`, on the session's clock), its starts, and whether it was run again after a context-length refusal
  (`overflowRerun`). Each finished step is added to the run's row as it ends, so the numbers are summed over every
  start and a reset loses none.
- A compaction logs its start with the job it followed or preceded (`prq.compaction.started`, with the notes revision
  and the cut, before any summary call) and its end: adopted (`done`, with the notes revision, the cut, the summary
  calls and their tokens), failed (`failed`, with the reason), overtaken (`discarded`), or with nothing to cut
  (`skipped`, with no start); a summary tried again (`retry`, with the reason), and a job run again after a refusal
  (`prq.job.rerun`). The start, end and re-run events carry identifiers, positions and counts, never notes, question or
  answer text; a failure or retry reason is a job failure's reason (the provider's message, redacted and cut to 500
  characters), which can echo part of a request.
- The UI shows, per PR, the job state (waiting, which agent ID is working on it, failed with its reason) and, per answer,
  the target SHA, the model and the tokens used. The job state reaches it as the session's Agent state
  (`PrSessionView` in `@prq/protocol`), which only the server sets. Presence, the job counts and the ledger's version
  reach it as the Hub's Agent state (`HubView`), likewise, and the PR list, the agents and the repositories as pages
  (`GET /api/ledger`, `/api/agents` and `/api/repos`).
- A failed job is kept as `failed` and can be retried from the UI.

### Billing limits

Spending is capped at the model provider, with the spend limit or prepaid credit of the API key; prq keeps no budget of
its own. A cloud job has no step, token or time limit for now: how much a job needs is unknown until prq is used, and a
limit set before that could stop the very jobs prq exists for. Every cloud run's usage is logged (`prq.job.usage`, see
[Observability](#observability)), so limits, possibly configurable, can come later from the observed numbers. Until
then a model that keeps calling tools runs until the provider refuses a call.

- When the provider refuses a call (its spend limit, a key or a model it does not accept), the system shall end the job
  as `failed` with the provider's reason: `provider refused the request (HTTP <status>): <its message>`, or, for an
  error sent inside the stream, `provider error during the answer (<its code or type>): <its message>`. A 2xx whose body
  cannot be read or decoded is no refusal: `provider response could not be read (HTTP <status>): <what failed>`. A 429
  or 5xx is retried by the AI SDK first (twice, with exponential backoff), and the reason then says how many attempts
  were made.
  The API key is replaced by `[redacted]` in every reason built from what the provider sent (these, a finish reason,
  a stream that fails midway) before it is cut to 500 characters, so a cut never leaves part of it. A stream that
  fails midway shows the client the same reason in place of the error's own text.
- When the provider ends an answer other than normally (its output limit, its content filter, any finish but `stop`),
  the job ends as `failed` with that reason, never as `done`.
- In every failure, the text the turn had already produced is kept in the conversation and marked incomplete.
- A workspace container stops after 30 minutes without a request.
- A `prq wait` long-poll keeps the Hub awake while it waits, and that time is Durable Object duration billed. One waiter
  should fit in the allowance included with Workers Paid; usage is checked after deployment, and if it is high the
  long-poll is replaced by short polls every few tens of seconds.

Apart from these, bounds that keep a job from waiting forever (liveness, not spending):

- Each model request ends when no response arrives within 120 s of sending it, and when no output arrives for 120 s
  after that, before the first chunk or between chunks. The job then fails with `the provider sent no response for
  120 s` or `the provider stopped sending output for 120 s`. The first bound is prq's (a middleware on the model, since
  the AI SDK's bounds start only at the response); the second is the AI SDK's. Each request is bounded on its own, a
  retry included, and also ends at once when its caller aborts it, whether or not the request honours the abort. A
  job's total time is not bounded.
- A tool call ends when the workspace answers, at the latest after 31 minutes (a backstop over the workspace's own
  bounds, since a call may rebuild the checkout first), and at once when the turn is aborted; either way the model gets
  the failure as text. The checkout a job's first model call needs is waited for the same way, and a job whose
  checkout cannot be made fails `workspace: <reason>`.
- A cloud job's run is started at most 3 times across restarts, and the SDK's own recovery is declined (see
  [Owner and jobs](#owner-and-jobs)). Each summary call of a compaction (one per batch) is tried once more, and its
  requests have the bounds above; a job whose request the provider refused for the context's length is run again once,
  after a compaction.

## Directory layout

Aligned with zenith (`packages/core` + `packages/relay`) and kopje (a `src/client` inside the Worker).

```
prq/
├─ packages/
│  ├─ protocol/            @prq/protocol: valibot schemas and types (the /cli/* and /api/* contracts, jobs, summary format)
│  │   └─ src/
│  │       ├─ index.ts           re-exports
│  │       ├─ version.ts         the Prq-Version header name
│  │       ├─ errors.ts          error codes and the error body
│  │       ├─ pr.ts              pull request references and details, the canonical session name, the Hub's name
│  │       ├─ cli.ts             jobs, what a local agent sends and receives, and the routes' time bounds
│  │       ├─ messages.ts        the metadata of messages the server appends
│  │       └─ views.ts           what the UI reads from the server (the version message, the session view, the retry answer, the Hub view and its pages)
│  ├─ server/              @prq/server: the Worker (Hono + Agents SDK) and the UI
│  │   ├─ src/
│  │   │   ├─ index.ts           entry: the app and the Durable Object classes
│  │   │   ├─ app.ts             the routes and their middleware, with the bound on their calls to Durable Objects
│  │   │   ├─ env.d.ts
│  │   │   ├─ config.ts          the secrets, checked once per isolate (fail closed)
│  │   │   ├─ access.ts          Access JWT verification (jose)
│  │   │   ├─ http.ts            no-store and Prq-Version headers, error bodies
│  │   │   ├─ version.ts         the server version (packages/server/package.json)
│  │   │   ├─ log.ts             log events
│  │   │   ├─ names.ts           the only Durable Object stubs; which Agents routes are served
│  │   │   ├─ agents.ts          /agents/* (routeAgentRequest behind the name check), the version message
│  │   │   ├─ schema.ts          SQLite schema steps per Durable Object class
│  │   │   ├─ wait.ts            bounded waits: timeouts and the one-at-a-time queue
│  │   │   ├─ webhook.ts         GitHub webhook (signature, own PRs only)
│  │   │   ├─ cli-routes.ts      /cli/* (wait / claim / context / submit)
│  │   │   ├─ api-routes.ts      /api/* (job retry, the Hub's pages)
│  │   │   ├─ hub.ts             Hub (ledger, pool, notifications, wait, its view)
│  │   │   ├─ ledger.ts          the ledger's rules: problem labels and presence
│  │   │   ├─ pr-session/        PrSession (intake, jobs, context assembly, tools)
│  │   │   │   ├─ index.ts       the class: intake, jobs, the wake and the outbox, its chat hooks
│  │   │   │   ├─ history.ts     append-only history: refused client frames, insert-only writes
│  │   │   │   ├─ jobs.ts        job rows and their guarded transitions, the webhook inbox and GitHub's order
│  │   │   │   ├─ reconcile.ts   head reconciliation's marks and how a read of GitHub's head is judged
│  │   │   │   ├─ context.ts     the conversation's pages for /cli/context
│  │   │   │   ├─ cloud.ts       the cloud agent seam and its failure reasons
│  │   │   │   ├─ turn.ts        a cloud turn: its binding, how it ended, what its commit stores
│  │   │   │   ├─ model.ts       the model provider, its response bound, a provider error as a failure reason
│  │   │   │   ├─ context-budget.ts  the context parameters scaled to the model's window
│  │   │   │   ├─ compaction.ts  compaction: the cut, the summary prompts (Pi's) and calls
│  │   │   │   ├─ notes.ts       the analysis notes and the context count as stored
│  │   │   │   ├─ projection.ts  what a job's model reads of the conversation
│  │   │   │   ├─ tools.ts       the cloud agent's tools and the turn's loop
│  │   │   │   ├─ room.ts        how much a turn may still read: the window less the newest measured request
│  │   │   │   ├─ pages.ts       a page of a command's output, from any line or character
│  │   │   │   ├─ workspace.ts   what the tools call: the workspace's client and its bounds
│  │   │   │   └─ prompt.ts      the system prompt and an analysis's task
│  │   │   ├─ github.ts          the GitHub App: installation tokens and pull request reads, each bounded
│  │   │   ├─ instructions/      prompts, skill registry, activate_skill / read_skill_resource
│  │   │   ├─ workspace.ts       Workspace: the container, the gate on turns, prepares and paged commands
│  │   │   ├─ workspace-git.ts   the checkout's git procedure as data, and whether a checkout is reused
│  │   │   ├─ egress.ts          GitEgress: the container's only way out
│  │   │   └─ client/            React UI (Vite)
│  │   ├─ scripts/           manual checks of a model provider, the tool loop and the GitHub App
│  │   │                     (`pnpm run check:provider`, `check:tools`, `check:github`), not part of the Worker
│  │   ├─ Dockerfile         the workspace container's image
│  │   ├─ wrangler.jsonc
│  │   ├─ vite.config.ts
│  │   └─ vitest.config.ts   two projects: the Worker's tests in workerd, the git procedure's (*.node.test.ts) in Node
│  └─ cli/                 @prq/cli: prq, compiled by Bun into one binary (dist/prq; Node 24 runs the source too)
│      └─ src/
│          ├─ main.ts            the entry the binary is built from: arguments, the command, the exit code
│          ├─ config.ts          the Worker's URL, the service token, the agent ID, the state root
│          ├─ client.ts          /cli/* over HTTP: the token headers, validation, authentication failures, the version notice
│          ├─ retry.ts           client timeouts from the routes' bounds, retries and their window
│          ├─ state.ts           the claim record and the job directories
│          ├─ context.ts         the context's pages joined, an answer job's question
│          ├─ answer.ts          the answer prq submit sends: answer.md, checked before any request
│          ├─ commands/          one module per command
│          ├─ e2e/               the compiled binary against the real Worker
│          └─ test/              the binary's build, the Worker through wrangler's test harness, a stand-in for Access, the binary as a child process, the local stack (`pnpm run stack`), manual checks of a cloud question, of head reconciliation and of the workspace container (`pnpm run check:cloud`, `check:reconcile`, `check:workspace`)
├─ skills/prq/SKILL.md     the local AI's procedure (wait → claim → work → submit → wait again); not a registered skill
├─ .claude/skills/verify-prq/  running the local stack with scripted jobs for a local agent, and reading its request log
├─ docs/                   design.md, decisions.md, ui.md, spikes.md
├─ design/                 design tokens, component inventory, screens ↔ Pencil frames, the Pencil document (the UI design's source for code)
├─ pnpm-workspace.yaml     catalog
├─ package.json
├─ tsconfig.base.json
└─ mise.toml / mise.lock
```

- `protocol` is separate because the server, the CLI and the future Chrome extension read the same contract. Rules used
  only inside the server (job states, how analyses are folded) stay in `server` and are not shared.
- The Chrome extension is added as `packages/extension` when it is built.

## Phases

1. **Prototype (done).** The points to check were tried in the layout above, without lint, format or CI. See
   [spikes.md](spikes.md); the code is on the `spike/prototype` branch and is a reference, not a base to merge.
2. **UI design.** The screens in [ui.md](ui.md) are designed in Pencil.
3. **Toolchain and CI (done).** lint, format, hooks, CI and the repository settings were set up following zenith and
   kopje (see the toolchain row in [decisions.md](decisions.md)) before the production code is written.
4. **Implementation.** The production code, starting from the contracts in `@prq/protocol`.

## Not verified yet

Only a deployment can show these.

- **Real Access.** The Worker's check is tested with a local RS256 key pair and a stubbed key set. Real Access tokens,
  from a browser and from a service token, and Access's key set endpoint are checked on a deployment.
- **Real GitHub.** App installation, webhook delivery, and token injection for a private repository (only a public
  repository was reached in the prototype, with the injection written but not exercised). What the webhook handling
  takes from GitHub's documentation is checked on a deployment too: that `pull_request.updated_at` advances with each
  push and `synchronize` carries `before`, that a redelivery repeats `X-GitHub-Delivery`, and the 10 s limit. And
  fetching by SHA a commit that a force-push left behind `pull/<n>/head`, as `prq checkout` does for an answer's
  workspace: when GitHub refuses it, `checkout` exits 1 naming the commit. Head reconciliation has read GitHub's API
  through the Worker only in wrangler's local runtime (`check:reconcile`); how an answer's `updated_at` moves under
  pushes, and how far a replica lags, are tested only with a served API.
- **Containers in production.** Start and rebuild times, and checkout time of a large repository. The local Docker
  numbers (`check:workspace`) are not production values.
- **Bundling by wrangler.** The PKCS#8-only crypto path of `@octokit/auth-app`, bundled by wrangler, has minted a
  real installation token in wrangler's local runtime (`check:reconcile`); a deployed Worker has not minted one yet.
- **Billing.** The Durable Object duration of the `wait` long-poll with one waiter, and the real cost of cloud turns.
- **Providers other than the one tried.** Tool calling and streaming through the AI SDK were tried against one
  OpenAI-compatible provider; each provider to be used needs the same check.
- **Compaction at real context lengths.** Compaction was exercised with a deliberately small window (20,000 tokens, also
  through the Worker against the real provider: `check:compaction`); its behavior with a real context length, how often
  it runs, and the answers' quality after it on real pull requests are not measured.
- **Skills.** Not built in the prototype: fetching a skill at a pinned commit and storing it in the Hub (and its size
  against Durable Object storage limits), whether models choose to activate a skill from its description alone, running
  a script under `allowed-tools` in the workspace container, and materializing skills into a local job directory.
- **Browser client.** `useAgentChat` with a local owner (an appended answer, reconnection) was exercised through a Node
  client speaking the same WebSocket protocol, not in a browser.
