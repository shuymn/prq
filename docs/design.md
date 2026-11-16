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
- **The owner of a session is fixed.** When a PR session is created, the pool decides whether it is `cloud` or `local`,
  and the session keeps that owner. There is no handoff between the two. A `local` session whose agent is away waits;
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
   │    owner (cloud | local, fixed at creation) and job state
   │    model context (after compaction) and the analysis notes
   │    cloud owner: streamText with tools in onChatMessage; workspace is a Sandbox
   │    local owner: input is only stored → notify Hub → prq claims → the answer is appended
   │
   └─ Hub (Agents SDK Agent, one instance)
        ledger of PRs (for the list), agent pool (local presence), queue of notifications for local agents
        instructions: the two prompts and the registered skills (pinned to commit SHAs)

Local: prq (CLI, Node 24)   wait / claim / context / checkout / submit / reconcile
UI:    React + Vite (Workers Static Assets), connected to PrSession with useAgentChat
```

- **Worker.** Hono routes. `/webhook` verifies the GitHub signature. Every other path sits behind Access and verifies the
  Access JWT itself.
- **PrSession.** One `AIChatAgent` per pull request. It holds the conversation, the owner, the jobs, the model context
  and the analysis notes, and it is the only place that decides job state. The instance name is `owner~repo~n`:
  `routeAgentRequest` takes path segments as the name without percent-decoding, so `/` and `#` cannot be used, and `~`
  is safe in URLs and cannot appear in a GitHub owner or repository name.
