# prq

prq helps you understand your own GitHub pull requests across repositories. It writes a summary of each one and lets
you keep asking follow-up questions, grounded in the diff, the surrounding code and the linked task, not just the PR
description. How the output reads is set by your own instructions: two prompts and the skills you register.

A Cloudflare Worker receives the webhooks and holds one conversation per pull request. The analysis runs on whichever
agent is available: a local AI session you already use (woken through the `prq` CLI), or a cloud agent with an API-key
model. The web UI sits behind Cloudflare Access and is meant for the person who hosts it.

Status: in development. Releases publish `prq` ([docs/operations.md](docs/operations.md#installing-prq)), and the
host deploys the Worker from a release tag ([docs/operations.md](docs/operations.md#each-release)).

- [docs/design.md](docs/design.md): purpose, architecture, rules, phases.
- [docs/decisions.md](docs/decisions.md): library and platform decisions.
- [docs/ui.md](docs/ui.md): the brief for the UI design.
- [docs/spikes.md](docs/spikes.md): what the prototype checked and found (code on the `spike/prototype` branch).
- [docs/operations.md](docs/operations.md): hosting prq: the accounts, the setup, the production secrets and their
  rotation.

## Running a local agent

A local agent is an AI session on your machine that answers prq's jobs through the `prq` CLI.

1. Install `prq` from a release, verifying it first ([docs/operations.md](docs/operations.md#installing-prq)), or build
   it: `pnpm run build` in `packages/cli` writes the single binary `packages/cli/dist/prq` (with Bun, pinned in
   `mise.toml`). Put it on the `PATH` of the session's shell.
2. Give that shell the environment: `PRQ_URL` (the Worker's origin), `PRQ_ACCESS_CLIENT_ID` and
   `PRQ_ACCESS_CLIENT_SECRET` (an Access service token), `PRQ_AGENT_ID` (one per session) and `PRQ_CLONE_ROOTS` (the
   directories holding your clones as `<owner>/<repo>`, where `prq checkout` finds the pull request's repository). The
   host's setup writes the first three to the deploy directory's `access.env`
   ([docs/operations.md](docs/operations.md#5-zero-trust-and-access-zone)); the session's launcher loads them before
   starting the session with `set -a; . ~/.config/prq/deploy/access.env; set +a`. `prq --help` lists them all, and the
   Local CLI section of [docs/design.md](docs/design.md) describes each.
3. Link `skills/prq` into the session's skills directory (for Claude Code, `.claude/skills/prq`) and start the session
   as a prq local agent. The skill is its procedure: wait for a job in the background, claim it, answer it, submit, and
   wait again. How the answers read comes from your own instructions to the session.

To try it without a deployment, [`.claude/skills/verify-prq/SKILL.md`](.claude/skills/verify-prq/SKILL.md) runs the
Worker locally and pushes scripted jobs.

The GitHub repository settings are declared in `.github/infra.yaml`; review them with
`gh-infra plan .github/infra.yaml` and apply them with `gh-infra apply .github/infra.yaml` (gh-infra is pinned in
`mise.toml`).
