// check:skills's context step (G2) and the turn after the last removal (G7): cloud turns with skills registered, the
// Worker's model the scripted one (scripted.ts), so each turn makes the same calls whatever a model would do. The
// oracle reads only what the instruction plane puts into the recorded requests (the system message, the tools offered,
// tool calls and tool results) and compares it with the check's own read of GitHub:
// - answer 1 activates yomiyasu, follows each page's continuation note as the result gives it, activates
//   internal-comms and reads one of its examples/ files; answer 2 is a plain question; internal-comms is removed;
//   answer 3 is a plain question;
// - each turn's first request lists the registered skills as their JSON records, offers the two skill tools and holds
//   no sentinel (five lines of each body and of the file: near the start, the middle and the end); within answer 1 a
//   sentinel appears only in the result of a call that read its text; yomiyasu's pages join into its body;
// - answers 2 and 3 carry answer 1's skill calls as exactly the markers computed here, and answer 3 lists yomiyasu
//   alone; once every skill is removed, the next turn's first request lists none and offers no tool.

import { type PrRef, type Skill } from "@prq/protocol";
import * as v from "valibot";

import { skillCallMarker } from "./compaction.ts";
import { ask } from "./pr.ts";
import { type ChatRequest, chatRequest, type Script, type Scripted } from "./scripted.ts";
import {
  api,
  bodyOf,
  type Github,
  INTERNAL_COMMS,
  INTERNAL_COMMS_COMMIT,
  registerSkill,
  skillLink,
  YOMIYASU,
} from "./skill-github.ts";
import type { Worker } from "./worker.ts";
import { untilEnded } from "./workspace.ts";

export type Verdict = (ok: boolean, line: string) => void;

// A pull request no webhook names: its questions have no workspace, so a turn is offered the skill tools alone.
const PR: PrRef = { owner: "prq-check", repo: "skills", number: 1 };
const SKILL_TOOLS = ["activate_skill", "read_skill_resource"];
const NOTE = /^\[truncated (?:at|inside) line \d+; call again with startLine (\d+)(?: and startChar (\d+))?\]$/;
const MAX_PAGES = 5;
const YOMIYASU_NAME = "yomiyasu";
const INTERNAL_COMMS_NAME = "internal-comms";

// A text the check knows by its source: a skill's body, or a file of a skill.
type Source = { key: string; text: string };
type Sentinel = { key: string; line: string };
// A skill call as answer 1 made it: the tool, the skill, and the skill's commit and revision then.
type SkillCall = { tool: string; name: string; sha: string; rev: number };
// What the turn after the last removal checks against: answer 1's skill calls.
type ContextState = { calls: SkillCall[]; sentinels: Sentinel[] };

function bodyKey(name: string): string {
  return `body of ${name}`;
}

function fileKey(name: string, path: string): string {
  return `${path} of ${name}`;
}

// Five lines of a text, near its start, its middle and its end: lines of at least 16 characters, trimmed, found in no
// other source and in none of `elsewhere` (the descriptions).
function sentinelsOf(source: Source, others: readonly string[]): Sentinel[] {
  const lines = [
    ...new Set(
      source.text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length >= 16 && !others.some((other) => other.includes(line))),
    ),
  ];
  if (lines.length === 0) {
    throw new Error(`no line of the ${source.key} can be a sentinel`);
  }
  const picks = [0, 0.25, 0.5, 0.75, 1].map((at) => lines[Math.round(at * (lines.length - 1))] ?? "");
  return [...new Set(picks)].map((line) => ({ key: source.key, line }));
}

// Each text of a request with where it is and, for a tool result, the source its call read.
function locations(request: ChatRequest): { where: string; text: string; reads: string | null }[] {
  const calls = new Map<string, { tool: string; input: Record<string, unknown> }>();
  for (const message of request.messages) {
    for (const call of message.tool_calls ?? []) {
      calls.set(call.id, { tool: call.function.name, input: parsed(call.function.arguments) });
    }
  }
  const found: { where: string; text: string; reads: string | null }[] = [];
  request.messages.forEach((message, index) => {
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    const call = message.role === "tool" ? calls.get(message.tool_call_id ?? "") : undefined;
    found.push({
      where: `message ${index + 1} (${message.role}${call === undefined ? "" : ` of ${call.tool}`})`,
      text,
      reads: call === undefined ? null : readsOf(call),
    });
    for (const made of message.tool_calls ?? []) {
      found.push({
        where: `message ${index + 1}'s ${made.function.name} call`,
        text: made.function.arguments,
        reads: null,
      });
    }
  });
  for (const offered of request.tools ?? []) {
    found.push({ where: `the definition of ${offered.function.name}`, text: JSON.stringify(offered), reads: null });
  }
  return found;
}

