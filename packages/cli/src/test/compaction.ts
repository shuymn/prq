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
// With host prompts (saved through PUT /api/prompts/:kind before the analysis), also:
// - prompts: each request the Worker sent to the model holds only its own kind's prompt: an analysis turn's the
//   analysis prompt, an answer turn's the answer prompt, and a summary request neither.
// - the analysis (with `--analysis-language ja|en`, the language the analysis prompt asks for): its stored text's
//   prose in that language by the languages' measure below, in the verdict.
// - languages (with an answer prompt; reported apart from the check's verdict, since only a prompt such as "Answer in
//   the language of the question." asks for it): one question in each language at the end, and each answer's prose,
//   its letters outside code, headings, links and markup: at least 200, Japanese scripts at least half of the
//   Japanese answer's, Latin at least nine tenths of the English answer's.

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { type PrRef, type PrSessionView, sessionName } from "@prq/protocol";
import * as v from "valibot";

import { contextLimit } from "../../../server/src/pr-session/context-budget.ts";
import { UsageError } from "./app-check.ts";
import { ask, deliver, getMessages, savePrompt, sessionView } from "./pr.ts";
import type { GithubApp } from "./reconcile.ts";
import { type ModelRequest, type ModelSettings, startWorker, type Worker } from "./worker.ts";
import { readPull, untilEnded, workspaceContainers } from "./workspace.ts";

const POLL_MS = 500;
// Longer than a summary call at its bounds, tried twice, and the turn after it.
const COMPACTION_MS = 10 * 60_000;
// The most code questions asked before the check gives up: each costs a model turn. Just under the limit a turn has
// little room for tool results, and its answer adds little, so several turns may pass before the count crosses it.
const MAX_QUESTIONS = 16;
// A wrong key in the provider's format: the provider refuses it before any model runs.
const WRONG_KEY = "sk-prq-check-wrong-key-000000000000";
// The name the decision fixes; the recall question needs it.
const NAME = "Kestrel";

type Language = "english" | "japanese";

// The check's questions in one language: the decision, a code question about a file, the question about the last file
// read, the recall of the decision's name, and the question of the languages step.
type Questions = {
  language: Language;
  decision: string;
  code: (file: string) => string;
  lastFile: string;
  recall: string;
  explain: string;
};

export const ENGLISH: Questions = {
  language: "english",
  decision: `A decision for the rest of this conversation: refer to this pull request's change as a whole as "Project ${NAME}", and keep each answer to at most three sentences. Confirm it in one sentence.`,
  code: (file) =>
    `Call the read_file tool now on ${file} (even if you read it before), and say in two sentences what it does in this pull request.`,
  lastFile: "Which file of this pull request did you read last? Answer with its path only.",
  recall: "What name did I ask you to use for this pull request's change as a whole? Reply with that name only.",
  explain:
    "For this question only, the three-sentence limit does not apply: in one paragraph of at least six sentences, explain what this pull request changes and why. Use no code blocks.",
};

export const JAPANESE: Questions = {
  language: "japanese",
  decision: `この会話の残りについての決定事項です。このプルリクエストの変更全体を「Project ${NAME}」と呼び、各回答は3文以内にしてください。確認を1文で答えてください。`,
  code: (file) =>
    `今すぐ read_file ツールで ${file} を読み（前に読んでいても）、このプルリクエストでそのファイルが何をしているかを2文で説明してください。`,
  lastFile: "このプルリクエストのファイルで最後に読んだのはどれですか。パスだけを答えてください。",
  recall: "このプルリクエストの変更全体を何と呼ぶよう頼みましたか。その名前だけを答えてください。",
  explain:
    "この質問に限り3文以内の制限は適用しません。このプルリクエストが何をなぜ変えるのかを、6文以上の1段落で説明してください。コードブロックは使わないでください。",
};

// The host's prompts the check saves before the analysis; empty for one it leaves unsaved.
export type Prompts = { analysis: string; answer: string };

// How a run goes: the push's analysis alone or the whole check, and the language expected of the analysis.
export type Run = { analysisOnly: boolean; analysisLanguage: Language | null };

type Steps = { compacted: boolean; unchanged: boolean; queued: boolean; refused: boolean; prompts: boolean };

// What a request the Worker sent to the model is, by its system message: a turn of the analysis or of an answer (by
// the job's line), a summary request (the summarizer's system prompt, SUMMARIZATION_SYSTEM_PROMPT in
// packages/server/src/pr-session/compaction.ts, which imports workerd's types), or neither.
type RequestKind = "analysis" | "answer" | "summary" | "other";

