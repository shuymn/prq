# prq

prq writes Japanese summaries of your own GitHub pull requests across repositories and lets you keep asking
questions about them. It reads the diff, the surrounding code and the linked task, not just the PR description.

A Cloudflare Worker receives the webhooks and holds one conversation per pull request. The analysis runs on whichever
agent is available: a local AI session you already use (woken through the `prq` CLI), or a cloud agent with an API-key
model. The web UI sits behind Cloudflare Access and is meant for the person who hosts it.

Status: design.

The GitHub repository settings are declared in `.github/infra.yaml`; review them with `gh infra plan` and apply them
with `gh infra apply`.
