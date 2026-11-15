// Check 3: does Pi-style compaction keep a long PR Q&A conversation answerable?
// Usage: node check-compaction.mjs [--window 32000] [--reserve 4000] [--keep 8000] [--model deepseek-flash]
// Reads the DeepSeek key from KEY_FILE below at runtime only. Outputs go to out/.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { valibotSchema } from "@ai-sdk/valibot";
import { stepCountIs, streamText, tool } from "ai";
import * as v from "valibot";
import {
  buildContext, compact, contextTokens, estimateText, estimateTokens, initialState,
  prepareCompaction, shouldCompact, toolOutputText,
} from "./compaction.mjs";

const KEY_FILE = process.env.DEEPSEEK_API_KEY_FILE; // path to a file holding the API key
const { values: args } = parseArgs({
  options: {
    window: { type: "string", default: "32000" },
    reserve: { type: "string", default: "4000" },
    keep: { type: "string", default: "8000" },
    model: { type: "string", default: "deepseek-flash" },
    budget: { type: "string", default: "2800000" },
    turns: { type: "string" }, // limit turns (smoke test)
    probes: { type: "string" }, // limit probes (smoke test)
    "skip-tool-probes": { type: "boolean", default: false },
  },
});
const settings = { contextWindow: +args.window, reserveTokens: +args.reserve, keepRecentTokens: +args.keep };
const TOKEN_BUDGET = +args.budget;
const OUT = new URL(`./out/run-${settings.contextWindow / 1000}k-${settings.reserveTokens / 1000}k-${settings.keepRecentTokens / 1000}k/`, import.meta.url).pathname;
mkdirSync(`${OUT}summaries`, { recursive: true });

const provider = createOpenAICompatible({
  name: "deepseek",
  baseURL: "https://api.deepseek.com/v1",
  apiKey: readFileSync(KEY_FILE, "utf8").trim(),
});
const model = provider(args.model);

// ---------------------------------------------------------------------------
// Usage accounting
// ---------------------------------------------------------------------------
const totals = { calls: 0, input: 0, output: 0, cacheRead: 0 };
function addUsage(u) {
  if (!u) return;
  totals.calls++;
  totals.input += u.inputTokens ?? 0;
  totals.output += u.outputTokens ?? 0;
  totals.cacheRead += u.inputTokenDetails?.cacheReadTokens ?? 0;
}
// Checked between calls (never mid-call) so a run that reaches the budget still writes its outputs.
const overBudget = () => totals.input + totals.output > TOKEN_BUDGET;

// ---------------------------------------------------------------------------
// Workspace: a real diff (honojs/hono v4.10.0..v4.11.0, src/**/*.ts without tests)
// ---------------------------------------------------------------------------
const fixture = JSON.parse(readFileSync(new URL("./fixtures/hono-v4.10.0-v4.11.0.json", import.meta.url), "utf8"));
const diffs = fixture.diffs;
const READ_MAX = 12000;
const toolLog = [];
const tools = {
  list_files: tool({
    description: "List the files changed in this PR with added/removed line counts.",
    inputSchema: valibotSchema(v.object({})),
    execute: async () => {
      toolLog.push({ tool: "list_files" });
      return Object.entries(diffs).map(([p, d]) => {
        const lines = d.split("\n");
        const add = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
        const del = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
        return `${p} +${add} -${del}`;
      }).join("\n");
    },
  }),
  read_file: tool({
    description: `Read the unified diff of one changed file. Long diffs are returned in chunks of ${READ_MAX} characters; pass offset to continue.`,
    inputSchema: valibotSchema(v.object({ path: v.string(), offset: v.optional(v.number()) })),
    execute: async ({ path, offset = 0 }) => {
      toolLog.push({ tool: "read_file", path, offset });
      const d = diffs[path];
      if (!d) return `ERROR: ${path} is not a changed file. Use list_files.`;
      const chunk = d.slice(offset, offset + READ_MAX);
      const rest = d.length - offset - chunk.length;
      return rest > 0 ? `${chunk}\n[... ${rest} more characters; call read_file with offset=${offset + READ_MAX}]` : chunk;
    },
  }),
  grep: tool({
    description: "Search the PR diff with a JavaScript regular expression. Returns up to 60 matches as path:line:text.",
    inputSchema: valibotSchema(v.object({ pattern: v.string() })),
    execute: async ({ pattern }) => {
      toolLog.push({ tool: "grep", pattern });
      let re;
      try { re = new RegExp(pattern); } catch (e) { return `ERROR: invalid regex: ${e.message}`; }
      const out = [];
      for (const [p, d] of Object.entries(diffs)) {
        d.split("\n").forEach((l, i) => { if (out.length < 60 && re.test(l)) out.push(`${p}:${i + 1}:${l.slice(0, 200)}`); });
      }
      return out.length ? out.join("\n") : "(no matches)";
    },
  }),
};
const SYSTEM = `You are an assistant that helps the user review a pull request. The PR is ${fixture.repo} ${fixture.base}..${fixture.head} (src/**/*.ts, tests excluded).
Use the tools (list_files, read_file, grep) to inspect the diff before answering code questions. Answer in Japanese.

Commits in this PR:
${fixture.log}`;
const SYSTEM_EST = estimateText(SYSTEM) + 300; // + tool definitions