const RequestBody = v.looseObject({
  messages: v.array(v.looseObject({ role: v.string(), content: v.unknown() })),
});

function systemOf(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const request = v.safeParse(RequestBody, parsed);
  const [first] = request.success ? request.output.messages : [];
  return first?.role === "system" && typeof first.content === "string" ? first.content : null;
}

function requestKind(system: string | null): RequestKind {
  if (system === null) {
    return "other";
  }
  if (system.startsWith("You are a context summarization assistant.")) {
    return "summary";
  }
  if (system.includes("\nYour job: summarize the pull request at head ")) {
    return "analysis";
  }
  return system.includes("\nYour job: answer the last question") ? "answer" : "other";
}

// Whether a request's body holds a prompt, as JSON escapes it.
function inBody(body: string, prompt: string): boolean {
  return prompt !== "" && body.includes(JSON.stringify(prompt).slice(1, -1));
}

// Whether each request holds only its own kind's prompt: a turn's system message holds its kind's prompt in the host's
// block (when that prompt is saved), and no request holds the other prompt anywhere in its body (as JSON escapes it).
// The counts of each kind, and a line for each request that does not hold.
export function promptsHeld(
  requests: readonly ModelRequest[],
  prompts: Prompts,
): { counts: Record<RequestKind, number>; wrong: string[] } {
  const counts: Record<RequestKind, number> = { analysis: 0, answer: 0, summary: 0, other: 0 };
  const wrong: string[] = [];
  requests.forEach(({ body }, index) => {
    const system = systemOf(body);
    const kind = requestKind(system);
    counts[kind] += 1;
    const own = kind === "analysis" || kind === "answer" ? prompts[kind] : "";
    const others = (["analysis", "answer"] as const).filter((other) => other !== kind && inBody(body, prompts[other]));
    const block = `\n<host-instructions>\n${own}\n</host-instructions>\n`;
    if (kind === "other") {
      wrong.push(`request ${index + 1}: neither a turn nor a summary request`);
    } else if (own !== "" && !(system ?? "").includes(block)) {
      wrong.push(`request ${index + 1} (${kind}): its system message does not hold the ${kind} prompt`);
    } else if (others.length > 0) {
      wrong.push(`request ${index + 1} (${kind}): holds the ${others.join(" and ")} prompt`);
    }
  });
  return { counts, wrong };
}

