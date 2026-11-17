// A manual check of context compaction (compaction-check.ts): the real Worker in wrangler's local runtime with containers
// on, the GitHub App and a model configured with a small window (the owner's check uses MODEL_CONTEXT_TOKENS 20000), and
// a real pull request of a public repository the App is installed on. It checks four things and prints the proof of
// each:
// 1. Questions about the code (the first states a decision in the author's words) go on until the context passes the
//    window less the reserve, and a compaction starts whose cut lies after the decision (after a commit, or at a turn's
//    start when the question takes the context over), and is adopted (the notes written, their revision advanced).
// 2. The conversation the author sees is unchanged: get-messages taken when that compaction started equals, hashed, the
//    same messages taken after it, and no compaction_ message appears.
// 3. Questions asked while the summary runs wait, and are answered after it, in order; the second needs the early
//    decision and still uses it.
// 4. A provider refusal fails the job with the provider's reason: one question to a second Worker whose API key is
//    wrong (the provider refuses it, so nothing is spent), its reason with the key redacted and cut to 500 characters.

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { type PrRef, PrSessionView, sessionName } from "@prq/protocol";
import * as v from "valibot";

import { ask, deliver } from "./pr.ts";
import type { GithubApp } from "./reconcile.ts";
import { type ModelSettings, startWorker, type Worker } from "./worker.ts";
import { readPull, untilEnded, workspaceContainers } from "./workspace.ts";

const POLL_MS = 500;
// Longer than a summary call at its bounds, tried twice, and the turn after it.
const COMPACTION_MS = 10 * 60_000;
// The most code questions asked before the check gives up: each costs a model turn. Just under the limit a turn has
// little room for tool results, and its answer adds little, so several turns may pass before the count crosses it.
const MAX_QUESTIONS = 16;
// A wrong key in the provider's format: the provider refuses it before any model runs.
const WRONG_KEY = "sk-prq-check-wrong-key-000000000000";
// The name the decision fixes, and the question that needs it.
const NAME = "Kestrel";
const DECISION = `A decision for the rest of this conversation: refer to this pull request's change as a whole as "Project ${NAME}", and keep each answer to at most three sentences. Confirm it in one sentence.`;
const RECALL = "What name did I ask you to use for this pull request's change as a whole? Reply with that name only.";

const Files = v.array(v.object({ filename: v.string(), status: v.string(), changes: v.number() }));
const ContextRow = v.object({
  context_tokens: v.nullable(v.number()),
  context_through: v.nullable(v.string()),
  compaction_failed_through: v.nullable(v.string()),
});
const NotesRow = v.object({
  text: v.nullable(v.string()),
  rev: v.number(),
  cut_message_id: v.nullable(v.string()),
  cut_step: v.nullable(v.number()),
  read_files: v.string(),
});
const Messages = v.array(v.looseObject({ id: v.string(), role: v.string() }));

type Job = PrSessionView["jobs"][number];

// The window less the reserve (packages/server/src/pr-session/context-budget.ts): the context is compacted above it.
function contextLimit(window: number): number {
  return window - Math.min(16_384, Math.floor(window / 8));
}

// The pull request's changed files, largest first, from GitHub's API without credentials (a public repository).
async function changedFiles(pr: PrRef): Promise<string[]> {
  const res = await fetch(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=100`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "prq-compaction-check" },
  });
  if (res.status !== 200) {
    throw new Error(`GitHub answered ${res.status} for the pull request's files`);
  }
  return v
    .parse(Files, await res.json())
    .filter((file) => file.status !== "removed")
    .toSorted((a, b) => b.changes - a.changes)
    .map((file) => file.filename);
}

// The conversation as the UI loads it (get-messages), as it was sent.
async function messages(worker: Worker, pr: PrRef): Promise<unknown[]> {
  const res = await fetch(new URL(`/agents/pr-session/${sessionName(pr)}/get-messages`, worker.url()), {
    headers: { "Cf-Access-Jwt-Assertion": await worker.token() },
  });
  if (res.status !== 200) {
    throw new Error(`get-messages answered ${res.status}`);
  }
  const body: unknown = await res.json();
  return v.parse(v.array(v.unknown()), body);
}