// ---------------------------------------------------------------------------
// Scripted conversation and ground truth
// ---------------------------------------------------------------------------
const TURNS = [
  "hono の v4.10.0 → v4.11.0 の差分を 1 つの PR としてレビューしたい。まず list_files で変更ファイルを見て、全体像を教えて。それと、これから先の回答は全部、箇条書きで 5 行以内にしてほしい。",
  "先に決めておくと、src/types.ts の型の大改修（CurrentPath への置き換え）は、この PR のレビューでは対象外にする。別 PR で見る。では cache ミドルウェア（src/middleware/cache/index.ts）の差分を読んで、何が変わったか教えて。",
  "src/utils/jwt/jwt.ts と src/utils/jwt/types.ts の差分を読んで、aud の検証がどう入ったか、失敗時にどの例外クラスが投げられるかを教えて。",
  "aud を指定しないと検証が行われない（既定で無効）のは、このままでいい。そのリスクは受け入れることにする。次に bearer-auth の差分を読んで。それと、noAuthenticationHeader / invalidAuthenticationHeader / invalidToken みたいな新しいオプションは、説明文では『入れ子オプション』と呼ぶことに統一する。",
  "timing ミドルウェアに追加された関数を読んで、シグネチャと動きを教えて。ちなみにマージはフリーズ明けの 12月1日以降にする予定。",
  "context-storage の変更を見て。それと aws-lambda の Lattice 対応はうちでは使わないので、説明文には 1 行だけ書くことにする。",
  "client の変更（src/client/client.ts、src/client/types.ts、src/client/utils.ts）を読んで、buildSearchParams がどう使われるか教えて。",
  "src/helper/factory/index.ts の差分を詳しく読んで、createHandlers 周りで何が変わったか教えて。",
  "予定変更: マージはフリーズ明けの 12月1日ではなく、12月8日以降にする。では src/hono-base.ts と src/context.ts の差分を読んで、挙動が変わるところはある？",
  "src/validator/validator.ts と src/utils/body.ts の変更を読んで。",
  "csrf の非同期対応（src/middleware/csrf/index.ts）を読んで。既存の同期のハンドラを渡している利用者に影響はある？",
  "secure-headers と cors の差分を確認して。CSP の report-to はどう指定する？",
  "linear-router と reg-exp-router の修正を読んで、何のバグを直したのか教えて。",
  "src/helper/websocket/index.ts と src/adapter/bun の変更を読んで。",
  "src/utils/cookie.ts と src/utils/url.ts の差分を読んで。",
  "jsx 周り（src/jsx/base.ts、src/jsx/utils.ts、src/jsx/dom/render.ts）の変更を確認して。",
];

