---
name: verify-prq
description: Run prq's local stack and drive a local agent through scripted jobs. Use when checking skills/prq/SKILL.md, or the prq CLI, against the real Worker.
---

# Verify prq with the local stack

The local stack (`packages/cli/src/test/local-stack.ts`) runs the real Worker through wrangler's test harness behind
the stand-in for Access, with a repository fixture for `acme/widgets#7`, all on loopback and in one temporary directory.
Nothing reaches the network and nothing is deployed. A local agent (an AI session given `skills/prq/SKILL.md`, or the
compiled `prq` driven by hand) works against it while the stack pushes scripted jobs and records every request per
agent.

## Start

1. `pnpm run build` in `packages/cli` (needs Bun from `mise.toml`): the binary `packages/cli/dist/prq`.
2. `pnpm run stack` in `packages/cli`, as a background command, its output saved to a file. It is ready when it has
   printed the `Control:` line: before that it prints the Worker's address, the session's environment (`export` lines,
   also written to `session.env` in its temporary directory) and the control URL. A failure to start ends it with the
   error and removes what it had made.
3. Check that the environment is the stack's before a session uses it: `PRQ_URL` is the printed `http://127.0.0.1:<port>`
   and `PATH` starts with this checkout's `packages/cli/dist`. Then run `prq reconcile` with it: exit 0 and
   `"next":"wait"` means the stack answers as the Worker does.

## Run a session

The session runs in a directory of its own with the environment exported (`set -a; source <dir>/session.env; set +a`)
and with `skills/prq/SKILL.md` as its only instruction about prq (for Claude Code, link `skills/prq` into the
directory's `.claude/skills/`). The session uses the agent ID `local-session`; the stack's other agent is
`other-agent`. Driving it by hand, run each command the SKILL names, `prq wait` in the background.

## Push the jobs

`curl -s -X POST <control>/<command>` while the session's `prq wait` is in flight, one job at a time, each after the
session has gone back to `prq wait`. Each command prints what it did, and the stack's output marks it with the time.

| Command    | The job                                                                                                                                           | What the session does                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `analysis` | A push of a new head: an analysis                                                                                                                 | claim, context, checkout, answer, submit (`accepted`), wait                                         |
| `question` | A question at the current head                                                                                                                    | the same, reading `question.md`                                                                     |
| `taken`    | A push that `other-agent` claims and submits at once                                                                                              | claim (`"job": null`), wait                                                                         |
| `retry`    | A push the host retries as soon as the session has read its context                                                                               | submit `dropped` (`stale_claim`, exit 4), then context, checkout, answer, submit (`accepted`), wait |
| `restart`  | Refused while the session waits: stop the session first. The stack then claims a new head as `local-session` and leaves an unfinished `answer.md` | a fresh session: reconcile (`"next":"answer"`, `"saved":true`), finish the answer, submit, wait     |

A session that is told nothing else should do exactly the right column. Exit 3 from any command means the environment
is wrong, not the procedure.

## Read the result

`curl -s <control>/log` prints the stand-in's requests per agent, each with its time, route and status (`in flight`
while open, `cut off` when the client went away first), with the stack's markers between them. The check passes when,
after each job's last request (`/cli/submit` answered 200, or the `/cli/claim` that found no job), the session's next
request is a `/cli/wait` that is `in flight` while the session is idle. Save the log and the stack's output before
stopping it: both go with the stack's temporary directory.

## Stop

Stop the session (its `prq wait` with it), then `curl -s -X POST <control>/stop`, or SIGINT or SIGTERM to the stack's
`node` process. It closes its control server, its own `prq` runs, the stand-in and the Worker's runtime, removes its
temporary directory, prints `stopped` and exits. Then check that its `node` process and the `workerd` and `esbuild`
processes it started are gone, and that the directory `session.env` was in no longer exists.