const Input = v.record(v.string(), v.unknown());

function parsed(text: string): Record<string, unknown> {
  const value = v.safeParse(Input, JSON.parse(text));
  return value.success ? value.output : {};
}

function readsOf(call: { tool: string; input: Record<string, unknown> }): string | null {
  const name = typeof call.input["name"] === "string" ? call.input["name"] : "";
  if (call.tool === "activate_skill") {
    return bodyKey(name);
  }
  return call.tool === "read_skill_resource" && typeof call.input["path"] === "string"
    ? fileKey(name, call.input["path"])
    : null;
}

// Where sentinels are where they may not be: anywhere at all with `strict`, else anywhere but in the result of a call
// that read their source.
function misplaced(request: ChatRequest, sentinels: readonly Sentinel[], strict: boolean): string[] {
  const found = locations(request);
  return sentinels.flatMap((sentinel) =>
    found
      .filter((location) => location.text.includes(sentinel.line) && (strict || location.reads !== sentinel.key))
      .map((location) => `a line of the ${sentinel.key} in ${location.where}`),
  );
}

// The system message's lines that are skill records, as the list writes them.
function listed(request: ChatRequest): string[] {
  const [system] = request.messages;
  const text = system?.role === "system" && typeof system.content === "string" ? system.content : "";
  return text.split("\n").filter((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return (
        typeof value === "object" &&
        value !== null &&
        Object.keys(value).join(",") === "name,description" &&
        Object.values(value).every((field) => typeof field === "string")
      );
    } catch {
      return false;
    }
  });
}

function records(skills: readonly { name: string; description: string }[]): string[] {
  return skills
    .toSorted((a, b) => (a.name < b.name ? -1 : 1))
    .map(({ name, description }) => JSON.stringify({ name, description }));
}

// The skill calls a request carries, each with its input and its result.
function skillCalls(request: ChatRequest): { tool: string; input: Record<string, unknown>; result: string }[] {
  const results = new Map(
    request.messages
      .filter((message) => message.role === "tool")
      .map((message) => [message.tool_call_id ?? "", typeof message.content === "string" ? message.content : ""]),
  );
  return request.messages.flatMap((message) =>
    (message.tool_calls ?? [])
      .filter((call) => SKILL_TOOLS.includes(call.function.name))
      .map((call) => ({
        tool: call.function.name,
        input: parsed(call.function.arguments),
        result: results.get(call.id) ?? "",
      })),
  );
}

function lastToolResult(request: ChatRequest): string | null {
  const last = request.messages.at(-1);
  return last?.role === "tool" && typeof last.content === "string" ? last.content : null;
}

// Answer 1: yomiyasu's pages as their notes give them, internal-comms, then one of its files, then a text.
function answerOne(example: string): Script {
  let stage: "yomiyasu" | "internal-comms" | "resource" = "yomiyasu";
  let pages = 0;
  return (request): Scripted => {
    const result = lastToolResult(request);
    if (result === null) {
      pages = 1;
      return { tool: "activate_skill", input: { name: YOMIYASU_NAME } };
    }
    if (stage === "yomiyasu") {
      const note = NOTE.exec(result.split("\n").at(-1) ?? "");
      if (note !== null && pages < MAX_PAGES) {
        pages += 1;
        const startChar = note[2] === undefined ? {} : { startChar: Number(note[2]) };
        return { tool: "activate_skill", input: { name: YOMIYASU_NAME, startLine: Number(note[1]), ...startChar } };
      }
      stage = "internal-comms";
      return { tool: "activate_skill", input: { name: INTERNAL_COMMS_NAME } };
    }
    if (stage === "internal-comms") {
      stage = "resource";
      return { tool: "read_skill_resource", input: { name: INTERNAL_COMMS_NAME, path: example } };
    }
    return { text: "Answer 1, written after the skills were read." };
  };
}

// The body as yomiyasu's pages give it: each page after its status line (and the first page's header), without its
// note, the next page after a line end unless the page was cut inside a line, which the next page continues.
function joinedPages(pages: readonly string[]): { text: string; statuses: string[] } {
  let text = "";
  const statuses: string[] = [];
  let inside = false;
  pages.forEach((page, index) => {
    const all = page.split("\n");
    statuses.push(all[0] ?? "");
    let body = all.slice(index === 0 ? 4 : 1);
    const note = NOTE.exec(body.at(-1) ?? "");
    if (note !== null) {
      body = body.slice(0, -1);
    }
    text += `${index === 0 || inside ? "" : "\n"}${body.join("\n")}`;
    inside = note !== null && note[2] !== undefined;
  });
  return { text, statuses };
}

