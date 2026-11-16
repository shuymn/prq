# prq

prq helps you understand your own GitHub pull requests across repositories. It writes a summary of each one and lets
you keep asking follow-up questions, grounded in the diff, the surrounding code and the linked task, not just the PR
description. How the output reads is set by your own instructions: two prompts and the skills you register.

A Cloudflare Worker receives the webhooks and holds one conversation per pull request. The analysis runs on whichever
agent is available: a local AI session you already use (woken through the `prq` CLI), or a cloud agent with an API-key
model. The web UI sits behind Cloudflare Access and is meant for the person who hosts it.

Status: design.

- [docs/design.md](docs/design.md): purpose, architecture, rules, phases.
- [docs/decisions.md](docs/decisions.md): library and platform decisions.
- [docs/ui.md](docs/ui.md): the brief for the UI design.
- [docs/spikes.md](docs/spikes.md): what the prototype checked and found (code on the `spike/prototype` branch).

The GitHub repository settings are declared in `.github/infra.yaml`; review them with
`gh-infra plan .github/infra.yaml` and apply them with `gh-infra apply .github/infra.yaml` (gh-infra is pinned in
`mise.toml`).
