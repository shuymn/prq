import { valibotSchema } from "@ai-sdk/valibot";
import { tool, type ToolSet } from "ai";
import * as v from "valibot";

import { toolArgv } from "../workspace-git.ts";
import { cutAt, fitPage, MIN_PAGE_CHARS, type Page, type PageRequest } from "./pages.ts";
import type { ContextRoom } from "./room.ts";
import {
  type CommandResult,
  type PreparedWorkspace,
  raceAbort,
  WORKSPACE_CALL_MS,
  type WorkspaceClient,
  type WorkspaceTarget,
} from "./workspace.ts";

// The cloud agent's git tools (docs/design.md, Model context), and the bounds every tool's result keeps: the git tools
// read the job's commit, so a path resolves in the commit's tree only and a symlink is its link text, never followed.
// A tool never throws: what failed comes back as `error: …` text, which the model can act on. Each result is at most
// 12,000 characters, and no more than the context has room for; a note says where the next page starts. The skill
// tools are skill-tools.ts's, and turn-tools.ts makes a turn's set of both.

// The most characters one tool result takes, its notes included.
export const TOOL_RESULT_CHARS = 12_000;
// Room a result keeps for its note (where the next page starts, or why it was cut).
export const NOTE_CHARS = 200;
// Less room than this and a result could not show a page: the tools are withdrawn and the model answers.
export const MIN_RESULT_CHARS = MIN_PAGE_CHARS + NOTE_CHARS;

// What diff says when the history did not reach the merge base.
export const TWO_TIPS = "comparison of the two tips (base and head), not the pull request's merge-base diff";
export const NO_ROOM = "[no room left in the context for this result; answer from what you have read]";
// The end of a result cut by the final cut.
const RESULT_CUT = "\n[cut: the rest of this result does not fit]";
export const WORKSPACE_TIMED_OUT = `error: the workspace did not answer within ${WORKSPACE_CALL_MS / 60_000} minutes`;

const Path = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(1024),
  v.description("A path in the repository, relative to its root"),
);
export const StartLine = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.description("The line to start at (from 1), as a note in an earlier result gave it"),
);
export const StartChar = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.description("The character in startLine to start at (from 0), as a note in an earlier result gave it"),
);

const ListFilesInput = v.object({
  path: v.optional(v.pipe(Path, v.description("A directory or a file; the whole repository when left out"))),
});
const ReadFileInput = v.object({ path: Path, startLine: v.optional(StartLine), startChar: v.optional(StartChar) });
const GrepInput = v.object({
  pattern: v.pipe(v.string(), v.minLength(1), v.maxLength(1000), v.description("A POSIX extended regular expression")),
  path: v.optional(v.pipe(Path, v.description("A directory or a file to search; the whole repository when left out"))),
  ignoreCase: v.optional(v.boolean()),
});
const DiffInput = v.object({
  path: v.optional(v.pipe(Path, v.description("A file whose patch to show; the changed files when left out"))),
  startLine: v.optional(StartLine),
  startChar: v.optional(StartChar),
});

export type ToolContext = {
  workspace: WorkspaceClient;
  target: WorkspaceTarget;
  prepared: PreparedWorkspace;
  room: ContextRoom;
};

// How one tool's command is run and its result shown.
type Paged = {
  argv: readonly string[];
  request: Omit<PageRequest, "capChars">;
  // A line shown before the result (diff's two-tip note).
  header?: string;
  // The result, from the command's outcome and its page (cut to the room left when `byRoom`).
  render(result: CommandResult, page: Page, byRoom: boolean): string;
};

function errorText(result: CommandResult): string {
  const message = result.stderr.trim();
  return `error: ${message === "" ? `git exited with ${result.exitCode}` : message}`;
}

function callError(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return WORKSPACE_TIMED_OUT;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "error: the tool call was cancelled";
  }
  return `error: ${error instanceof Error ? error.message : String(error)}`;
}

export function withNote(body: string, note: string): string {
  return note === "" ? body : `${body}\n${note}`;
}

