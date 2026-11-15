// Check 1: does an OpenAI-compatible provider (DeepSeek) do tool calling + streaming
// through the AI SDK with valibot schemas? Usage: node check-tools.mjs <keyfile> <model>
import { readFileSync } from "node:fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { valibotSchema } from "@ai-sdk/valibot";
import { stepCountIs, streamText, tool } from "ai";
import * as v from "valibot";

const [keyFile, modelId] = process.argv.slice(2);
const provider = createOpenAICompatible({
  name: "deepseek",
  baseURL: "https://api.deepseek.com/v1",
  apiKey: readFileSync(keyFile, "utf8").trim(),
});

// Fake workspace that mimics the PR-analysis tools.
const files = {
  "src/auth.ts": "export function verify(token: string) {\n  return jose.jwtVerify(token, jwks, { audience: AUD });\n}\n",
  "src/routes.ts": "app.use('/api/*', accessAuth);\napp.post('/webhook', webhook);\n",
};
const calls = [];
const tools = {
  list_files: tool({
    description: "List all file paths in the PR workspace.",
    inputSchema: valibotSchema(v.object({})),
    execute: async () => { calls.push({ tool: "list_files" }); return Object.keys(files); },
  }),
  grep: tool({
    description: "Search the PR workspace for a regex. Returns matching lines as path:line:text.",
    inputSchema: valibotSchema(v.object({ pattern: v.string() })),
    execute: async ({ pattern }) => {
      calls.push({ tool: "grep", pattern });
      const re = new RegExp(pattern);
      return Object.entries(files).flatMap(([p, t]) =>
        t.split("\n").flatMap((l, i) => (re.test(l) ? [`${p}:${i + 1}:${l}`] : [])),
      );
    },
  }),
  read_file: tool({
    description: "Read a file from the PR workspace.",
    inputSchema: valibotSchema(v.object({ path: v.string() })),
    execute: async ({ path }) => {
      calls.push({ tool: "read_file", path });
      return files[path] ?? "ERROR: not found";
    },
  }),
};

const t0 = Date.now();
let firstDeltaMs = null;
const counts = {};
const result = streamText({
  model: provider(modelId),
  system: "You analyze pull requests. Use the tools to inspect code before answering. Answer in Japanese.",
  prompt: "このPRでAPIの認証はどこでどう検証されていますか？ ファイルを確認して答えてください。",
  tools,
  stopWhen: stepCountIs(10),
});
for await (const part of result.fullStream) {
  counts[part.type] = (counts[part.type] ?? 0) + 1;
  if (part.type === "text-delta" && firstDeltaMs === null) firstDeltaMs = Date.now() - t0;
  if (part.type === "tool-error") console.log("TOOL ERROR:", part.toolName, JSON.stringify(part.input), String(part.error?.message ?? part.error).slice(0,200));
  if (part.type === "error") console.log("ERROR PART:", part.error?.message ?? part.error);
}
const text = await result.text;
const steps = await result.steps;
console.log(JSON.stringify({
  model: modelId,
  totalMs: Date.now() - t0,
  firstTextDeltaMs: firstDeltaMs,
  steps: steps.length,
  finishReason: await result.finishReason,
  toolCalls: calls,
  partCounts: counts,
  usage: await result.totalUsage,
  answerHead: text.slice(0, 300),
}, null, 2));
