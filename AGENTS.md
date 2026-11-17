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
- `pnpm add --global link:.` in `packages/cli` installs `prq` as a link to the checkout (`pnpm remove --global @prq/cli`
  removes it), and Node runs its TypeScript source (no build). The CLI's tests run in Node within `pnpm run test`: the
  real CLI as a child process against the real Worker, which wrangler's test harness runs locally behind a stand-in for
  Access; nothing reaches the network.
- lefthook runs oxlint and oxfmt on the staged files, a betterleaks secret scan, actionlint and ghalint on workflows,
  and commitlint on the message.
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
  top-level `fileToken` (`design/README.md`).
- Commits, pull requests, docs and issues are public and in English. They describe the change and its reasons with
  repository-relative paths, and leave out absolute local paths, private account or infrastructure identifiers,
  internal domains, and how the work was done (sessions, agents, reviews).

## Commits and pull requests

- Commit subjects use Conventional Commits (commitlint checks them; the mise-update bot's "Update mise tools" is the
  exception). Commits are signed. Pull requests merge with a merge commit.
