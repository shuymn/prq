# Repository Guidelines

prq summarizes the host's own GitHub pull requests and answers follow-up questions. A Cloudflare Worker
(`packages/server`) holds the conversations; a local CLI connects local agents. Design: `docs/design.md`; library and
platform decisions: `docs/decisions.md`; the UI design: `design/README.md`; hosting it: `docs/operations.md`.

## Commands

- `mise trust` once, then `mise install` installs the pinned Node.js, pnpm and check tools (`mise.toml`, `mise.lock`);
  `pnpm install` installs the workspace and the Git hooks. The hooks go into the repository's shared `.git/hooks`, so
  they also run in other worktrees, and a branch from before this toolchain cannot commit through them.
- `pnpm run lint` (oxlint, type-aware), `pnpm run lint:css` (stylelint on the web UI's stylesheets), `pnpm run fmt`
  (oxfmt check; `pnpm run fmt:fix` formats), `pnpm run knip` (unused files, dependencies and exports), `pnpm run
  typecheck` and `pnpm run test` are the checks CI runs (`.github/workflows/ci.yml`). `pnpm run test` builds the web UI
  first. CI runs them as parallel jobs: `Lint` runs every check but the tests, and `Test` runs the tests as three jobs,
  each building the web UI first: the CLI's, the server's `workerd` and `client` projects, and its `node` project
  (`pnpm run test --project <name>` in `packages/server` runs one). The `Check` job, the required status check and the
  one the release check reads, succeeds only when all of them did.
- `pnpm run build` in `packages/server` builds the web UI (`src/client`, Vite) into `dist/client`, which the Worker
  serves as its static assets with the generated `_headers`. Whatever runs the Worker (the tests, `pnpm run stack`, the
  owner's checks) needs that build; the tests stop without it, saying so, and the stack and the checks build it first.
  `pnpm run icons` there writes the favicon set into `src/client/public` from the BrandMark, rendered in Chrome.
- The component gallery (`packages/server/src/client/gallery`) renders every component and PR list state the UI has,
  by the names `design/components.md` and `design/screens.md` give them: `vite` in `packages/server` serves it at
  `/gallery/gallery.html` (`?entry=<name>` for one entry, at its frame's size), and `vite build --mode gallery` builds it
  into `dist/gallery`; the production build holds none of it. The server's `client` test project runs the UI's tests
  (`src/client/**/*.test.tsx`) in the machine's Chrome (Vitest's browser mode through playwright, the `chrome` channel),
  their reads against a fetch the test answers; its registry test holds the gallery to the two design files, less a
  list of what the UI has yet to build. A failed client test leaves a screenshot in `packages/server/test-output/client`.
- `pnpm run build` in `packages/cli` compiles `prq` with Bun into the single file `packages/cli/dist/prq`; put it on
  `PATH` or run it by path. Node 24 runs the source as well (`node packages/cli/src/main.ts`), so it uses no Bun-only
  API. The CLI's tests run in Node within `pnpm run test`: they compile the binary first, then run it as a child process
  against the real Worker, which wrangler's test harness runs locally behind a stand-in for Access; nothing reaches the
  network. The web UI's browser check (`packages/cli/src/e2e/ui`) drives the machine's Chrome (playwright's `chrome`
  channel; no browser is downloaded) against the same Worker through the stand-in's browser door, which forwards a
  browser's requests and WebSockets with the application's token; a failed test leaves a screenshot in
  `packages/cli/test-output/ui`.
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
  `packages/cli/src/test/workspace-check.ts`), `pnpm run check:workspace [--browser] <owner>/<repo>#<number>` in
  `packages/cli` runs the Worker in wrangler's local runtime with containers on, against a pull request of a public
  repository the App is installed on, and removes the containers it started. With `--browser` it then opens headed
  Chrome on the pull request through the stand-in's browser door and pushes the pull request's base as its next head:
  the completed summary stays shown with "Summarizing" and that SHA while the new analysis streams. `pnpm run
  check:compaction [--japanese] [--analysis-prompt <text>] [--answer-prompt <text>] <owner>/<repo>#<number>` runs the same way with a small
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
- `pnpm run check:skills [--browser] [--local <owner>/<repo>#<number> | <owner>/<repo>#<number>]` in `packages/cli`
  previews, registers, updates and removes the public skill `skills/yomiyasu` of `nanaism/yomiyasu` through the Worker
  against real GitHub (with `--browser`, through the settings page in headed Chrome at the stand-in's browser door,
  updating by ref), compares the stored copy, as the Hub holds it and as `/cli/skill` serves it, with what it reads from
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
- `pnpm run check:deployed -- <mode>` in `packages/cli` checks the real deployment that `PRQ_URL` names
  (`docs/operations.md`, The deployed checks); its runs are the owner's. Its tests (`packages/cli/src/test/deployed-*`,
  `packages/cli/src/e2e/deployed.test.ts`) run the modes against loopback servers and against the local Worker through
  the stand-in's edge, a third listener of `src/test/access.ts` that decides each request as Access does for the
  hostname before the door forwards it, with short polls and the scripted model; nothing reaches the network.
  wrangler's local runtime does not pass a client's departure on to the Worker, so the edge check's E9 fails there by
  design.
- `pnpm run secrets check|status|put` in `packages/server` handles the Worker's production secrets
  (`docs/operations.md`, The secrets command). `status` and `put` reach the Cloudflare account and are the host's to
  run. Its tests (`packages/server/scripts/secrets.node.test.ts`, in the server's node project) run it through the
  scripts' test entry (`scripts/test-entry.ts`), whose fixture (`scripts/fixture.ts`) gives it a stand-in for wrangler
  and a deploy directory in the OS temp directory, and nothing reaches the network. The production entries read no
  test setting: they refuse a terminal holding one (`PRQ_DEPLOY_*`) or a wrangler override (`docs/operations.md`, The
  deploy command).
- `pnpm run release-check -- <tag> [--pre-tag <sha>]` in `packages/server` checks, reading only, whether a commit may be
  released as the tag (`docs/design.md`, Versions). `pnpm run deploy -- --bootstrap [--resume] | <tag>
  [--ignore-running] [--immediate] [--keep-image] | --read-back <record>` there deploys the Worker
  (`docs/operations.md`) and is the host's to run. Their tests (`packages/server/scripts/release-check.node.test.ts`,
  `deploy.node.test.ts`) run them against stand-ins for wrangler, mise, pnpm and `gh` on `PATH`, an origin made with
  `FixtureGit`, a local server for the ledger and Cloudflare's API, and a terminal from python3's `pty` module, with
  `HOME` and the deploy directory in the OS temp directory; the deploy's run through the same test entry, whose fixture
  holds its shorter bounds, the ledger's origin and the API's address. Nothing reaches the network.
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
  (`design/README.md`). `pnpm run lint:css` and `pnpm run lint` refuse a raw value where styles are authored.
- The web UI supports the latest stable Chrome only: it uses the platform's newest features natively, without polyfills
  or fallbacks (`docs/decisions.md`).
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