function hash(list: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(list)).digest("hex").slice(0, 16);
}

function idsOf(list: unknown[]): string[] {
  return v.parse(Messages, list).map((message) => message.id);
}

function partsOf(list: unknown[], id: string) {
  const message = list.find((entry) => v.is(v.object({ id: v.literal(id) }), entry));
  return v.parse(
    v.object({ parts: v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })) }),
    message,
  ).parts;
}

function textOf(list: unknown[], id: string): string {
  return partsOf(list, id)
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

async function context(worker: Worker, pr: PrRef): Promise<v.InferOutput<typeof ContextRow>> {
  const [row] = await worker.sql(
    "PrSession",
    sessionName(pr),
    "SELECT context_tokens, context_through, compaction_failed_through FROM prq_session WHERE id = 1",
  );
  return v.parse(ContextRow, row);
}

async function notes(worker: Worker, pr: PrRef): Promise<v.InferOutput<typeof NotesRow>> {
  const [row] = await worker.sql(
    "PrSession",
    sessionName(pr),
    "SELECT text, rev, cut_message_id, cut_step, read_files FROM prq_notes WHERE id = 1",
  );
  return v.parse(NotesRow, row);
}

async function view(worker: Worker, pr: PrRef): Promise<PrSessionView> {
  const session = await worker.durableObject("PrSession", sessionName(pr));
  return v.parse(PrSessionView, await session["view"]?.());
}

function answerTo(id: string): (job: Job) => boolean {
  return (job) => job.target.kind === "answer" && job.target.messageId === id;
}

// The Worker's compaction and job log events since a line, one per line.
function events(worker: Worker, from: number, pattern: RegExp): string[] {
  return worker
    .logs()
    .slice(from)
    .filter((line) => pattern.test(line))
    .map((line) => line.replace(/\s+/g, " "));
}

// A field of a log line, as the Worker's log prints it (`name: 'value'` or `name: 1`).
function field(line: string, name: string): string {
  return new RegExp(`\\b${name}: '?([^',}\\s]*)`).exec(line)?.[1] ?? "";
}

// The message a compaction's start names as its cut, from its log line.
function cutOf(line: string): string {
  return field(line, "cutMessageId");
}

// Whether jobs started after a compaction ended, from the Worker's log lines from `from` on: the compaction's end is
// the done event with the job, notes revision and cut of its start (`started`), and each job's start is its
// prq.job.started event. Not when the end was not logged. The positions, -1 for one not logged.
export function startedAfterCompaction(
  lines: readonly string[],
  from: number,
  started: string,
  jobIds: readonly string[],
): { doneAt: number; startedAt: number[]; after: boolean } {
  const same = (line: string) =>
    ["jobId", "notesRev", "cutMessageId", "cutStep"].every((name) => field(line, name) === field(started, name));
  const doneAt = lines.findIndex((line, index) => index >= from && line.includes("prq.compaction.done") && same(line));
  const startedAt = jobIds.map((jobId) =>
    lines.findIndex(
      (line, index) => index >= from && line.includes("prq.job.started") && field(line, "jobId") === jobId,
    ),
  );
  return { doneAt, startedAt, after: doneAt >= 0 && startedAt.every((index) => index > doneAt) };
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

// Asks a question, then waits until its job ends or a compaction starts: at its turn's start, or after its commit when
// that took the count over the limit. The compaction's start, as its log line, or null.
async function askUntil(
  worker: Worker,
  pr: PrRef,
  id: string,
  text: string,
  limit: number,
  print: (line: string) => void,
): Promise<string | null> {
  print(`question ${id}: ${text}`);
  const from = worker.logs().length;
  await ask(worker, pr, id, text);
  const asked = Date.now();
  while (Date.now() - asked < COMPACTION_MS) {
    const [started] = events(worker, from, /prq\.compaction\.started/);
    if (started !== undefined) {
      return started;
    }
    const job = (await view(worker, pr)).jobs.find(answerTo(id));
    if (job?.state === "failed") {
      return null;
    }
    if (job?.state === "done") {
      const tokens = (await context(worker, pr)).context_tokens;
      if (tokens === null || tokens <= limit || events(worker, from, /prq\.compaction\.skipped/).length > 0) {
        return null;
      }
    }
    await sleep(POLL_MS);
  }
  return null;
}

// Waits for a question's job to end; prints how it ended, the count against the limit, and the notes' revision.
async function report(
  worker: Worker,
  pr: PrRef,
  id: string,
  limit: number,
  print: (line: string) => void,
): Promise<Job | undefined> {
  const job = await untilEnded(worker, pr, answerTo(id));
  const count = await context(worker, pr);
  const list = await messages(worker, pr);
  const done = job?.state === "done" ? `answer-${job.jobId}` : null;
  const answer = done === null ? (job?.failure ?? "") : firstLine(textOf(list, done));
  const tools = done === null ? [] : partsOf(list, done).filter((part) => part.type.startsWith("tool-"));
  print(`  ${job?.state ?? "no job"} (${tools.length} tool calls): ${answer}`);
  print(
    `  context count ${count.context_tokens ?? "estimated"} (limit ${limit}), notes rev ${(await notes(worker, pr)).rev}`,
  );
  return job;
}

// Waits until the notes' revision passes `rev` or a compaction failed since log line `from`.
async function untilCompacted(worker: Worker, pr: PrRef, rev: number, from: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < COMPACTION_MS) {
    if ((await notes(worker, pr)).rev > rev) {
      return true;
    }
    if (events(worker, from, /prq\.compaction\.(failed|skipped)/).length > 0) {
      return false;
    }
    await sleep(POLL_MS);
  }
  return false;
}

export type CompactionCheck = { app: GithubApp; model: ModelSettings };

export async function checkCompaction(
  settings: CompactionCheck,
  pr: PrRef,
  print: (line: string) => void,
): Promise<boolean> {
  const window = Number(settings.model.MODEL_CONTEXT_TOKENS);
  const limit = contextLimit(window);
  const pull = await readPull(pr);
  const files = await changedFiles(pr);
  print(
    `compaction check: ${pr.owner}/${pr.repo}#${pr.number} at head ${pull.head.sha}, model ${settings.model.MODEL_ID}, ` +
      `window ${window} (compacted above ${limit}); ${files.length} changed files`,
  );
  const results = { compacted: false, unchanged: false, queued: false, refused: false };
  const tracked = await workspaceContainers();
  const worker = await startWorker({ model: settings.model, githubApp: settings.app.settings, containers: true });
  try {
    print("step 1: the analysis, the decision, then code questions until a compaction is adopted after the decision");
    await deliver(worker, pr, {
      action: "opened",
      head: pull.head.sha,
      base: pull.base.sha,
      at: pull.updated_at,
      installation: settings.app.installationId,
    });
    await (await worker.durableObject("PrSession", sessionName(pr)))["settle"]?.();
    const analysis = await untilEnded(worker, pr, (job) => job.target.kind === "analysis");
    print(`  analysis: ${analysis?.state ?? "none"}${analysis?.failure == null ? "" : `: ${analysis.failure}`}`);
    const afterAnalysis = (await context(worker, pr)).context_tokens;
    print(`  context count ${afterAnalysis ?? "estimated"} (limit ${limit})`);
    // A compaction the analysis started ends before the decision is asked, so a later one summarizes the decision.
    if (afterAnalysis !== null && afterAnalysis > limit) {
      print(
        `  a compaction after the analysis: ${(await untilCompacted(worker, pr, 0, 0)) ? "adopted" : "not adopted"}`,
      );
    }

    const decisionFrom = worker.logs().length;
    if ((await askUntil(worker, pr, "decision", DECISION, limit, print)) !== null) {
      print(
        `  a compaction that keeps the decision: ${(await untilCompacted(worker, pr, 0, decisionFrom)) ? "adopted" : "not adopted"}`,
      );
    }
    const decided = await report(worker, pr, "decision", limit, print);
    if (decided?.state !== "done") {
      return false;
    }
    const decisionAnswer = `answer-${decided.jobId}`;
    let trigger: { before: unknown[]; rev: number; from: number; id: string; started: string } | null = null;
    for (let index = 0; index < MAX_QUESTIONS && trigger === null; index += 1) {
      const file = files[index % Math.max(files.length, 1)] ?? "README.md";
      const id = `code-${index + 1}`;
      const rev = (await notes(worker, pr)).rev;
      const from = worker.logs().length;
      const started = await askUntil(
        worker,
        pr,
        id,
        `Call the read_file tool now on ${file} (even if you read it before), and say in two sentences what it does in this pull request.`,
        limit,
        print,
      );
      if (started === null) {
        await report(worker, pr, id, limit, print);
        continue;
      }
      // A compaction started. It is the one checked when its cut follows the decision, which it then summarizes;
      // otherwise it is let end, and the questions go on.
      const before = await messages(worker, pr);
      const ids = idsOf(before);
      const at =
        (await view(worker, pr)).jobs.find(answerTo(id))?.state === "done" ? "after its commit" : "at its turn's start";
      const cut = ids.indexOf(cutOf(started));
      const decision = ids.indexOf(decisionAnswer);
      if (cut <= decision) {
        print(
          `  a compaction started ${at}; its cut (message ${cut + 1}) keeps the decision (message ${decision + 1})`,
        );
        print(`  that compaction: ${(await untilCompacted(worker, pr, rev, from)) ? "adopted" : "not adopted"}`);
        await report(worker, pr, id, limit, print);
        continue;
      }
      print(
        `  a compaction started ${at}; its cut (message ${cut + 1}) follows the decision (message ${decision + 1}) ` +
          `(get-messages ${hash(before)})`,
      );
      trigger = { before, rev, from, id, started };
    }
    if (trigger === null) {
      print(`step 1: NOT as expected: no compaction after ${MAX_QUESTIONS} code questions`);
      return false;
    }

    print("step 3: two questions asked while the summary runs");
    await ask(worker, pr, "queued-1", "Which file of this pull request did you read last? Answer with its path only.");
    await ask(worker, pr, "queued-2", RECALL);
    const waiting = (await view(worker, pr)).jobs.filter(
      (job) => answerTo("queued-1")(job) || answerTo("queued-2")(job),
    );
    const notesWhileQueued = await notes(worker, pr);
    const waitedDuringSummary =
      notesWhileQueued.rev === trigger.rev && waiting.length === 2 && waiting.every((job) => job.state === "pending");
    print(
      `  while the summary runs (notes rev ${notesWhileQueued.rev}): ${waiting.map((job) => job.state).join(", ")}` +
        (waitedDuringSummary ? "" : " (the summary had ended when the questions' requests returned)"),
    );

    const adopted = await untilCompacted(worker, pr, trigger.rev, trigger.from);
    const stored = await notes(worker, pr);
    const after = await messages(worker, pr);
    const ids = idsOf(after);
    const cutIndex = stored.cut_message_id === null ? -1 : ids.indexOf(stored.cut_message_id);
    const decisionIndex = ids.indexOf(decisionAnswer);
    const sections = (stored.text ?? "").split("\n").filter((line) => line.startsWith("## "));
    print(`  compaction: ${adopted ? "adopted" : "NOT adopted"}, notes rev ${trigger.rev} -> ${stored.rev}`);
    print(
      `  cut: ${stored.cut_message_id ?? "none"} step ${stored.cut_step ?? "-"} (message ${cutIndex + 1} of ${ids.length})`,
    );
    print(
      `  the decision's answer: message ${decisionIndex + 1}, ${decisionIndex < cutIndex ? "before" : "NOT before"} the cut`,
    );
    print(`  notes: ${(stored.text ?? "").length} characters, sections: ${sections.join(" | ")}`);
    const read = v.parse(v.array(v.string()), JSON.parse(stored.read_files));
    print(`  files read: ${read.join(", ") || "none"}`);
    for (const line of events(worker, 0, /prq\.compaction\./)) {
      print(`  ${line}`);
    }
    results.compacted = adopted && stored.rev > trigger.rev && decisionIndex >= 0 && decisionIndex < cutIndex;
    print(results.compacted ? "step 1: as expected" : "step 1: NOT as expected");

    print("step 2: the conversation the author sees is unchanged by the compaction");
    const prefix = after.slice(0, trigger.before.length);
    const added = idsOf(after).slice(trigger.before.length);
    print(`  get-messages when the compaction started: ${trigger.before.length} messages, ${hash(trigger.before)}`);
    print(`  the same messages after it: ${prefix.length} messages, ${hash(prefix)}; added since: ${added.join(", ")}`);
    const overlays = ids.filter((id) => id.startsWith("compaction_"));
    print(`  compaction_ messages: ${overlays.length}`);
    results.unchanged = hash(prefix) === hash(trigger.before) && overlays.length === 0;
    print(results.unchanged ? "step 2: as expected" : "step 2: NOT as expected");

    print(`the question the compaction started with (${trigger.id}):`);
    await report(worker, pr, trigger.id, limit, print);
    const first = await untilEnded(worker, pr, answerTo("queued-1"));
    const second = await untilEnded(worker, pr, answerTo("queued-2"));
    const final = await messages(worker, pr);
    const finalIds = idsOf(final);
    const order = [first, second].map((job) => (job === undefined ? -1 : finalIds.indexOf(`answer-${job.jobId}`)));
    const recall = second?.state === "done" ? textOf(final, `answer-${second.jobId}`) : "";
    const ordering = startedAfterCompaction(
      worker.logs(),
      trigger.from,
      trigger.started,
      [first, second].map((job) => job?.jobId ?? ""),
    );
    print(
      `  queued-1: ${first?.state ?? "none"}: ${first?.state === "done" ? firstLine(textOf(final, `answer-${first.jobId}`)) : ""}`,
    );
    print(`  queued-2: ${second?.state ?? "none"}: ${firstLine(recall)}`);
    print(`  answers at messages ${order.map((index) => index + 1).join(" and ")}`);
    print(
      `  the compaction's end: ${ordering.doneAt < 0 ? "NOT logged" : `log line ${ordering.doneAt}`}; the questions' ` +
        `jobs started at log lines ${ordering.startedAt.join(" and ")}, after it: ${ordering.after ? "yes" : "NO"}`,
    );
    for (const line of events(worker, trigger.from, /prq\.(compaction\.(done|failed)|job\.started)/)) {
      print(`  ${line}`);
    }
    results.queued =
      first?.state === "done" &&
      second?.state === "done" &&
      order[0] !== undefined &&
      order[1] !== undefined &&
      order[0] >= 0 &&
      order[0] < order[1] &&
      ordering.after &&
      recall.toLowerCase().includes(NAME.toLowerCase());
    print(
      results.queued
        ? `step 3: as expected${waitedDuringSummary ? "" : " (their requests returned after the summary, so their wait during it is not shown)"}`
        : "step 3: NOT as expected",
    );
  } finally {
    await worker.close();
    const { seen, removed } = await tracked.remove();
    print(`containers of this check: ${seen}, removed after the Worker closed: ${removed}`);
  }

  print("step 4: a provider refusal fails the job with the provider's reason (a second Worker, a wrong API key)");
  const refusing = await startWorker({ model: { ...settings.model, MODEL_API_KEY: WRONG_KEY } });
  try {
    const refusalPr: PrRef = { owner: "acme", repo: "widgets", number: 7 };
    await ask(refusing, refusalPr, "refused", "In one sentence: what is a pull request?");
    const job = await untilEnded(refusing, refusalPr, answerTo("refused"));
    const reason = job?.failure ?? "";
    print(`  job: ${job?.state ?? "none"}: ${reason}`);
    print(`  reason: ${reason.length} characters; holds the wrong key: ${reason.includes(WRONG_KEY)}`);
    results.refused =
      job?.state === "failed" &&
      /^provider refused the request \(HTTP 4\d\d\)/.test(reason) &&
      reason.length <= 500 &&
      !reason.includes(WRONG_KEY);
    print(results.refused ? "step 4: as expected" : "step 4: NOT as expected");
  } finally {
    await refusing.close();
  }

  const ok = results.compacted && results.unchanged && results.queued && results.refused;
  print(ok ? "as expected" : "NOT as expected");
  return ok;
}
