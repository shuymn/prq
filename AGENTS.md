# Repository Guidelines

prq summarizes the host's own GitHub pull requests and answers follow-up questions. A Cloudflare Worker
(`packages/server`) holds the conversations; a local CLI connects local agents. Design: `docs/design.md`; library and
platform decisions: `docs/decisions.md`; the UI design: `design/README.md`.

## Commands

- `mise trust` once, then `mise install` installs the pinned Node.js, pnpm and check tools (`mise.toml`, `mise.lock`);
  `pnpm install` installs the workspace and the Git hooks. The hooks go into the repository's shared `.git/hooks`, so
  they also run in other worktrees, and a branch from before this toolchain cannot commit through them.
- `pnpm run lint` (oxlint, type-aware), `pnpm run fmt` (oxfmt check; `pnpm run fmt:fix` formats), `pnpm run knip`
  (unused files, dependencies and exports), `pnpm run typecheck` and `pnpm run test` are the checks CI's `Check` job
  runs.
- `pnpm run build` in `packages/cli` compiles `prq` with Bun into the single file `packages/cli/dist/prq`; put it on
  `PATH` or run it by path. Node 24 runs the source as well (`node packages/cli/src/main.ts`), so it uses no Bun-only
  API. The CLI's tests run in Node within `pnpm run test`: they compile the binary first, then run it as a child process
  against the real Worker, which wrangler's test harness runs locally behind a stand-in for Access; nothing reaches the
  network.
- A test runs git only through the named operations of `FixtureGit` and `FixtureRepo` (`packages/cli/src/test/git.ts`),
  never with arguments of its own; a test that needs another git call adds an operation. Paths are names in a fresh
  directory of the OS temp directory, outside every repository, checked to resolve inside it, and git gets an
  environment built from nothing, so a `GIT_DIR` a hook exported cannot reach the repository. A canary
  (`packages/cli/src/test/canary.ts`) fails the CLI's test run when the repository's refs (other than T3 Code's
  checkpoints under `refs/t3/`), `HEAD`, worktrees, config, index entries or hooks, or the user's git identity, changed
  during it. The server's tests of the cloud workspace's git procedure (`packages/server/src/*.node.test.ts`, a Node
  project beside the workerd one) use the same fixture, and the canary guards their run too.
- Tests run the Worker without Docker (`dev.enable_containers: false` in `packages/server/wrangler.jsonc`), so the
  Workspace's container is a fake there. The real container is the owner's check: with Docker running and
  `packages/server/.dev.vars` holding the model, the GitHub App and `GITHUB_INSTALLATION_ID` (see
  `packages/cli/src/test/workspace-check.ts`), `pnpm run check:workspace <owner>/<repo>#<number>` in `packages/cli`
  runs the Worker in wrangler's local runtime with containers on, against a pull request of a public repository the
  App is installed on, and removes the containers it started. `pnpm run check:compaction [--japanese]
  [--analysis-prompt <text>] [--answer-prompt <text>] <owner>/<repo>#<number>` runs the same way with a small
  `MODEL_CONTEXT_TOKENS` (such as 20000) and checks compaction. The prompt options save the host's prompts before the
  analysis (give two different texts) and check that every model request holds only its own kind's prompt; with an
  answer prompt it also reports the language of an answer to a question in each language, apart from its verdict.
  `--analysis-only` runs the push's analysis alone and reports its stored text, at any window, and
  `--analysis-language ja|en` holds the analysis to the language its prompt asks for, in the verdict. `--skill`
  registers yomiyasu and checks that the compaction summarizes an executed activation as its marker alone (give an
  answer prompt that names the skill). That file is
  written only by `pnpm run dev-vars write [--window <tokens>]` in `packages/cli`, from the owner's secrets directory
  (`--window` sets `MODEL_CONTEXT_TOKENS`), and deleted only by `pnpm run dev-vars remove`; `pnpm run dev-vars status`
  names the variables it sets. No command prints a value but the window `write` reports
  (`packages/cli/src/test/dev-vars.ts`).
- `pnpm run check:skills [--local <owner>/<repo>#<number> | <owner>/<repo>#<number>]` in `packages/cli` previews,
  registers, updates and removes the public skill `skills/yomiyasu` of `nanaism/yomiyasu` through the Worker against
  real GitHub, compares the stored copy, as the Hub holds it and as `/cli/skill` serves it, with what it reads from
  GitHub itself, and runs cloud turns with it and a second skill under a scripted model, checking what their requests
  hold. With `--local` and a public pull request it then runs the compiled `prq` as a local agent on that pull request
  (claim, context, a refreshed context, checkout from a clone it makes in the OS temp directory, which fetches the
  commit from GitHub) and compares the files `prq context` wrote with GitHub's tree, still with the App alone. Without an argument it needs only the GitHub App in `packages/server/.dev.vars`
  (no model, no Docker); with a pull request and Docker it then runs yomiyasu's scripts in the real container in a
  turn under a scripted model, probes the container's script runs (ownership and modes, the reset cleanup, a runner
  given no frame, lost scratch, orphans, a dead runner), and runs a smoke of skill activation and scripts with the
  model, at the window `.dev.vars` sets (written without `--window`).
- lefthook runs oxlint and oxfmt on the staged files, a betterleaks secret scan, actionlint and ghalint on workflows, a
  `fileToken` check on `design/prq.pen`, and commitlint on the message.
- Repository settings live in `.github/infra.yaml`: `mise exec -- gh-infra plan .github/infra.yaml` shows what would
  change, and `mise exec -- gh-infra apply .github/infra.yaml` applies it once the owner approves.

## Packages

- A package extends `tsconfig.base.json` and takes its versions from the pnpm catalog (`catalog:`).
- A new dependency version is at least 3 days old and keeps the provenance of its earlier releases (`minimumReleaseAge`,
  `trustPolicy`), and a dependency build script runs only once reviewed into `allowBuilds` (`pnpm-workspace.yaml`).
- Worker bindings are declared by hand in `packages/server/src/env.d.ts` as `wrangler.jsonc` gains them, in place of
  `wrangler types` output.

## Rules

- UI design and UI code start from the `modern-web-guidance` skill: retrieve the guides a component relies on (recorded
  in `design/components.md`) and search for anything new, then follow them.
- UI code uses only the design tokens (the CSS custom properties generated from `design/tokens.json`) and the
  components in `design/components.md`. Anything missing is added to the design and the inventory first
  (`design/README.md`).
- `design/prq.pen` is written only by the Pencil app, and oxfmt skips it. Commit it as Pencil saved it, minus its
  top-level `fileToken`, which the pre-commit hook rejects (`design/README.md`).
- Commits, pull requests, docs and issues are public and in English. They describe the change and its reasons with
  repository-relative paths, and leave out absolute local paths, private account or infrastructure identifiers,
  internal domains, and how the work was done (sessions, agents, reviews).

## Commits and pull requests

- Commit subjects use Conventional Commits (commitlint checks them; the mise-update bot's "Update mise tools" is the
  exception). A commit message has no footer: commitlint fails a body line it parses as a footer token, such as a
  wrapped line starting with `word:` or a `Closes #5` (pull request bodies close issues), and a breaking change uses `!`
  in the subject. Commits are signed. Pull requests merge with a merge commit.