// turn: index into TURNS where the item was established. expect: all groups must match (any alt per group).
const PROBES = [
  { id: "D1", kind: "decision", turn: 1, q: "src/types.ts の型の大きな変更（CurrentPath への置き換え）は、このレビューでどう扱うと決めましたか？", expect: [["対象外", "扱わない", "含めない", "別PR", "別のPR", "スコープ外"]] },
  { id: "D2", kind: "decision", turn: 3, q: "bearer-auth の noAuthenticationHeader などの新しいオプションを、説明文では何と呼ぶことにしましたか？", expect: [["入れ子オプション"]] },
  { id: "D3", kind: "decision", turn: 3, q: "jwt の verify で aud を指定しないと検証されない件は、どういう結論になりましたか？", expect: [["受け入れ", "許容", "このまま", "そのまま", "既定のまま"]] },
  { id: "D4", kind: "decision", turn: 0, q: "私が最初に頼んだ、回答の書き方の決まりは何でしたか？", expect: [["箇条書き"], ["5行", "五行"]] },
  { id: "D5", kind: "decision", turn: 5, q: "aws-lambda の Lattice 対応は、説明文でどう扱うと決めましたか？", expect: [["1行", "一行"]] },
  { id: "D6", kind: "decision", turn: 8, q: "マージはいつ以降にすることになっていますか？", expect: [["12月8日", "12/8"]] },
  { id: "F1", kind: "fact", turn: 1, q: "最初の方で確認した cache ミドルウェアの変更で、キャッシュしないことになったのはどんなときでしたか？", expect: [["vary"], ["*"]] },
  { id: "F2", kind: "fact", turn: 2, q: "jwt の aud の検証に失敗したときに投げられる例外クラスの名前を 2 つ挙げてください。", expect: [["jwtpayloadrequiresaud"], ["jwttokenaudience"]] },
  { id: "F3", kind: "fact", turn: 4, q: "timing ミドルウェアに追加された関数の名前と、その引数を教えてください。", expect: [["wraptime"], ["callable", "promise"]] },
  { id: "F4", kind: "fact", turn: 5, q: "context-storage に追加された関数の名前と、getContext との違いを教えてください。", expect: [["trygetcontext"], ["undefined"]] },
];
const MEMORY_ONLY = "\n\n（ツールは使わずに、これまでの会話の内容だけから答えてください。わからなければ「わからない」と答えてください。）";