// Where the next page starts, as the model calls again for it; or, when the context has no room for more, that it was
// cut there.
export function continuation(page: Page, byRoom: boolean): string {
  const { next } = page;
  if (next === null) {
    return "";
  }
  const at = next.char === 0 ? `startLine ${next.line}` : `startLine ${next.line} and startChar ${next.char}`;
  if (byRoom) {
    return `[cut at line ${next.line} (${at}): the context has no room for more; answer from what you have read]`;
  }
  return next.char === 0
    ? `[truncated at line ${next.line}; call again with ${at}]`
    : `[truncated inside line ${next.line}; call again with ${at}]`;
}

function cutByRoom(byRoom: boolean): string {
  return byRoom ? "; the context has no room for more" : "";
}

// Runs a tool's command and shows its result within the result cap and the room the context has left: the page is
// asked for at the room when the call starts, cut again to the room when it completes, and the result, whatever
// produced it, passes the final cut before it is taken. Nothing awaits between the call's end and the take, so results
// are taken in the order they complete and each sees the room the earlier ones left.
async function runPaged(context: ToolContext, signal: AbortSignal | undefined, paged: Paged): Promise<string> {
  const header = paged.header === undefined ? "" : `${paged.header}\n`;
  const capFor = (available: number) => Math.min(TOOL_RESULT_CHARS, available) - header.length - NOTE_CHARS;
  const startCap = capFor(context.room.leftChars());
  let text = NO_ROOM;
  if (startCap >= MIN_PAGE_CHARS) {
    try {
      const callSignal = signal ?? new AbortController().signal;
      const command = { argv: paged.argv, page: { ...paged.request, capChars: startCap } };
      const result = await raceAbort(() => context.workspace.run(context.target, command, callSignal), callSignal);
      const cap = Math.min(startCap, capFor(context.room.leftChars()));
      if (cap >= MIN_PAGE_CHARS) {
        const page = cap < startCap ? fitPage(result.page, cap, paged.request.numbered === true) : result.page;
        const byRoom = page !== result.page || startCap < capFor(TOOL_RESULT_CHARS);
        text = header + paged.render(result, page, byRoom);
      }
    } catch (error) {
      text = callError(error);
    }
  }
  text = fitResult(text, context.room.leftChars());
  context.room.take(text.length);
  return text;
}

// The last cut of every result, a page, git's error or a failed call alike: at most 12,000 characters and at most the
// room left, or, with less room left than a result needs, the no-room notice. Each result thus takes at most the room
// left or one notice.
export function fitResult(text: string, left: number): string {
  const limit = Math.min(TOOL_RESULT_CHARS, left);
  if (text.length <= limit) {
    return text;
  }
  if (limit < MIN_RESULT_CHARS) {
    return NO_ROOM;
  }
  return `${cutAt(text, limit - RESULT_CUT.length)}${RESULT_CUT}`;
}

// A nonempty page of a file, each line after its number and a tab, with its continuation note.
export function numberedPage(page: Page, byRoom: boolean): string {
  const lines = page.lines.map((text, index) => `${page.start.line + index}\t${text}`);
  return withNote(lines.join("\n"), continuation(page, byRoom));
}

// A page of paths, with how many more were left out.
export function pathList(page: Page, byRoom: boolean): string {
  const note = page.next === null ? "" : `[${page.rest} more paths not shown; narrow the path${cutByRoom(byRoom)}]`;
  return withNote(page.lines.join("\n"), note);
}

function listFilesResult(path: string | undefined) {
  return (result: CommandResult, page: Page, byRoom: boolean): string => {
    if (result.exitCode !== 0) {
      return errorText(result);
    }
    if (page.lines.length === 0) {
      return path === undefined ? "no files" : `no files at ${path}`;
    }
    return pathList(page, byRoom);
  };
}

function readFileResult(result: CommandResult, page: Page, byRoom: boolean): string {
  if (result.exitCode !== 0) {
    return errorText(result);
  }
  if (page.binaryBytes !== null) {
    return `binary file, ${page.binaryBytes} bytes`;
  }
  if (page.lines.length === 0) {
    return page.lineCount === 0
      ? "(empty file)"
      : `error: startLine ${page.start.line} is past the end of the file (${page.lineCount} lines)`;
  }
  return numberedPage(page, byRoom);
}

