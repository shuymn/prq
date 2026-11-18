---
name: prq
description: The job loop of a prq local agent, run with the prq CLI. Use when this session is a prq local agent.
---

# prq local agent

This session answers prq jobs about the host's GitHub pull requests: an `analysis` (a summary of the pull request) or
an `answer` (the reply to a question about it). The `prq` command talks to the prq server; the host has put it on
`PATH` and set its environment (`PRQ_URL`, `PRQ_ACCESS_CLIENT_ID`, `PRQ_ACCESS_CLIENT_SECRET`, `PRQ_AGENT_ID`, and
`PRQ_HOME` and `PRQ_CLONE_ROOTS` when the host uses them). Run each command exactly as written here.

Each command prints one JSON line on stdout, whose `next` names the step to take next: `wait` step 2, `claim` step 3,
`context` step 4, `checkout` the checkout in step 4, `answer` step 5. Errors go to stderr as lines starting `prq:`.
The exit code comes first: the Rules below say what each failure leads to.

## Steps

1. **Start.** Run `prq reconcile` and go to the step its `next` names.
2. **Wait.** Run `prq wait` as a background command, one that keeps running after your turn and wakes you when it
   exits (in Claude Code, the Bash tool with `run_in_background`), and end your turn. When it exits:
   - 0 (`next` `claim`): step 3.
   - 2 (`next` `wait`): step 2.
   - 1: tell the host the `prq:` line from stderr, then step 2.
3. **Claim.** Run `prq claim`.
   - `"job": null`: step 2.
   - `next` `answer` (`"saved": true`: an answer to this job is already saved): step 5.
   - `next` `context`: step 4.
4. **Context.** Run `prq context`. Read the file at its `context` path (the pull request, its details, the job and the
   conversation) and, for an `answer` job, the question in the file at its `question` path. When its `prompt` is a
   path, read that file too: it is the host's prompt for this kind of job, and what you write in step 5 follows it.
   When its `next` is `checkout`, run `prq checkout` as a background command and go on when it exits (fetching a large
   repository can take up to 25 minutes). Its `path` is a worktree at the job's commit: read the code there by
   absolute paths, without `cd`, and leave its files as they are. Then step 5.
5. **Answer.** The job's `target.kind` (in each job the commands print, and in `context.json`) says what to write:
   `analysis` a summary of the pull request, `answer` the reply to the question. Write it to the `answer` path the
   commands print (`answer.md` in the job's directory). When the job's directory has no `context.json` yet, do step 4
   first. When the answer file already holds text, it may be unfinished, since a session can stop while writing: read
   it, and finish or rewrite it until it is complete. Then step 6.
6. **Submit.** Run `prq submit`.
   - 0 (`"status"` `accepted` or `duplicate`, `next` `wait`): the answer is stored. Step 2.
   - 4 (`"status": "dropped"`): the answer was not stored and is void; write nothing more for it. When `claim` is null,
     step 2; otherwise `claim` is the job now claimed: go to the step the submit result's top-level `next` names.
   - 1: run `prq submit` once more and handle its exit the same way; when it exits 1 again, tell the host the `prq:`
     line, then step 2.

## Rules

- **Exit 3**, from any command: the service token or the configuration is wrong, and only the host can fix it. Tell
  the host the `prq:` line and stop: start no other command, `prq wait` included.
- **Exit 4** from `prq context` or `prq checkout` (`"status": "stale_claim"`): the claim ended. Step 3.
- **Exit 1** from `prq checkout`: tell the host the `prq:` line, then do step 5 from the context alone. From `prq
  reconcile`, `prq claim` or `prq context`: run it once more; when it exits 1 again, tell the host the `prq:` line,
  then step 2.
- Every job ends at step 2, whatever its outcome: the wait in the background is what wakes this session for the next
  job. The one exception is exit 3.
- `prq claim` runs only at step 3. A claim made while a job is in progress ends that job's claim, and its answer can
  no longer be stored.
- How an answer reads (language, length, format) follows the job's prompt (step 4), then the host's instructions to
  this session.
