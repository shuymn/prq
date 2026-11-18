import { valibotSchema } from "@ai-sdk/valibot";
import { type Skill, SKILL_NAME_CHARS, SkillName, skillPathIssue } from "@prq/protocol";
import {
  type DynamicToolUIPart,
  getToolName,
  isToolUIPart,
  tool,
  type ToolSet,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import * as v from "valibot";

import { COMMAND_CHARS, commandArgv, parseEntry, type RunnableEntry } from "../instructions/command.ts";
import { skillBody } from "../instructions/skill.ts";
import type { SkillFilesRead, SkillRead } from "../instructions/skills.ts";
import { errorName, log } from "../log.ts";
import { WaitTimeout } from "../wait.ts";
import { cutAt, fitPage, MIN_PAGE_CHARS, type Page, type PageRequest, pageLines } from "./pages.ts";
import type { ContextRoom } from "./room.ts";
import {
  continuation,
  fitResult,
  NO_ROOM,
  NOTE_CHARS,
  numberedPage,
  pathList,
  StartChar,
  StartLine,
  TOOL_RESULT_CHARS,
  withNote,
} from "./tools.ts";
import {
  raceAbort,
  SCRIPT_STDIN_CHARS,
  SCRIPT_TOOL_MS,
  type ScriptEnding,
  type ScriptResult,
  STDERR_TAIL_CHARS,
  type WorkspaceClient,
  type WorkspaceTarget,
} from "./workspace.ts";

// The skill tools of a cloud turn (docs/design.md, Model context): the turn lists each registered skill's name and
// description, and these load the rest on demand. activate_skill returns a skill's SKILL.md body, read_skill_resource
// a file of a skill activated earlier in the turn, and run_skill_script runs a command such a skill allows in the
// workspace container. Every call reads the revision the turn listed, so a turn never mixes two versions of one skill;
// a result whose skill resolved starts with the server's status line, from which an earlier turn's marker is read
// (projection.ts). A tool never throws, and its result keeps the bounds of every tool result (tools.ts).

const SKILL_TOOLS = ["activate_skill", "read_skill_resource", "run_skill_script"] as const;
type SkillTool = (typeof SKILL_TOOLS)[number];

// How a skill call that resolved its skill ended: a page or a file delivered, a script's exit or its timeout, nothing
// delivered or run for lack of room, or a refusal or a failure.
type Outcome = "read" | `exit ${number}` | "timeout" | "no room" | "error";

// A skill as a turn lists it at its start: what its system message shows (name, description) and what its calls read
// and name (revision, commit, source, and the allowed-tools entries its scripts run by).
export type TurnSkill = Pick<Skill, "name" | "description" | "rev" | "sha" | "source" | "allowedTools">;

// What a turn's script runs use: its workspace and target, and the Hub's read of a skill's files at a revision (the
// caller bounds it, and the signal ends the wait).
type ScriptContext = {
  workspace: WorkspaceClient;
  target: WorkspaceTarget;
  files(name: string, rev: number, signal: AbortSignal): Promise<SkillFilesRead>;
};

export type SkillContext = {
  // The skills the turn listed at its start, by name.
  skills: ReadonlyMap<string, TurnSkill>;
  kind: "analysis" | "answer";
  // The Hub's read of a skill's path at a revision; the caller bounds it, and the signal ends the wait.
  read(name: string, rev: number, path: string, signal: AbortSignal): Promise<SkillRead>;
  // The turn's script runs, when it is offered run_skill_script (a workspace, and a skill with a runnable entry).
  scripts: ScriptContext | null;
  room: ContextRoom;
  // The skills of which the turn delivered a page of the body: the only ones read_skill_resource and run_skill_script
  // use.
  activated: Set<string>;
  // What the logs name the turn by.
  fields: { pr: string; jobId: string };
};

// The entries of a skill's allowed-tools a cloud turn runs.
export function runnableEntries(skill: Pick<TurnSkill, "allowedTools">): RunnableEntry[] {
  return (skill.allowedTools ?? []).flatMap(({ entry, runs }) => {
    const parsed = runs ? parseEntry(entry) : null;
    return parsed === null ? [] : [parsed];
  });
}

// The line a resolved skill call's result starts with, written by the server before anything else.
function statusLine(toolName: SkillTool, skill: TurnSkill, outcome: Outcome): string {
  return `[${toolName} skill ${skill.name} at ${skill.sha} rev ${skill.rev}: ${outcome}]`;
}

// The status line, matched whole against the grammar the server writes it in: the tool, the skill's name, its 40-hex
// commit, its decimal revision and one of the outcomes.
const STATUS_LINE = new RegExp(
  `^\\[(${SKILL_TOOLS.join("|")}) skill ([a-z0-9]+(?:-[a-z0-9]+)*) at ([0-9a-f]{40}) rev ([1-9][0-9]*): ` +
    "(read|exit (?:0|[1-9][0-9]{0,2})|timeout|no room|error)\\]$",
);

const SkillNameInput = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(SKILL_NAME_CHARS),
  v.description("A skill's name, as the system message lists it"),
);
const ActivateInput = v.object({
  name: SkillNameInput,
  startLine: v.optional(StartLine),
  startChar: v.optional(StartChar),
});
const ResourceInput = v.object({
  name: SkillNameInput,
  path: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(1024),
    v.description('A path relative to the skill\'s directory: a file, a directory to list, or "." for all its files'),
  ),
  startLine: v.optional(StartLine),
  startChar: v.optional(StartChar),
});