function grepResult(result: CommandResult, page: Page, byRoom: boolean): string {
  if (result.exitCode === 1) {
    return "no matches";
  }
  if (result.exitCode !== 0) {
    return errorText(result);
  }
  const note =
    page.next === null
      ? ""
      : `[${page.rest} more matching lines not shown; narrow the pattern or the path${cutByRoom(byRoom)}]`;
  return withNote(page.lines.join("\n"), note);
}

function diffResult(path: string | undefined) {
  return (result: CommandResult, page: Page, byRoom: boolean): string => {
    if (result.exitCode !== 0) {
      return errorText(result);
    }
    if (page.lines.length === 0) {
      if (page.lineCount !== 0) {
        return `error: startLine ${page.start.line} is past the end of the diff (${page.lineCount} lines)`;
      }
      return path === undefined ? "no changes" : `no changes to ${path}`;
    }
    return withNote(page.lines.join("\n"), continuation(page, byRoom));
  };
}

// What the provider is told of each git tool: its description and its input's schema, the same in every turn.
export const GIT_TOOL_DEFINITIONS = {
  diff: {
    description:
      "The pull request's change. Without a path: the changed files, each with its added and removed line counts. " +
      "With a path: that file's patch. Long output comes in pages, as read_file's.",
    inputSchema: valibotSchema(DiffInput),
  },
  grep: {
    description:
      "Search the repository's text files for a regular expression, in the whole repository or under a path. " +
      "Each match is path:line:text.",
    inputSchema: valibotSchema(GrepInput),
  },
  list_files: {
    description: "List the repository's files: all of them, or those under a path.",
    inputSchema: valibotSchema(ListFilesInput),
  },
  read_file: {
    description:
      "Read a file of the repository, with line numbers. A long file comes in pages: a note at the end of a page " +
      "says where the next one starts (startLine, and startChar inside a long line).",
    inputSchema: valibotSchema(ReadFileInput),
  },
};

// The tools of a turn with a workspace, sorted by name (the order the provider sees them in, for its prompt cache). No
// tool has needsApproval: the SDK's approval paths write the history around prq's commit.
export function workspaceTools(context: ToolContext): ToolSet {
  const { sha } = context.target;
  const base = context.prepared.mergeBase ?? context.target.baseSha;
  const twoTips = context.prepared.mergeBase === null ? TWO_TIPS : undefined;
  return {
    diff: tool({
      ...GIT_TOOL_DEFINITIONS.diff,
      execute: ({ path, startLine = 1, startChar = 0 }, { abortSignal }) =>
        runPaged(context, abortSignal, {
          argv: toolArgv.diff(base, sha, path),
          request: { start: { line: startLine, char: startChar } },
          ...(twoTips === undefined ? {} : { header: twoTips }),
          render: diffResult(path),
        }),
    }),
    grep: tool({
      ...GIT_TOOL_DEFINITIONS.grep,
      execute: ({ pattern, path, ignoreCase }, { abortSignal }) =>
        runPaged(context, abortSignal, {
          argv: toolArgv.grep(sha, pattern, path, ignoreCase),
          request: { start: { line: 1, char: 0 }, stripPrefix: `${sha}:`, countRest: true },
          render: grepResult,
        }),
    }),
    list_files: tool({
      ...GIT_TOOL_DEFINITIONS.list_files,
      execute: ({ path }, { abortSignal }) =>
        runPaged(context, abortSignal, {
          argv: toolArgv.listFiles(sha, path),
          request: { start: { line: 1, char: 0 }, countRest: true },
          render: listFilesResult(path),
        }),
    }),
    read_file: tool({
      ...GIT_TOOL_DEFINITIONS.read_file,
      execute: ({ path, startLine = 1, startChar = 0 }, { abortSignal }) =>
        runPaged(context, abortSignal, {
          argv: toolArgv.readFile(sha, path),
          request: { start: { line: startLine, char: startChar }, numbered: true, detectBinary: true },
          render: readFileResult,
        }),
    }),
  };
}