async function answer(
  worker: Worker,
  scripted: { play: (script: Script) => void },
  id: string,
  script: Script,
): Promise<{ state: string; requests: ChatRequest[] }> {
  const from = worker.modelRequests().length;
  scripted.play(script);
  await ask(worker, PR, id, `Question ${id} about this pull request.`);
  const job = await untilEnded(worker, PR, (entry) => entry.target.kind === "answer" && entry.target.messageId === id);
  const requests = worker.modelRequests().slice(from).map(chatRequest);
  return { state: job?.state ?? "no job", requests };
}

const plain: Script = () => ({ text: "A plain answer." });

// A turn's first request: the records of `skills`, the skill tools offered (none without skills), no sentinel, and
// `calls` as their markers.
function checkFirst(
  label: string,
  request: ChatRequest | undefined,
  skills: readonly { name: string; description: string }[],
  sentinels: readonly Sentinel[],
  calls: readonly SkillCall[],
  verdict: Verdict,
): void {
  if (request === undefined) {
    verdict(false, `${label}: no request was recorded`);
    return;
  }
  const lines = listed(request);
  const expected = records(skills);
  const offered = (request.tools ?? []).map((entry) => entry.function.name);
  const [system] = request.messages;
  const systemText = typeof system?.content === "string" ? system.content : "";
  verdict(
    JSON.stringify(lines) === JSON.stringify(expected) &&
      (expected.length === 0 ? !systemText.includes("activate_skill") : systemText.includes(expected.join("\n"))) &&
      JSON.stringify(offered) === JSON.stringify(skills.length === 0 ? [] : SKILL_TOOLS),
    `${label}: the system message lists ${lines.length} records (${skills.map((skill) => skill.name).join(", ") || "none"} ` +
      `registered): ${JSON.stringify(lines) === JSON.stringify(expected) ? "the registered ones, sorted" : "NOT the registered ones"}; ` +
      `tools offered: ${offered.join(", ") || "none"}`,
  );
  const wrong = misplaced(request, sentinels, true);
  verdict(
    wrong.length === 0,
    `${label}: sentinels in the first request: ${wrong.length === 0 ? "none" : wrong.join("; ")}`,
  );
  const carried = skillCalls(request);
  const expectedCalls = calls.map((call) => ({
    tool: call.tool,
    input: { name: call.name },
    result: skillCallMarker(call.tool, call.name, call),
  }));
  verdict(
    JSON.stringify(carried) === JSON.stringify(expectedCalls),
    `${label}: ${carried.length} earlier skill calls carried, ${JSON.stringify(carried) === JSON.stringify(expectedCalls) ? "each exactly its marker" : `NOT the markers computed: ${JSON.stringify(carried).slice(0, 600)}`}`,
  );
}