const RunInput = v.object({
  name: SkillNameInput,
  command: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(COMMAND_CHARS),
    v.description("The command, as the skill's activation lists the commands it allows; ${CLAUDE_SKILL_DIR} included"),
  ),
  stdin: v.optional(
    v.pipe(v.string(), v.maxLength(SCRIPT_STDIN_CHARS), v.description("Text given to the script's standard input")),
  ),
});

// What the provider is told of each skill tool, the same in every turn.
export const SKILL_TOOL_DEFINITIONS = {
  activate_skill: {
    description:
      "Load a skill's instructions (its SKILL.md without the frontmatter) to follow them. A long body comes in " +
      "pages, as read_file's: a note at the end of a page says where the next one starts.",
    inputSchema: valibotSchema(ActivateInput),
  },
  read_skill_resource: {
    description:
      "Read a file of a skill, with line numbers, or list a directory of it, after activating the skill with " +
      "activate_skill. Paths are relative to the skill's directory; SKILL.md is read with activate_skill.",
    inputSchema: valibotSchema(ResourceInput),
  },
};

// What the provider is told of the run tool, offered in a turn with a workspace while a listed skill allows a script.
export const RUN_TOOL_DEFINITION = {
  run_skill_script: {
    description:
      "Run a command a skill allows, after activating the skill with activate_skill (its activation lists the " +
      "commands), in the workspace and without a shell: ${CLAUDE_SKILL_DIR} is the skill's directory, and pipes, " +
      "redirections and && are not taken. stdin is given to the script's standard input: where a skill's example " +
      "feeds a script through a heredoc or <, give that text as stdin and only the words before it as command. The " +
      "working directory lasts for this turn's later runs unless the workspace restarts, which the result then says. " +
      "A script is not run again for its output: what does not fit the result is cut.",
    inputSchema: valibotSchema(RunInput),
  },
};

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// git's test for a binary file (a NUL among the first 8,000 bytes), or bytes that are not UTF-8.
function isBinary(bytes: Uint8Array): boolean {
  if (bytes.subarray(0, 8000).includes(0)) {
    return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

function readError(error: unknown): string {
  if (error instanceof WaitTimeout) {
    return `error: ${error.message}`;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "error: the tool call was cancelled";
  }
  return `error: the skill's files were not read (${errorName(error)})`;
}

// What a resolved call shows from the Hub's answer: a page to cut from text (its request, whether its lines are
// numbered, and how a page of it renders), or a whole result with no page (a binary file, a refusal).
type Source =
  | {
      text: string;
      request: Omit<PageRequest, "capChars">;
      numbered: boolean;
      render(page: Page, byRoom: boolean): Shown;
    }
  | Shown;
type Shown = { outcome: "read" | "error"; text: string };

// One resolved skill call: its tool and skill, the Hub path it reads, the lines a delivered page shows after the status
// line (the activation's header), what it shows from the Hub's answer, and what a delivery records.
type Call = {
  tool: Exclude<SkillTool, "run_skill_script">;
  skill: TurnSkill;
  path: string;
  header: readonly string[];
  source(read: Exclude<SkillRead, { kind: "changed" }>): Source;
  delivered?: () => void;
};

// Why a call is refused before its skill resolved: a name the turn did not list, or a registration that moved since
// the turn listed it. Such a result has no status line.
function unknownSkill(name: string): string {
  return `error: no skill is named ${JSON.stringify(name)}; the skills you can activate are listed in the system message`;
}

function changedSkill(context: SkillContext, name: string): string {
  const [started, next] = context.kind === "analysis" ? ["summary", "summary"] : ["answer", "question"];
  return (
    `error: the skill ${name} was updated or removed after this ${started} started; its current version applies ` +
    `from the next ${next}`
  );
}

// A result with no status line, taken within the room.
function unresolved(context: SkillContext, text: string): string {
  const result = fitResult(text, context.room.leftChars());
  context.room.take(result.length);
  return result;
}

// The no-room result of a call that resolved its skill.
function noRoomResult(toolName: SkillTool, skill: TurnSkill): string {
  return `${statusLine(toolName, skill, "no room")}\n${NO_ROOM}`;
}

// A refusal or a failure after its status line, cut to the room left; the no-room result when even that does not fit.
function skillError(
  toolName: SkillTool,
  skill: TurnSkill,
  text: string,
  left: number,
): { outcome: Outcome; text: string } {
  const cut = fitResult(`${statusLine(toolName, skill, "error")}\n${text}`, left);
  return cut === NO_ROOM
    ? { outcome: "no room", text: noRoomResult(toolName, skill) }
    : { outcome: "error", text: cut };
}

// Ends a resolved call: the status line, composed last, then the rest. A delivery is shown whole within the room left
// or becomes the no-room result, so the outcome and what it records follow what the model receives; any other result
// is cut after its status line. Logged with identifiers and counts, never text.
function resolved(context: SkillContext, call: Call, shown: Shown | { outcome: "no room" }, extra: object): string {
  const left = context.room.leftChars();
  let outcome: Outcome = "no room";
  let result = noRoomResult(call.tool, call.skill);
  if (shown.outcome === "read") {
    const text = [statusLine(call.tool, call.skill, "read"), ...call.header, shown.text].join("\n");
    if (text.length <= Math.min(TOOL_RESULT_CHARS, left)) {
      outcome = "read";
      result = text;
      call.delivered?.();
    }
  } else if (shown.outcome === "error") {
    ({ outcome, text: result } = skillError(call.tool, call.skill, shown.text, left));
  }
  context.room.take(result.length);
  const { name, rev, sha } = call.skill;
  log(call.tool === "activate_skill" ? "prq.skill.activated" : "prq.skill.read", {
    ...context.fields,
    name,
    rev,
    sha,
    ...extra,
    outcome,
    chars: result.length,
  });
  return result;
}

// Reads a resolved call's page from the Hub at the turn's revision, within the result cap and the room the context
// has left: asked for at the room when the call starts, cut again to the room once the Hub has answered and the page
// is read, as the git tools' pages are (tools.ts). The rest of the text from the call's start is shown whole when its
// rendered result fits; only a page that does not end it keeps room for its continuation note and needs
// MIN_PAGE_CHARS, so a short body or file fits a room too small for a page. Nothing awaits between that last cut and
// the take.
async function readPaged(context: SkillContext, signal: AbortSignal | undefined, call: Call, extra: object) {
  // A delivered result's status line and header, each with its line end.
  const framing = [statusLine(call.tool, call.skill, "read"), ...call.header, ""].join("\n").length;
  // The room a page has after them, within the result cap.
  const roomFor = (available: number) => Math.min(TOOL_RESULT_CHARS, available) - framing;
  const startRoom = roomFor(context.room.leftChars());
  if (startRoom < 1) {
    return resolved(context, call, { outcome: "no room" }, extra);
  }
  let read: SkillRead;
  try {
    read = await context.read(call.skill.name, call.skill.rev, call.path, signal ?? new AbortController().signal);
  } catch (error) {
    return resolved(context, call, { outcome: "error", text: readError(error) }, extra);
  }
  if (read.kind === "changed") {
    return unresolved(context, changedSkill(context, call.skill.name));
  }
  const source = call.source(read);
  if (!("request" in source)) {
    return resolved(context, call, source, extra);
  }
  // One character over the room: the reader charges a line end after the last line, which a text that ends without one
  // does not show, so a rest that fits whole is read whole.
  const page = await pageLines(streamOf(new TextEncoder().encode(source.text)), {
    ...source.request,
    capChars: startRoom + 1,
  });
  const room = Math.min(startRoom, roomFor(context.room.leftChars()));
  if (page.next === null) {
    const whole = source.render(page, false);
    if (whole.outcome !== "read" || whole.text.length <= room) {
      return resolved(context, call, whole, extra);
    }
  }
  const cap = room - NOTE_CHARS;
  if (cap < MIN_PAGE_CHARS) {
    return resolved(context, call, { outcome: "no room" }, extra);
  }
  // The note says the room cut the page when the room, not the result cap, set its size.
  const byRoom = cap < roomFor(TOOL_RESULT_CHARS) - NOTE_CHARS;
  return resolved(context, call, source.render(fitPage(page, cap, source.numbered), byRoom), extra);
}

// The first page's header: where the skill came from, how its files are read, and the commands its scripts run with,
// or that they do not run here (no runnable entry, or no workspace in the turn).
function firstHeader(skill: TurnSkill, scripts: boolean): string[] {
  const { owner, repo, path } = skill.source;
  const entries = scripts ? runnableEntries(skill) : [];
  return [
    `From ${owner}/${repo}, ${path === "" ? "its root" : path}.`,
    'Read its files with read_skill_resource and a path relative to the skill; a directory\'s path lists it, "." lists all.',
    entries.length === 0
      ? "It runs no scripts here: use its instructions and files."
      : "Its scripts run with run_skill_script and one of these commands, ${CLAUDE_SKILL_DIR} being the skill's " +
        `directory: ${entries.map((entry) => entry.command).join("; ")}`,
  ];
}

// A page of the body, as read_file pages a file but without line numbers, so the pages join into the body: the page
// that ends it keeps the body's final line end. A start that leaves nothing of a body to show is an error, and only an
// empty body's first page is empty.
function bodyPage(page: Page, byRoom: boolean, first: boolean, lineEnd: boolean): Shown {
  const text = page.lines.length === 0 ? "" : `${page.lines.join("\n")}${page.next === null && lineEnd ? "\n" : ""}`;
  if (text !== "" || page.next !== null) {
    return { outcome: "read", text: withNote(text, continuation(page, byRoom)) };
  }
  if (page.lineCount === 0 && first) {
    return { outcome: "read", text: "(empty body)" };
  }
  const start = `startLine ${page.start.line}${page.start.char > 0 ? ` and startChar ${page.start.char}` : ""}`;
  return {
    outcome: "error",
    text: `error: ${start} is ${page.lines.length > 0 ? "at" : "past"} the end of the body (${page.lineCount ?? 0} lines)`,
  };
}

function filePage(page: Page, byRoom: boolean): Shown {
  if (page.lines.length > 0) {
    return { outcome: "read", text: numberedPage(page, byRoom) };
  }
  if (page.lineCount === 0) {
    return { outcome: "read", text: "(empty file)" };
  }
  return {
    outcome: "error",
    text: `error: startLine ${page.start.line} is past the end of the file (${page.lineCount ?? 0} lines)`,
  };
}

function listing(page: Page, byRoom: boolean): Shown {
  return { outcome: "read", text: pathList(page, byRoom) };
}

// --- Script runs ---

// The notice a run's result carries right after its status line, kept whole, when the turn's scratch directory had to
// be made again: the model runs the earlier steps (a `run` before its `verify`) again.
export function lostScratch(kind: SkillContext["kind"]): string {
  return (
    `the working directory of this ${kind === "analysis" ? "summary" : "answer"}'s earlier script runs was lost ` +
    "(an earlier run's ending is unknown, or the workspace restarted): run the earlier steps again"
  );
}

// Why a run that resolved its skill did not run, or ended without an exit, as the model is told.
function endingText(ending: ScriptEnding): string {
  if (ending.kind === "not started") {
    return `error: the script did not start (${ending.reason})`;
  }
  if (ending.kind === "unknown") {
    return `error: the script's ending is unknown (${ending.reason}); its effects may or may not have happened`;
  }
  if (ending.kind !== "refused") {
    return "";
  }
  const { end } = ending;
  if (end.kind === "busy") {
    return "error: another script run is still ending; try again shortly";
  }
  switch (end.reason) {
    case "unclean":
      return (
        "error: the processes of an earlier script run could not be confirmed ended, so scripts do not run until the " +
        "workspace restarts (after 30 minutes without a request); go on without the script"
      );
    case "expired":
      return "error: the script did not start in time";
    case "stale-turn":
    case "stale-scratch":
      return "error: a newer run took this run's place, and it did not start";
    case "checkout":
      return "error: the checkout changed before the script started; run it again";
    case "member":
      return `error: a file of the skill could not be installed: ${end.detail ?? "?"}`;
    default:
      return `error: the script's runner failed (${end.reason})`;
  }
}

function callError(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `error: the workspace did not answer within ${SCRIPT_TOOL_MS / 60_000} minutes`;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "error: the tool call was cancelled";
  }
  return `error: ${error instanceof Error ? error.message : String(error)}`;
}

// What the log names a run's ending by.
function endingName(ending: ScriptEnding): string {
  switch (ending.kind) {
    case "exit":
      return `exit ${ending.code}`;
    case "refused":
      return ending.end.kind === "busy" ? "busy" : `failed:${ending.end.reason}`;
    default:
      return ending.kind;
  }
}

// Output sections joined by a line break, the empty ones left out.
function sections(out: string, err: string): string {
  return [out, err].filter((part) => part !== "").join("\n");
}

// The note a cut stdout ends with: the exact count of its characters not shown.
function cutNote(notShown: number): string {
  return `[${notShown} more characters of output not shown]`;
}

// A run's output within the room left after its status line and notice: stdout, whole or cut with the note, then
// stderr's tail; stderr keeps at most a third of a room that cannot hold both whole. The note is there exactly when
// stdout was cut, past the room when even it does not fit, as the status line is (runScript).
function scriptOutput(result: ScriptResult, left: number): string {
  const room = Math.max(0, left);
  const label = `stderr (last ${STDERR_TAIL_CHARS} characters):\n`;
  const err = result.stderr === "" ? "" : `${label}${result.stderr}`;
  const whole = result.stdout.length === result.stdoutChars;
  if (whole && sections(result.stdout, err).length <= room) {
    return sections(result.stdout, err);
  }
  const errRoom = Math.min(err.length, Math.floor(room / 3));
  const shownErr = errRoom > label.length ? `${label}${result.stderr.slice(-(errRoom - label.length))}` : "";
  const errTaken = shownErr === "" ? 0 : shownErr.length + 1;
  if (whole && result.stdout.length + errTaken <= room) {
    return sections(result.stdout, shownErr);
  }
  const outRoom = room - errTaken - cutNote(result.stdoutChars).length - 1;
  const shown = cutAt(result.stdout, Math.max(0, outRoom));
  const note = cutNote(result.stdoutChars - shown.length);
  const out = shown === "" ? note : withNote(shown, note);
  if (out.length + errTaken <= room) {
    return sections(out, shownErr);
  }
  return note;
}

// run_skill_script: a command an activated skill allows, matched against its runnable entries (never a shell), run in
// the workspace container with the skill's files at the turn's revision. The room is checked before anything runs and
// again at the end, where the output is cut to what is left. The status line (the run's true ending), the lost-scratch
// notice and a cut's count are delivered and charged whatever parallel results took meanwhile, past the room as a
// no-room result is. No pages: running a script again for a page would repeat its effects.
async function runScript(
  context: SkillContext,
  signal: AbortSignal | undefined,
  { name, command, stdin = "" }: { name: string; command: string; stdin?: string | undefined },
): Promise<string> {
  const skill = context.skills.get(name);
  if (skill === undefined) {
    return unresolved(context, unknownSkill(name));
  }
  const runTool = "run_skill_script";
  const noRoom = () => {
    const result = noRoomResult(runTool, skill);
    context.room.take(result.length);
    return result;
  };
  const refuse = (text: string) => {
    const result = skillError(runTool, skill, text, context.room.leftChars()).text;
    context.room.take(result.length);
    return result;
  };
  const entries = runnableEntries(skill);
  const { scripts } = context;
  if (!context.activated.has(name)) {
    return refuse(`error: activate ${name} first: call activate_skill with its name`);
  }
  if (scripts === null || entries.length === 0) {
    return refuse(`error: the skill ${name} runs no scripts here`);
  }
  const argv = commandArgv(command, name, entries);
  if ("issue" in argv) {
    return refuse(
      `error: ${argv.issue}; the commands ${name} allows: ${entries.map((entry) => entry.command).join("; ")}`,
    );
  }
  // The most the status line and the notice take, then a page's least.
  const framing = `${statusLine(runTool, skill, "exit 255")}\n${lostScratch(context.kind)}\n`.length;
  const capChars = Math.min(TOOL_RESULT_CHARS, context.room.leftChars()) - framing;
  if (capChars < MIN_PAGE_CHARS) {
    return noRoom();
  }
  const callSignal = signal ?? new AbortController().signal;
  let read: SkillFilesRead;
  try {
    read = await scripts.files(name, skill.rev, callSignal);
  } catch (error) {
    return refuse(readError(error));
  }
  if (read.kind === "changed") {
    return unresolved(context, changedSkill(context, name));
  }
  const started = Date.now();
  let result: ScriptResult;
  try {
    const run = { name, files: read.files, argv: argv.argv, stdin, capChars };
    result = await raceAbort(() => scripts.workspace.runScript(scripts.target, run, callSignal), callSignal);
  } catch (error) {
    const text = refuse(callError(error));
    scriptLog(context, skill, argv.script, { ending: "error", ms: Date.now() - started });
    return text;
  }
  const { ending } = result;
  const outcome: Outcome =
    ending.kind === "exit" ? `exit ${ending.code}` : ending.kind === "timeout" ? "timeout" : "error";
  const head = [statusLine(runTool, skill, outcome)];
  if (result.scratch === "lost") {
    head.push(lostScratch(context.kind));
  }
  if (outcome === "error") {
    head.push(endingText(ending));
  }
  const framed = head.join("\n");
  const output = scriptOutput(result, Math.min(TOOL_RESULT_CHARS, context.room.leftChars()) - framed.length - 1);
  const text = output === "" ? framed : `${framed}\n${output}`;
  context.room.take(text.length);
  scriptLog(context, skill, argv.script, {
    ending: endingName(ending),
    ms: Date.now() - started,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    scratch: result.scratch,
    clean: result.clean,
  });
  return text;
}

// prq.skill.script: identifiers, the ending and sizes, never the command's words or the input (they hold the host's
// text).
function scriptLog(context: SkillContext, skill: TurnSkill, script: string, fields: object): void {
  const { name, rev, sha } = skill;
  log("prq.skill.script", { ...context.fields, name, rev, sha, script, ...fields });
}

// The skill tools of a turn whose list is not empty, sorted by name, with run_skill_script when the turn has its
// scripts. No tool has needsApproval (tools.ts).
export function skillTools(context: SkillContext): ToolSet {
  return {
    ...(context.scripts === null
      ? {}
      : {
          run_skill_script: tool({
            ...RUN_TOOL_DEFINITION.run_skill_script,
            execute: (input, { abortSignal }) => runScript(context, abortSignal, input),
          }),
        }),
    activate_skill: tool({
      ...SKILL_TOOL_DEFINITIONS.activate_skill,
      execute: ({ name, startLine = 1, startChar = 0 }, { abortSignal }) => {
        const skill = context.skills.get(name);
        if (skill === undefined) {
          return Promise.resolve(unresolved(context, unknownSkill(name)));
        }
        const first = startLine === 1 && startChar === 0;
        return readPaged(
          context,
          abortSignal,
          {
            tool: "activate_skill",
            skill,
            path: "SKILL.md",
            header: first ? firstHeader(skill, context.scripts !== null) : [],
            source: (read) => {
              const body = read.kind === "file" ? skillBody(read.content) : null;
              if (body === null) {
                return { outcome: "error", text: "error: the skill's SKILL.md is not stored as registered" };
              }
              return {
                text: body,
                request: { start: { line: startLine, char: startChar } },
                numbered: false,
                render: (page, byRoom) => bodyPage(page, byRoom, first, body.endsWith("\n")),
              };
            },
            delivered: () => context.activated.add(skill.name),
          },
          { startLine, startChar },
        );
      },
    }),
    read_skill_resource: tool({
      ...SKILL_TOOL_DEFINITIONS.read_skill_resource,
      execute: ({ name, path, startLine = 1, startChar = 0 }, { abortSignal }) => {
        const skill = context.skills.get(name);
        if (skill === undefined) {
          return Promise.resolve(unresolved(context, unknownSkill(name)));
        }
        const call: Call = {
          tool: "read_skill_resource",
          skill,
          path: path === "." ? "" : path,
          header: [],
          source: (read) => {
            if (read.kind === "file") {
              return isBinary(read.content)
                ? { outcome: "read", text: `binary file, ${read.content.byteLength} bytes` }
                : {
                    text: new TextDecoder().decode(read.content),
                    request: { start: { line: startLine, char: startChar }, numbered: true },
                    numbered: true,
                    render: filePage,
                  };
            }
            const under = path === "." ? read.paths : read.paths.filter((stored) => stored.startsWith(`${path}/`));
            if (under.length === 0) {
              return { outcome: "error", text: `error: the skill ${name} has no file or directory ${path}` };
            }
            return {
              text: under.join("\n"),
              request: { start: { line: 1, char: 0 }, countRest: true },
              numbered: false,
              render: listing,
            };
          },
        };
        const extra = { path, startLine, startChar };
        const refusal = !context.activated.has(name)
          ? `error: activate ${name} first: call activate_skill with its name`
          : path === "SKILL.md"
            ? "error: SKILL.md is the skill's instructions: read it with activate_skill"
            : path === "."
              ? null
              : skillPathIssue(path);
        if (refusal !== null) {
          const text = refusal.startsWith("error: ") ? refusal : `error: ${refusal}`;
          return Promise.resolve(resolved(context, call, { outcome: "error", text }, extra));
        }
        return readPaged(context, abortSignal, call, extra);
      },
    }),
  };
}

// --- Earlier turns ---

const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set(SKILL_TOOLS);

export function isSkillToolPart(part: UIMessage["parts"][number]): part is ToolUIPart | DynamicToolUIPart {
  return isToolUIPart(part) && SKILL_TOOL_NAMES.has(getToolName(part));
}

// What an earlier turn's skill tool part becomes wherever the model reads it, is counted or is summarized: its input
// the skill's name alone (`?` when it is not a skill name) and its result one bounded marker. The commit, revision and
// outcome come from the status line alone, the result's first line matched whole, so nothing a result holds after it
// can stand in for it; without one, the no-room notice is `no room` and anything else (an error, a refused input) is
// `error`, with the commit and revision unknown. No argument, path or text of the result reaches it.
export function skillMarker(part: ToolUIPart | DynamicToolUIPart): ToolUIPart | DynamicToolUIPart {
  const toolName = getToolName(part);
  const given: unknown = typeof part.input === "object" && part.input !== null ? Reflect.get(part.input, "name") : null;
  const name = v.is(SkillName, given) ? given : "?";
  const output = part.state === "output-available" && typeof part.output === "string" ? part.output : null;
  const status = STATUS_LINE.exec(output?.split("\n", 1)[0] ?? "");
  const line =
    status !== null && status[1] === toolName && status[2] === name
      ? { sha: (status[3] ?? "").slice(0, 7), rev: status[4] ?? "", outcome: status[5] ?? "" }
      : { sha: "unknown", rev: "unknown", outcome: output === NO_ROOM ? "no room" : "error" };
  const marker =
    `[${toolName} of skill ${name} at ${line.sha} rev ${line.rev} in an earlier turn: ${line.outcome}; ` +
    "activate the skill again to use it]";
  const settled = { toolCallId: part.toolCallId, state: "output-available" as const, input: { name }, output: marker };
  return part.type === "dynamic-tool"
    ? { type: "dynamic-tool", toolName: part.toolName, ...settled }
    : { type: part.type, ...settled };
}

// Whether parts hold a skill tool call: a committed result holding one keeps no context measurement.
export function hasSkillToolPart(parts: UIMessage["parts"]): boolean {
  return parts.some(isSkillToolPart);
}