- **Hub.** One `Agent` instance that holds the PR ledger for the list view, the pool (which agent IDs are present), the
  notification queue for local agents, and the instructions (the two prompts and the skill registry). It does not hold
  job state; it asks PrSession (`peek`, `claim`). Each ledger entry keeps what a list row shows (see
  [PR ledger](#pr-ledger)).
- **prq CLI.** Runs on the host's machine, talks to the Worker over HTTP with a service token, and uses the host's own
  git and `gh`.
- **Sandbox.** The cloud workspace of a PrSession: a container with a checkout of the PR that the agent searches and
  reads with tools.
- **UI.** A React app served by the same Worker. State lives on the server; the `useAgentChat` and `useAgent` hooks
  keep the client in sync, and screen-only state is local `useState`.

## State and rules

### Owner and jobs

PrSession keeps the owner and the job state in one place and processes `claim`, `submit` and retry one after another.

- When a PrSession is created, the system shall look at the Hub pool and set the owner to `local` if any local agent is
  present, otherwise `cloud`. When two creations race, the first decision wins. The owner does not change afterwards,
  and all analyses and questions of the session are handled by it.
- `local` is a kind, not a binding to one AI session. Any local agent in the pool may claim a pending job, because the
  conversation and the notes are in PrSession and the worktree can be rebuilt.
- A job has a `jobId` and a target. An analysis is identified by the PR and its head SHA; an answer by the message ID of
  the question. Every `claim` issues a new `claimId` and records the agent ID that made it.
- When an agent calls `wait` or `claim`, the system shall return that agent ID's own claimed, unfinished job before any
  new job, with a new `claimId`. A process that was killed and restarted can therefore continue at once, and an answer
  that arrives late from the old process is rejected.
- A job claimed by one agent ID shall not be returned to another agent ID.
- When a `submit` arrives, the system shall accept it only if `jobId`, `claimId` and the target (head SHA or question
  message ID) match the current state. When the same `jobId` is submitted again, the system shall return the result
  already recorded and shall not add it to the conversation a second time.
- While no local agent is present, the jobs of a `local` session wait, questions included.
- A job that was claimed but never submitted (the AI session was closed, for example) is not returned automatically.
  The UI shows which agent ID has been working on it and since when, and starts showing it as possibly stalled after 60
  minutes. "Retry" is available on any claimed or failed job at any time, because the host may know the session is gone
  before that mark appears. A retry puts the job back to pending and changes the `claimId`, so an answer that arrives
  late from the earlier claim is rejected.
- A failed job is kept as `failed` with its reason and can be retried from the UI.

### Intake

UI, webhook and CLI input all enter through PrSession.

- When the UI sends a message, it arrives in `onChatMessage`. PrSession looks at the owner first: for `cloud` it runs the
  turn; for `local` it runs no turn, creates a job for every user question that has none, and notifies the Hub. A
  question can already be stored when a later turn starts, which is why every question without a job gets one, not only
  the last message.
- An analysis is made per push, at the pushed head SHA: GitHub sends one `pull_request` event per push, and the commits
  inside a push are not analyzed one by one.
- When a webhook arrives, it goes to the PrSession, not to the Hub. The PrSession always records the pushed SHA as the
  current head. If an analysis job for the same head SHA already exists (waiting, running or done), the system shall
  create no job; a push back to an already analyzed head (after a force-push, for example) shows that head's stored
  summary. A redelivery is therefore harmless and no delivery ID is stored. Analysis jobs that have not started are folded into the latest head: if A is running and B and C arrive,
  only C runs after A.
- A waiting question runs before the next analysis.
- When the server appends a message to the conversation (an analysis request, for example), it calls
  `waitUntilStable()` first and then `saveMessages` in its function form, which receives the latest history, and it
  never uses a stale `this.messages`.
- A local answer never replaces the whole conversation. PrSession checks the question's message ID against the latest
  history and appends one answer with `persistMessages`, which runs no turn and still reaches connected clients.
- History keeps the order in which messages were saved: a question sent during a turn comes before that turn's answer,
  and a local answer comes last. Each answer carries the message ID of its question in `metadata`, and the UI uses it to
  pair them.

### Notification and wait (`prq wait`)

- `prq` declares an agent ID when it connects (`--agent-id` or `PRQ_AGENT_ID`, the host name by default). Two AI sessions
  on one machine need two IDs. The ID is self-declared and is not authentication: every local agent uses the same
  service token.
- `wait` only receives a notification and never removes a job. A job stays until PrSession `claim`s it.
- Each time `wait` reconnects it re-checks for pending jobs and returns at once if there are any. An authentication
  failure (401 or 403) is told apart from an ordinary timeout and ends with an error, so the AI notices it.
- The connection between `prq` and the Hub is an HTTP long-poll with the service token in a header.
- The local AI's procedure (a skill or an `AGENTS.md`) is one round of: `wait` → `claim` → work → `submit` → start
  `wait` again in the background. The last step is mandatory, because it is what wakes the AI for the next job.

CLI exit codes: 0 ready, 2 timeout, 3 authentication failure, 4 claim mismatch, 1 anything else.

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
- The web UI learns the server's version from a message the server sends on every WebSocket connection, since a browser
  cannot read WebSocket response headers. It compares it with its own build version the same way and shows the reload
  notice described in [Caching](#caching).

### Presence

- Registering in the pool is the `prq` connection itself, and presence is kept per agent ID. There is no registration
  command.
- An agent ID counts as present while it is in `wait`, and while it holds an unfinished claim (up to 60 minutes after
  the claim). Presence ends 10 minutes after neither applies, so a long analysis does not make presence lapse and send
  new PRs to cloud.
- When any one agent ID is present, "a local agent is present" is true.

### PR ledger

The Hub's entry per PR is what the list shows without asking each PrSession. PrSession sends the entry's fields to the
Hub whenever a push arrives, a question is saved, one of its jobs changes state, or a claim reaches 60 minutes (an
alarm set at the claim). The Hub adds only what it owns itself: whether a local agent is present.

- **Latest event:** a push received, a question sent, a summary completed or an answer completed, with its time. Rows
  are ordered by it. Claims, heartbeats and streaming are not events.
- **Problem:** at most one label, the first that applies in this order:
  1. _Summary failed_ — the analysis of the current head failed and it has no completed analysis. Clears when one
     completes.
  2. _Answer failed_ — a question's latest job failed. Clears when a retry of it completes.
  3. _Possibly stalled_ — a claimed job has no result 60 minutes after its claim. Clears when the job completes, fails
     or is retried.
  4. _Waiting for a local agent_ — a `local` session has waiting work (sent by PrSession) and no local agent is
     present (known to the Hub). Clears when an agent is present again.
  5. _New push not summarized_ — the current head has no completed analysis. It is derived from the current head, not
     from the latest completed summary, so a completed analysis of an older head does not clear it and a push back to
     an analyzed head does not set it.
     "Needs attention" counts the PRs whose problem is one of the first four.

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
- **Scripts run in the cloud workspace.** A skill's script runs in the Sandbox (its image includes `python3`) and only
  as far as the skill's `allowed-tools` frontmatter permits. In the Agent Skills format `allowed-tools` lists
  pre-approved tools, and prq has no interactive approval step, so a skill that declares none cannot run scripts: it
  contributes instructions and references only. The pinned SHA means a skill's code does not change under the host.
- **Local runner.** `prq context` returns the two prompts and materializes the registered skills into the job's
  worktree (for example `.prq/skills/<name>/`), so the local AI reads them as files. A local agent may also use skills it
  already has on its own machine.

What is left out on purpose:

- **No output-language setting.** Language is part of the prompts, not a field the core interprets. A setting would
  force the core to know where it applies (summary, answer, notes, UI) and would still not express other style needs.
- **No per-repository or per-PR prompt overrides.** There is one host and one scope. They are added if the single
  scope proves too coarse.
- **No skill marketplace or discovery.** The host registers a URL it already knows.
- **No arbitrary code hooks** beyond skill scripts in the workspace.

### Model context

The full conversation (PrSession's UIMessages) is never trimmed. Only the context passed to the model is assembled, in
`prepareStep`, as: the analysis notes + the messages after the cut point + the current question.

Compaction follows the approach of Pi (`pi-coding-agent`, MIT license). The prompts and procedure that are copied keep
Pi's copyright notice.

- **Trigger.** When the context exceeds the model's context length minus a reserve (Pi's default: 16,384 tokens), the
  system shall compact. It checks after an answer has been returned (after the turn) and compacts then, so the next
  question does not wait; one compaction took 14 to 23 seconds in the prototype. If a request fails because the context
  length was exceeded, it compacts and retries once.
- **Token count.** The usage that the provider returned for the previous response is the main source, and only messages
  added since then are estimated. The estimate is characters ÷ 3, or a ratio measured in the session. Characters ÷ 4
  under-counted Japanese text and diffs by 1.3 to 1.7 times.
- **Overrun inside one turn.** Compaction between turns cannot prevent it, so tool results are capped (for example, cut at
  12,000 characters each) and the amount one turn may read is capped. When the cap is reached the agent answers from what
  it has read.
- **Cut point.** Going back from the newest message, the system keeps the most recent part (Pi's default: 20,000
  tokens). A tool call and its result are never separated. If the cut falls inside a turn, the first half of that turn is
  summarized separately; this step is required, because it happens every time when the amount kept is smaller than one
  turn.
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
- **Storage and insertion.** PrSession stores the notes with the target SHA, a revision and the message ID at the cut
  point. The model receives them as a message that says the conversation before this point was compressed into the
  following summary. The full history is not changed.
- **Failure.** A summary that hit the output limit is not adopted. When compaction fails, the stored notes and history
  stay as they were. The retry after a compaction failure happens once.
- Everything before the cut point is in the notes, so no message leaves the context without being reflected in them.
- The notes are language-neutral: the compaction prompt does not ask for a particular language, and the prompts for
  analysis and answers decide how the final text reads.
- Local agents get the same notes from `prq context`, together with the prompts and skills.

Adoption test: for the largest PR the system is meant to handle (a large diff plus search results), the model still
answers what was decided earlier after compaction. See [spikes.md](spikes.md) for how the prototype met it.

### Workspace (cloud)

- One Sandbox per PrSession. It stops after inactivity (for example, 30 minutes), and a stopped Sandbox loses its disk.
- It always starts from empty: `git init`, fetch the PR's head and base commits by SHA (shallow first, deeper only when
  a merge-base is needed), and check out the target SHA.
- A question is answered in the workspace of the last analyzed head SHA, and the answer records that SHA so the UI can
  show it. To ask about an earlier version, the user names the SHA.
- Git traffic to GitHub goes through the Worker: outbound HTTPS from the container is intercepted by the Worker, which
  adds an installation token. The only allowed destination is `github.com`; which repositories are reachable follows
  from the installation token's scope, so there is no per-repository allow list. The token never enters the container.
- The image includes `python3` for skill scripts (see [Instructions and skills](#instructions-and-skills)). Scripts get
  no network beyond the same restriction.
- This restriction applies only to traffic from inside the container. LLM calls and external tools (web search, for
  example) are made by PrSession on the Worker side and are not restricted by it. If tests are run in the container
  later, the destinations they need (an npm registry, for example) are added then.

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
  ledger come over the Agents SDK WebSocket, which resyncs the state after each successful reconnect. There is no
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
- **Workspace.** The Sandbox starts from empty each time (see [Workspace (cloud)](#workspace-cloud)); a checkout cache
  (snapshots or a backup) is added only if the start time turns out too slow.

### Authentication boundary

- There are two Access applications. `/webhook` bypasses Access. The rest of the host is allowed for the host's email
  (browser) or a service token (`prq`). Agents SDK's WebSocket path (`/agents/:binding/:name`) is inside the protection.
- On every protected path the Worker verifies `Cf-Access-Jwt-Assertion` with `jose`: signature, audience, a fixed issuer
  and expiry. A caller that passes Access is treated as the host; the host and the service token are not told apart per
  path. The verification stays so that a request reaching the Worker without passing Access (through a `workers.dev`
  address, for example) is refused.
- When a webhook arrives, the system shall accept it only if the signature is valid and `pull_request.user.id` is the
  host's. `sender` is whoever made the update, not necessarily the PR author.
- The GitHub App's private key is stored as PKCS#8. GitHub issues PKCS#1, which the WebCrypto-based path in workerd
  cannot read; convert it once with `openssl pkcs8 -topk8` before storing it as a secret.

### Observability

- Workers observability (logs) is enabled. Webhook receipt, job state changes, LLM and tool errors, and compactions are
  logged with the PR key and `jobId`.
- The UI shows, per PR, the job state (waiting, which agent ID is working on it, failed with its reason) and, per answer,
  the target SHA, the model and the tokens used.
- A failed job is kept as `failed` and can be retried from the UI.

### Billing limits

These are enforced, not left to observation.

- A cloud turn has a step limit (for example, 20) and a job has a token limit (for example, 500,000). When a turn hits
  either limit, the system shall make no further model or tool calls and end the job as `failed` with the reason. Text the
  turn had already produced is kept in the conversation and marked incomplete.
- AIChatAgent's automatic recovery retries are lowered from the default of 10 to about 2. A compaction is retried once.
- Spending is capped at the model provider, with the spend limit or prepaid credit of the API key; prq keeps no budget
  of its own. When the provider refuses a call, the job ends as `failed` with the provider's reason.
- A Sandbox stops after inactivity (for example, 30 minutes).
- A `prq wait` long-poll keeps the Hub awake while it waits, and that time is Durable Object duration billed. One waiter
  should fit in the allowance included with Workers Paid; usage is checked after deployment, and if it is high the
  long-poll is replaced by short polls every few tens of seconds.

## Directory layout

Aligned with zenith (`packages/core` + `packages/relay`) and kopje (a `src/client` inside the Worker).

```
prq/
├─ packages/
│  ├─ protocol/            @prq/protocol: valibot schemas and types (the /cli/* and /api/* contracts, jobs, summary format)
│  │   └─ src/
│  ├─ server/              @prq/server: the Worker (Hono + Agents SDK) and the UI
│  │   ├─ src/
│  │   │   ├─ index.ts           entry (Hono, routeAgentRequest)
│  │   │   ├─ env.d.ts
│  │   │   ├─ access.ts          Access JWT verification (jose)
│  │   │   ├─ webhook.ts         GitHub webhook (signature, own PRs only)
│  │   │   ├─ cli-routes.ts      /cli/* (wait / claim / context / submit)
│  │   │   ├─ api-routes.ts      /api/* (PR list and the like)
│  │   │   ├─ hub.ts             Hub (ledger, pool, notifications)
│  │   │   ├─ pr-session/        PrSession (intake, jobs, context assembly, tools)
│  │   │   ├─ github/            App token; attaching the token to outbound git traffic
│  │   │   ├─ instructions/      prompts, skill registry, activate_skill / read_skill_resource
│  │   │   ├─ workspace.ts       Sandbox
│  │   │   ├─ model.ts           model provider configuration
│  │   │   └─ client/            React UI (Vite)
│  │   ├─ wrangler.jsonc
│  │   ├─ vite.config.ts
│  │   └─ vitest.config.ts
│  └─ cli/                 @prq/cli: prq (Node 24)
│      └─ src/                main.ts, commands/, HTTP client, git
├─ skills/prq/SKILL.md     the local AI's procedure (wait → claim → work → submit → wait again); not a registered skill
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

- **Real Access.** The prototype replaced Access with an HS256 JWT. Production uses RS256 with a remote JWK set, and the
  service-token versus user distinction (`common_name`) has to be confirmed against real tokens.
- **Real GitHub.** App installation, webhook delivery, and token injection for a private repository (only a public
  repository was reached in the prototype, with the injection written but not exercised).
- **Sandbox in production.** Start and rebuild times, and checkout time of a large repository. The local Docker
  numbers are not production values.
- **Bundling by wrangler.** That the PKCS#8-only crypto path of `@octokit/auth-app` is the one wrangler bundles was
  checked with an equivalent esbuild condition set, not with wrangler's own.
- **Billing.** The Durable Object duration of the `wait` long-poll with one waiter, and the real cost of cloud turns.
- **Providers other than the one tried.** Tool calling and streaming through the AI SDK were tried against one
  OpenAI-compatible provider; each provider to be used needs the same check.
- **Compaction at real context lengths.** Compaction was exercised with a deliberately small window; its behavior with a
  real context length, and how often it runs, are not measured.
- **Skills.** Not built in the prototype: fetching a skill at a pinned commit and storing it in the Hub (and its size
  against Durable Object storage limits), whether models choose to activate a skill from its description alone, running
  a script under `allowed-tools` in the Sandbox, and materializing skills into a local worktree.
- **Browser client.** `useAgentChat` with a local owner (an appended answer, reconnection) was exercised through a Node
  client speaking the same WebSocket protocol, not in a browser.
- **Stuck-job display.** The 60-minute "stalled" indication and the retry button are designed, not built.
- **Presence timing.** The prototype treats an agent as present from its last contact within the timeout, or during a
  long-poll; the design above also covers the whole period of an unfinished claim. The difference is to be removed in
  the implementation.