// The letters of an answer's prose, outside fenced code blocks, code spans, heading lines, link targets, URLs and HTML
// tags, and how many are in Japanese scripts (Hiragana, Katakana, Han, and the letters they share, such as ー) and in Latin. List
// markers and other markup hold no letters.
export function proseLetters(text: string): { letters: number; japanese: number; latin: number } {
  let fence: string | null = null;
  const prose: string[] = [];
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    if (!HEADING.test(line)) {
      prose.push(line);
    }
  }
  const stripped = prose
    .join("\n")
    .replace(/`[^`\n]*`/g, "")
    .replace(/\]\([^)\s]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>\n]*>/g, "");
  const count = (pattern: RegExp) => stripped.match(pattern)?.length ?? 0;
  return {
    letters: count(/\p{L}/gu),
    japanese: count(/(?=\p{L})[\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Han}]/gu),
    latin: count(/\p{sc=Latin}/gu),
  };
}

// Whether an answer's prose is in the language: at least 200 letters, Japanese scripts at least half of them for
// Japanese, Latin at least nine tenths for English.
export function inLanguage(text: string, language: Questions["language"]): { ok: boolean; line: string } {
  const { letters, japanese, latin } = proseLetters(text);
  const share = (part: number) => (letters === 0 ? 0 : part / letters);
  const ok = letters >= 200 && (language === "japanese" ? share(japanese) >= 0.5 : share(latin) >= 0.9);
  return {
    ok,
    line: `${letters} letters of prose, Japanese ${share(japanese).toFixed(2)}, Latin ${share(latin).toFixed(2)}`,
  };
}

// The language the analysis is expected in, as `--analysis-language` gives it (ja or en), or null when none is. Any
// other value is a usage error.
export function analysisLanguage(option: string | undefined): Language | null {
  switch (option) {
    case undefined:
      return null;
    case "ja":
      return "japanese";
    case "en":
      return "english";
    default:
      throw new UsageError(`--analysis-language takes ja or en, not ${option}`);
  }
}

// Whether the analysis's stored text is in the language expected of it, by the languages' measure; any text is when
// none is expected.
function analysisIn(summary: string, language: Language | null): boolean {
  return language === null || inLanguage(summary, language).ok;
}

// The analysis-only run's verdict: the analysis done, with text, no tool call written as text, and in the expected
// language.
export function analysisOnlyVerdict(state: string | undefined, summary: string, language: Language | null): boolean {
  return state === "done" && summary.trim() !== "" && !TOOL_CALL_MARKUP.test(summary) && analysisIn(summary, language);
}

// The check's verdict: its four steps and the prompts as expected, and the analysis in the expected language.
export function checkVerdict(steps: Steps, summary: string, language: Language | null): boolean {
  return (
    steps.compacted &&
    steps.unchanged &&
    steps.queued &&
    steps.refused &&
    steps.prompts &&
    analysisIn(summary, language)
  );
}

// A Markdown heading line, at any level.
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;

// A tool call written as text: DeepSeek's markup (`<｜｜DSML｜｜ …>`, `<｜tool▁calls▁begin｜>`) or a generic tag.
const TOOL_CALL_MARKUP = /<｜|DSML|<\/?(?:tool_calls?|function_calls?|invoke)\b/i;

// Each heading of a text with the first non-blank line under it, up to the next heading.
function outline(text: string): string[] {
  const lines = text.split("\n");
  return lines.flatMap((line, index) => {
    if (!HEADING.test(line)) {
      return [];
    }
    const after = lines.slice(index + 1);
    const end = after.findIndex((next) => HEADING.test(next));
    const under = (end < 0 ? after : after.slice(0, end)).find((next) => next.trim() !== "");
    return [`${line.trim()} / ${under === undefined ? "(empty)" : firstLine(under)}`];
  });
}

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
  return v.parse(v.array(v.unknown()), await getMessages(worker, pr));
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
    const job = (await sessionView(worker, pr)).jobs.find(answerTo(id));
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

// Waits for a question's job to end; prints how it ended, the provider's raw measurement against the limit, and the
// notes' revision.
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
    `  the provider's raw measurement ${count.context_tokens ?? "none"} (limit ${limit}), notes rev ${(await notes(worker, pr)).rev}`,
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
  questions: Questions,
  prompts: Prompts,
  { analysisOnly, analysisLanguage: expected }: Run,
): Promise<boolean> {
  const window = Number(settings.model.MODEL_CONTEXT_TOKENS);
  const limit = contextLimit(window);
  const pull = await readPull(pr);
  const files = await changedFiles(pr);
  print(
    `compaction check: ${pr.owner}/${pr.repo}#${pr.number} at head ${pull.head.sha}, model ${settings.model.MODEL_ID}, ` +
      `window ${window} (compacted above ${limit}); ${files.length} changed files`,
  );
  const prompted = prompts.analysis !== "" || prompts.answer !== "";
  const results: Steps = { compacted: false, unchanged: false, queued: false, refused: false, prompts: !prompted };
  let summary = "";
  let languages: boolean | null = null;
  const tracked = await workspaceContainers();
  const worker = await startWorker({ model: settings.model, githubApp: settings.app.settings, containers: true });
  try {
    for (const kind of ["analysis", "answer"] as const) {
      if (prompts[kind] !== "") {
        await savePrompt(worker, kind, prompts[kind]);
        print(`the ${kind} prompt saved: ${prompts[kind]}`);
      }
    }
    print(
      analysisOnly
        ? "the push's analysis alone"
        : "step 1: the analysis, the decision, then code questions until a compaction is adopted after the decision",
    );
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
    summary = analysis?.state === "done" ? textOf(await messages(worker, pr), `analysis-${analysis.jobId}`) : "";
    if (analysisOnly) {
      const markup = TOOL_CALL_MARKUP.test(summary);
      print(`  the analysis's stored text: ${summary.length} characters; ${inLanguage(summary, "japanese").line}`);
      print(`  tool-call markup in it: ${markup ? "yes" : "no"}`);
      print(`  its first 400 characters: ${summary.slice(0, 400).replace(/\s+/g, " ")}`);
      const ok = analysisOnlyVerdict(analysis?.state, summary, expected);
      print(ok ? "as expected" : "NOT as expected");
      return ok;
    }
    if (analysis?.state === "done" && prompts.analysis !== "") {
      print(`  the analysis: ${inLanguage(summary, "japanese").line}; ${firstLine(summary)}`);
    }
    if (expected !== null) {
      print(`  the analysis in ${expected}: ${analysisIn(summary, expected) ? "as expected" : "NOT as expected"}`);
    }
    // The provider's measurement of the analysis's last request, as stored. The Worker's count after the commit can be
    // higher (it adds the tool definitions a step without tools left out), but the Worker logs nothing when it does
    // not compact, so the wait below starts only when this raw measurement is over the limit.
    const afterAnalysis = (await context(worker, pr)).context_tokens;
    print(`  the provider's raw measurement ${afterAnalysis ?? "none"} (limit ${limit})`);
    // A compaction the analysis started ends before the decision is asked, so a later one summarizes the decision.
    if (afterAnalysis !== null && afterAnalysis > limit) {
      print(
        `  a compaction after the analysis: ${(await untilCompacted(worker, pr, 0, 0)) ? "adopted" : "not adopted"}`,
      );
    }

    const decisionFrom = worker.logs().length;
    if ((await askUntil(worker, pr, "decision", questions.decision, limit, print)) !== null) {
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
      const started = await askUntil(worker, pr, id, questions.code(file), limit, print);
      if (started === null) {
        await report(worker, pr, id, limit, print);
        continue;
      }
      // A compaction started. It is the one checked when its cut follows the decision, which it then summarizes;
      // otherwise it is let end, and the questions go on.
      const before = await messages(worker, pr);
      const ids = idsOf(before);
      const at =
        (await sessionView(worker, pr)).jobs.find(answerTo(id))?.state === "done"
          ? "after its commit"
          : "at its turn's start";
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
    await ask(worker, pr, "queued-1", questions.lastFile);
    await ask(worker, pr, "queued-2", questions.recall);
    const waiting = (await sessionView(worker, pr)).jobs.filter(
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
    print(`  compaction: ${adopted ? "adopted" : "NOT adopted"}, notes rev ${trigger.rev} -> ${stored.rev}`);
    print(
      `  cut: ${stored.cut_message_id ?? "none"} step ${stored.cut_step ?? "-"} (message ${cutIndex + 1} of ${ids.length})`,
    );
    print(
      `  the decision's answer: message ${decisionIndex + 1}, ${decisionIndex < cutIndex ? "before" : "NOT before"} the cut`,
    );
    print(`  notes: ${(stored.text ?? "").length} characters; each heading with its first line:`);
    for (const line of outline(stored.text ?? "")) {
      print(`    ${line}`);
    }
    const read = v.parse(v.array(v.string()), JSON.parse(stored.read_files));
    print(`  files read: ${read.join(", ") || "none"}`);
    for (const line of events(worker, 0, /prq\.compaction\./)) {
      print(`  ${line}`);
    }
    results.compacted =
      adopted &&
      stored.rev > trigger.rev &&
      decisionIndex >= 0 &&
      decisionIndex < cutIndex &&
      outline(stored.text ?? "").length > 0;
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

    if (prompts.answer !== "") {
      print("languages: a question in each language, each answer's prose (reported apart from the verdict)");
      const asked = questions.language === "japanese" ? [ENGLISH, JAPANESE] : [JAPANESE, ENGLISH];
      languages = true;
      for (const language of asked) {
        const id = `language-${language.language}`;
        print(`question ${id}: ${language.explain}`);
        await ask(worker, pr, id, language.explain);
        const job = await untilEnded(worker, pr, answerTo(id));
        const text = job?.state === "done" ? textOf(await messages(worker, pr), `answer-${job.jobId}`) : "";
        const measured = inLanguage(text, language.language);
        languages &&= measured.ok;
        print(`  ${job?.state ?? "no job"}: ${measured.line}: ${measured.ok ? "as expected" : "NOT as expected"}`);
        print(`  ${firstLine(text || (job?.failure ?? ""))}`);
      }
      print(languages ? "languages: as expected" : "languages: NOT as expected");
    }

    if (prompted) {
      print("prompts: each model request holds only its own kind's prompt");
      const { counts, wrong } = promptsHeld(worker.modelRequests(), prompts);
      print(
        `  ${worker.modelRequests().length} requests: ${counts.analysis} of the analysis, ${counts.answer} of answers, ` +
          `${counts.summary} summary requests, ${counts.other} other`,
      );
      for (const line of wrong) {
        print(`  ${line}`);
      }
      results.prompts =
        wrong.length === 0 && counts.analysis > 0 && counts.answer > 0 && counts.summary > 0 && counts.other === 0;
      print(results.prompts ? "prompts: as expected" : "prompts: NOT as expected");
    }
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

  const ok = checkVerdict(results, summary, expected);
  print(
    `${ok ? "as expected" : "NOT as expected"}${languages === null ? "" : `; languages: ${languages ? "as expected" : "NOT as expected"}`}`,
  );
  return ok;
}