function normalize(s) {
  return s.normalize("NFKC").toLowerCase().replace(/[\s　]/g, "");
}
function grade(answer, expect) {
  const a = normalize(answer);
  const misses = expect.filter((group) => !group.some((alt) => a.includes(normalize(alt))));
  return { pass: misses.length === 0, missing: misses.map((g) => g[0]) };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
const history = []; // display history (append-only)
let state = initialState();
let nextId = 0;
const metrics = { settings, model: args.model, fixture: { repo: fixture.repo, range: `${fixture.base}..${fixture.head}`, files: Object.keys(diffs).length, chars: Object.values(diffs).reduce((a, d) => a + d.length, 0) }, turns: [], compactions: [], estimateVsActual: [], probes: [] };
const turnStartIndex = []; // history index of each scripted user message

const hashHistory = () => createHash("sha256").update(JSON.stringify(history)).digest("hex");
const append = (msg, extra = {}) => history.push({ id: `m${nextId++}`, msg, gen: state.gen, ...extra });

function stripReasoning(msg) {
  if (msg.role !== "assistant" || typeof msg.content === "string") return msg;
  return { ...msg, content: msg.content.filter((p) => p.type !== "reasoning") };
}

class ContextOverflowError extends Error {}

async function runCompaction(trigger) {
  const prep = prepareCompaction(history, state, settings, SYSTEM);
  if (!prep) { console.log(`  [compaction:${trigger}] nothing to compact`); return false; }
  const before = hashHistory();
  const t0 = Date.now();
  let res;
  try {
    res = await compact(model, history, state, prep, { onUsage: addUsage });
  } catch (e) {
    // Design: on failure keep the saved summary and history unchanged.
    console.log(`  [compaction:${trigger}] FAILED: ${e.message}`);
    metrics.compactions.push({ trigger, failed: e.message });
    return false;
  }
  if (hashHistory() !== before) throw new Error("ASSERT: compaction modified the display history");
  state = res.state;
  const n = metrics.compactions.length + 1;
  const after = contextTokens(history, state, SYSTEM).tokens;
  writeFileSync(`${OUT}summaries/compaction-${n}.md`, state.summary);
  const rec = {
    n, trigger, tokensBefore: prep.tokensBefore, tokensAfterEstimate: after,
    summarizedRange: [prep.boundaryStart, prep.isSplitTurn ? prep.turnStart : prep.firstKept],
    firstKept: prep.firstKept, firstKeptRole: history[prep.firstKept].msg.role, isSplitTurn: prep.isSplitTurn,
    updatedPrevious: Boolean(prep.previousSummary), summaryChars: state.summary.length,
    summaryTokensEstimate: estimateText(state.summary), ms: Date.now() - t0, calls: res.calls,
    historyLength: history.length, historyUnchanged: true,
  };
  metrics.compactions.push(rec);
  console.log(`  [compaction ${n}:${trigger}] ${prep.tokensBefore} -> ~${after} tokens, keep from #${prep.firstKept} (${rec.firstKeptRole}${prep.isSplitTurn ? ", split turn" : ""}), ${rec.ms}ms`);
  return true;
}

async function streamTurn(turnNo) {
  const stepEstimates = [];
  const result = streamText({
    model,
    system: SYSTEM,
    messages: buildContext(history, state),
    tools,
    stopWhen: stepCountIs(8),
    prepareStep: ({ stepNumber, steps, messages }) => {
      // Estimate the step's context: last step usage + chars/4 of the tool results added since,
      // or (step 0) the projection estimate. Enforce the artificial window like a provider would.
      let tokens;
      if (stepNumber === 0) tokens = contextTokens(history, state, SYSTEM).tokens;
      else {
        const last = steps[steps.length - 1].usage;
        let lastAssistant = messages.length - 1;
        while (lastAssistant >= 0 && messages[lastAssistant].role !== "assistant") lastAssistant--;
        tokens = (last.inputTokens ?? 0) + (last.outputTokens ?? 0);
        for (const m of messages.slice(lastAssistant + 1)) tokens += estimateTokens(m);
      }
      let pureEstimate = SYSTEM_EST;
      for (const m of messages) pureEstimate += estimateTokens(m);
      stepEstimates[stepNumber] = { tokens, pureEstimate };
      if (tokens > settings.contextWindow) throw new ContextOverflowError(`context ${tokens} > window ${settings.contextWindow}`);
      return undefined;
    },
  });
  let error;
  for await (const part of result.fullStream) {
    if (part.type === "error") error = part.error;
  }
  if (error) throw error;
  const steps = await result.steps;
  const responseMessages = await result.responseMessages;
  steps.forEach((s, i) => {
    addUsage(s.usage);
    metrics.estimateVsActual.push({ turn: turnNo, step: i, actualInput: s.usage.inputTokens, charsDiv4Estimate: stepEstimates[i]?.pureEstimate });
  });
  return { steps, responseMessages, text: await result.text, finishReason: await result.finishReason };
}

async function runTurn(turnNo, text) {
  const t0 = Date.now();
  append({ role: "user", content: text });
  turnStartIndex[turnNo] = history.length - 1;
  // Check before processing a new question.
  const pre = contextTokens(history, state, SYSTEM);
  if (shouldCompact(pre.tokens, settings)) await runCompaction("before-question");
  let out;
  try {
    out = await streamTurn(turnNo);
  } catch (e) {
    if (!(e instanceof ContextOverflowError) && !String(e?.message).includes("context")) throw e;
    // Design: on a context-length error, compact and retry once.
    console.log(`  overflow: ${e.message}; compacting and retrying once`);
    metrics.turns.push({ turn: turnNo, overflowRetry: true });
    await runCompaction("overflow");
    try {
      out = await streamTurn(turnNo);
    } catch (e2) {
      console.log(`  T${turnNo} failed again after compaction: ${e2.message}`);
      metrics.turns.push({ turn: turnNo, failed: String(e2.message) });
      return;
    }
  }
  let k = 0;
  for (const m of out.responseMessages) {
    const msg = stripReasoning(m);
    if (msg.role === "assistant") append(msg, { usage: out.steps[k++]?.usage });
    else append(msg);
  }
  const used = out.steps.flatMap((s) => s.toolCalls.map((c) => `${c.toolName}(${c.input?.path ?? c.input?.pattern ?? ""})`));
  const post = contextTokens(history, state, SYSTEM);
  metrics.turns.push({ turn: turnNo, ms: Date.now() - t0, steps: out.steps.length, finishReason: out.finishReason, toolCalls: used, contextAfter: post.tokens, answerChars: out.text.length });
  console.log(`T${turnNo} ${Date.now() - t0}ms steps=${out.steps.length} tools=[${used.join(", ")}] ctx=${post.tokens}${post.usageBased ? "" : "(est)"}\n  > ${out.text.replace(/\n/g, " ").slice(0, 160)}`);
  // Check after the turn.
  if (shouldCompact(post.tokens, settings)) await runCompaction("after-turn");
}

// Naive control: keep the newest whole turns that fit in window - reserve, drop the rest. chars/4 is
// scaled by the actual/estimate ratio measured in this run so the control gets the same real budget.
function naiveContext(extraTokens, ratio) {
  const budget = (settings.contextWindow - settings.reserveTokens) / ratio - SYSTEM_EST - extraTokens;
  let start = history.length;
  let acc = 0;
  for (let t = turnStartIndex.length - 1; t >= 0; t--) {
    const s = turnStartIndex[t];
    let turnTokens = 0;
    for (let i = s; i < start; i++) turnTokens += estimateTokens(history[i].msg);
    if (acc + turnTokens > budget) break;
    acc += turnTokens;
    start = s;
  }
  return { start, messages: history.slice(start).map((e) => e.msg), tokens: Math.round((acc + SYSTEM_EST + extraTokens) * ratio) };
}

async function ask(messages, q, withTools) {
  const t0 = Date.now();
  const r = streamText({
    model, system: SYSTEM, messages: [...messages, { role: "user", content: q }], tools,
    toolChoice: withTools ? "auto" : "none", stopWhen: stepCountIs(6),
  });
  let error;
  for await (const p of r.fullStream) if (p.type === "error") error = p.error;
  if (error) throw error;
  const steps = await r.steps;
  steps.forEach((s) => addUsage(s.usage));
  return { text: await r.text, ms: Date.now() - t0, inputTokensFirstStep: steps[0]?.usage.inputTokens, toolCalls: steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const tStart = Date.now();
const nTurns = args.turns ? +args.turns : TURNS.length;
for (let i = 0; i < nTurns; i++) {
  if (overBudget()) { metrics.stoppedEarly = `budget reached before turn ${i}`; console.log(metrics.stoppedEarly); break; }
  await runTurn(i, TURNS[i]);
  writeFileSync(`${OUT}metrics.json`, JSON.stringify({ ...metrics, totals }, null, 2));
}
const historyHashAtEnd = hashHistory();
console.log(`\nconversation done: ${history.length} messages, ${metrics.compactions.filter((c) => !c.failed).length} compactions, ${totals.input + totals.output} tokens`);

// Probe phase
const ratios = metrics.estimateVsActual.filter((e) => e.actualInput && e.charsDiv4Estimate).map((e) => e.actualInput / e.charsDiv4Estimate).sort((a, b) => a - b);
const tokenRatio = ratios[Math.floor(ratios.length / 2)] ?? 1;
metrics.tokenRatioMedian = tokenRatio;
const naive = naiveContext(200, tokenRatio);
const keptCheck = PROBES.map((p) => ({
  id: p.id, turnIndex: turnStartIndex[p.turn],
  beforeCompactionCut: turnStartIndex[p.turn] < state.firstKept,
  beforeNaiveCut: turnStartIndex[p.turn] < naive.start,
}));
const notCut = keptCheck.filter((k) => !k.beforeCompactionCut || !k.beforeNaiveCut);
if (notCut.length) console.log(`WARNING: establishing turns still inside a kept window: ${JSON.stringify(notCut)}`);
// Informational: do the expected keywords appear anywhere in the kept raw messages (e.g. echoed later)?
const keptText = (msgs) => normalize(msgs.map((m) => JSON.stringify(m.content)).join("\n"));
const keptRaw = keptText(history.slice(state.firstKept).map((e) => e.msg));
const naiveRaw = keptText(naive.messages);

let summary;
function flush() {
  // Transcript (tool results truncated) for human review.
  const transcript = history.map((e, i) => ({
    i, id: e.id, role: e.msg.role, gen: e.gen,
    content: typeof e.msg.content === "string" ? e.msg.content : e.msg.content.map((p) =>
      p.type === "text" ? { text: p.text } : p.type === "tool-call" ? { call: p.toolName, input: p.input } : p.type === "tool-result" ? { result: toolOutputText(p.output).slice(0, 300) } : { [p.type]: true }),
  }));
  writeFileSync(`${OUT}transcript.json`, JSON.stringify(transcript, null, 1));
  writeFileSync(`${OUT}probes.md`, probesMd);
  summary = {
    compactions: metrics.compactions.filter((c) => !c.failed).length,
    failedCompactions: metrics.compactions.filter((c) => c.failed).length,
    historyMessages: history.length, finalFirstKept: state.firstKept, naiveStart: naive.start,
    keptCheck,
    memory: { compaction: metrics.probes.filter((p) => p.variant === "memory" && p.compaction.pass).length, naive: metrics.probes.filter((p) => p.variant === "memory" && p.naive.pass).length, of: PROBES.length },
    tools: { compaction: metrics.probes.filter((p) => p.variant === "tools" && p.compaction.pass).length, naive: metrics.probes.filter((p) => p.variant === "tools" && p.naive.pass).length, of: PROBES.filter((p) => p.kind === "fact").length },
    totalMs: Date.now() - tStart,
    tokenRatioMedian: tokenRatio,
    probeInputTokens: { compaction: metrics.probes[0]?.compaction.input, naive: metrics.probes[0]?.naive.input },
  };
  writeFileSync(`${OUT}metrics.json`, JSON.stringify({ ...metrics, summary, totals }, null, 2));
}
const compactCtx = buildContext(history, state);
console.log(`\nprobe contexts: compaction ~${contextTokens(history, state, SYSTEM).tokens} tokens (summary + ${history.length - state.firstKept} msgs), naive ~${naive.tokens} tokens (${naive.messages.length} msgs, from #${naive.start})`);
let probesMd = `# 確認 3 のプローブ回答\n\n設定: ${JSON.stringify(settings)}、モデル ${args.model}\n\n`;
for (const p of PROBES.slice(0, args.probes ? +args.probes : PROBES.length)) {
  const variants = [{ name: "memory", withTools: false, q: p.q + MEMORY_ONLY }];
  if (p.kind === "fact" && !args["skip-tool-probes"]) variants.push({ name: "tools", withTools: true, q: p.q });
  for (const vnt of variants) {
    if (overBudget()) { metrics.stoppedEarly = `budget reached before probe ${p.id}/${vnt.name}`; console.log(metrics.stoppedEarly); break; }
    const comp = await ask(compactCtx, vnt.q, vnt.withTools);
    const nai = await ask(naive.messages, vnt.q, vnt.withTools);
    const rec = {
      id: p.id, kind: p.kind, variant: vnt.name, q: p.q,
      compaction: { ...grade(comp.text, p.expect), ms: comp.ms, input: comp.inputTokensFirstStep, toolCalls: comp.toolCalls, answer: comp.text },
      naive: { ...grade(nai.text, p.expect), ms: nai.ms, input: nai.inputTokensFirstStep, toolCalls: nai.toolCalls, answer: nai.text },
      keywordsInKeptRaw: p.expect.every((g) => g.some((a) => keptRaw.includes(normalize(a)))),
      keywordsInNaiveRaw: p.expect.every((g) => g.some((a) => naiveRaw.includes(normalize(a)))),
    };
    metrics.probes.push(rec);
    console.log(`${p.id}/${vnt.name}: compaction=${rec.compaction.pass ? "PASS" : "FAIL"} naive=${rec.naive.pass ? "PASS" : "FAIL"}`);
    probesMd += `## ${p.id}（${vnt.name === "memory" ? "記憶のみ" : "ツールあり"}）\n\nQ: ${p.q}\n\n期待: ${p.expect.map((g) => g.join(" / ")).join(" かつ ")}\n\n### 圧縮あり: ${rec.compaction.pass ? "PASS" : "FAIL"}${rec.compaction.toolCalls.length ? `（ツール: ${rec.compaction.toolCalls.join(", ")}）` : ""}\n\n${comp.text}\n\n### 単純な切り捨て: ${rec.naive.pass ? "PASS" : "FAIL"}${rec.naive.toolCalls.length ? `（ツール: ${rec.naive.toolCalls.join(", ")}）` : ""}\n\n${nai.text}\n\n`;
    flush();
  }
}
if (hashHistory() !== historyHashAtEnd) throw new Error("ASSERT: probes modified the display history");

flush();
console.log(`\n${JSON.stringify(summary, null, 2)}\nusage: ${JSON.stringify(totals)} (input+output=${totals.input + totals.output})`);