// G2: answers 1–3 with yomiyasu (registered by the register step) and internal-comms. The state the turn after the
// last removal checks, or null when the step could not go on.
export async function checkContext(
  worker: Worker,
  github: Github,
  scripted: { play: (script: Script) => void },
  yomiyasu: Skill,
  print: (line: string) => void,
  verdict: Verdict,
): Promise<ContextState | null> {
  const commit = await github.commitOf(INTERNAL_COMMS, INTERNAL_COMMS_COMMIT);
  const comms = await registerSkill(worker, skillLink(INTERNAL_COMMS, commit));
  const yomiyasuManifest = await github.manifestAt(YOMIYASU, yomiyasu.sha);
  const commsManifest = await github.manifestAt(INTERNAL_COMMS, comms.sha);
  const example = commsManifest.files.find((file) => file.path.startsWith("examples/"));
  if (example === undefined) {
    verdict(false, `G2: internal-comms at ${comms.sha.slice(0, 7)} has no examples/ file`);
    return null;
  }
  const yomiyasuBody = bodyOf(yomiyasuManifest.skillMd);
  const sources: Source[] = [
    { key: bodyKey(YOMIYASU_NAME), text: yomiyasuBody },
    { key: bodyKey(INTERNAL_COMMS_NAME), text: bodyOf(commsManifest.skillMd) },
    {
      key: fileKey(INTERNAL_COMMS_NAME, example.path),
      text: new TextDecoder().decode(await github.blob(INTERNAL_COMMS, example.blob)),
    },
  ];
  const descriptions = [yomiyasu.description, comms.description];
  const sentinels = sources.flatMap((source) =>
    sentinelsOf(source, [...descriptions, ...sources.filter((other) => other !== source).map((other) => other.text)]),
  );
  print(
    `G2: internal-comms registered at ${comms.sha.slice(0, 7)} rev ${comms.rev}; ${sentinels.length} sentinels from ` +
      sources.map((source) => `the ${source.key} (${source.text.length} characters)`).join(", "),
  );
  const both = [yomiyasu, comms];

  const one = await answer(worker, scripted, "skills-1", answerOne(example.path));
  print(`G2 answer 1: ${one.state}, ${one.requests.length} requests`);
  checkFirst("G2 answer 1", one.requests[0], both, sentinels, [], verdict);
  const later = one.requests
    .slice(1)
    .flatMap((request, index) => misplaced(request, sentinels, false).map((line) => `request ${index + 2}: ${line}`));
  verdict(
    later.length === 0,
    `G2 answer 1: sentinels outside the results of the calls that read them: ${later.length === 0 ? "none" : later.join("; ")}`,
  );
  const last = one.requests.at(-1);
  const made = last === undefined ? [] : skillCalls(last);
  const pages = made
    .filter((call) => call.tool === "activate_skill" && call.input["name"] === YOMIYASU_NAME)
    .map((call) => call.result);
  const { text, statuses } = joinedPages(pages);
  const status = `[activate_skill skill ${YOMIYASU_NAME} at ${yomiyasu.sha} rev ${yomiyasu.rev}: read]`;
  verdict(
    one.state === "done" && pages.length >= 2 && statuses.every((line) => line === status) && text === yomiyasuBody,
    `G2 answer 1: yomiyasu's ${pages.length} pages (${pages.map((page) => page.length).join(", ")} characters), each ` +
      `${statuses.every((line) => line === status) ? "after its status line" : "NOT after the status line"}, join into ` +
      `${text === yomiyasuBody ? "exactly" : "NOT"} the body GitHub gives (${yomiyasuBody.length} characters)`,
  );
  const expectedTools = [
    ...pages.map(() => `activate_skill ${YOMIYASU_NAME}`),
    `activate_skill ${INTERNAL_COMMS_NAME}`,
    `read_skill_resource ${INTERNAL_COMMS_NAME}`,
  ];
  const madeTools = made.map((call) => `${call.tool} ${String(call.input["name"])}`);
  const okResults = made.every((call) =>
    /^\[[a-z_]+ skill [a-z0-9-]+ at [0-9a-f]{40} rev \d+: read\]/.test(call.result),
  );
  verdict(
    JSON.stringify(madeTools) === JSON.stringify(expectedTools) && okResults,
    `G2 answer 1: calls ${madeTools.join(", ")}; ${okResults ? "each result read" : "NOT each result read"}`,
  );
  const calls: SkillCall[] = made.map((call) => {
    const skill = call.input["name"] === YOMIYASU_NAME ? yomiyasu : comms;
    return { tool: call.tool, name: skill.name, sha: skill.sha, rev: skill.rev };
  });

  const two = await answer(worker, scripted, "skills-2", plain);
  print(`G2 answer 2: ${two.state}, ${two.requests.length} requests`);
  checkFirst("G2 answer 2", two.requests[0], both, sentinels, calls, verdict);

  const removed = await api(worker, "DELETE", `/api/skills/${INTERNAL_COMMS_NAME}`);
  verdict(removed.status === 204, `G2: internal-comms removed: ${removed.status}`);
  const three = await answer(worker, scripted, "skills-3", plain);
  print(`G2 answer 3: ${three.state}, ${three.requests.length} requests`);
  checkFirst("G2 answer 3", three.requests[0], [yomiyasu], sentinels, calls, verdict);
  verdict(two.state === "done" && three.state === "done", `G2: answers 2 and 3 ${two.state} and ${three.state}`);
  return { calls, sentinels };
}

// G7's turn after the last removal: no list, no tool, and answer 1's markers unchanged.
export async function checkAfterRemoval(
  worker: Worker,
  scripted: { play: (script: Script) => void },
  state: ContextState,
  print: (line: string) => void,
  verdict: Verdict,
): Promise<void> {
  const after = await answer(worker, scripted, "skills-after-removal", plain);
  print(`G7 the next turn: ${after.state}, ${after.requests.length} requests`);
  checkFirst("G7 the next turn", after.requests[0], [], state.sentinels, state.calls, verdict);
  verdict(after.state === "done", `G7 the next turn: ${after.state}`);
}
