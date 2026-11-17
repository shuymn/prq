import { streamText, type ToolSet } from "ai";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextRoom } from "./pr-session/room.ts";
import {
  TOOL_RESULT_CHARS,
  toolArgv,
  toolLoop,
  TURN_LOOP,
  TWO_TIPS,
  WORKSPACE_TIMED_OUT,
  workspaceTools,
} from "./pr-session/tools.ts";
import { WORKSPACE_CALL_MS, type WorkspaceClient, type WorkspaceTarget } from "./pr-session/workspace.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket } from "./test/chat.ts";
import { cloudSession, untilEnded } from "./test/cloud.ts";
import { answerScript, finish, ScriptedModel, toolCall, useCloudModel, useWorkspace } from "./test/model.ts";
import { until } from "./test/provider.ts";
import { jobRows } from "./test/session.ts";
import { push, sha } from "./test/webhook.ts";
import { FakeWorkspace, type FakeWorkspaceOptions, type Files } from "./test/workspace.ts";

// The cloud agent's tools over the in-memory workspace: what each returns through git at the job's commit, errors as
// text, results within 12,000 characters with pages reachable anywhere in a file or a line, the backstop and the turn's
// abort through the signal each call receives, and no tool that writes history around prq's commit.

const sockets: AgentSocket[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const HEAD = sha("head");
const BASE = sha("base");
const TARGET: WorkspaceTarget = { sha: HEAD, baseSha: BASE };

const RATES_BASE = ["export const rate = 1;", "export function total(n: number) {", "  return n * rate;", "}", ""].join(
  "\n",
);
const RATES_HEAD = [
  "export const rate = 2;",
  "export function total(n: number) {",
  "  return n * rate;",
  "}",
  "export const Limit = 10;",
  "",
].join("\n");

const BASE_FILES: Files = { "src/rates.ts": RATES_BASE, "README.md": "# Rates\n", "docs/old.md": "old\n" };
const HEAD_FILES: Files = {
  "src/rates.ts": RATES_HEAD,
  "src/limits.ts": "export const limit = 10;\n",
  "README.md": "# Rates\n",
  "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0x04]),
  "empty.txt": "",
};

// A turn's tools over a fake workspace prepared at the target, with the whole context free unless a room is given.
async function tools(options: FakeWorkspaceOptions = {}, room = new ContextRoom(1_048_576)) {
  const workspace = new FakeWorkspace({ base: BASE_FILES, head: HEAD_FILES, ...options });
  const prepared = await workspace.prepare(TARGET, new AbortController().signal);
  return { workspace, room, tools: workspaceTools({ workspace, target: TARGET, prepared, room }) };
}

// A turn's tools over a workspace whose every command ends as `run` says, with the room given.
function stubTools(run: WorkspaceClient["run"], room = new ContextRoom(1_048_576)) {
  const workspace: WorkspaceClient = { prepare: async () => ({ sha: HEAD, mergeBase: BASE }), run };
  return workspaceTools({ workspace, target: TARGET, prepared: { sha: HEAD, mergeBase: BASE }, room });
}

// A tool's result as the model receives it.
async function call(set: ToolSet, name: string, input: Record<string, unknown>, abortSignal?: AbortSignal) {
  const execute = set[name]?.execute;
  if (execute === undefined) {
    throw new Error(`no tool ${name}`);
  }
  const result: unknown = await execute(input, {
    toolCallId: "call",
    messages: [],
    ...(abortSignal === undefined ? {} : { abortSignal }),
    context: undefined,
  });
  if (typeof result !== "string") {
    throw new Error("a tool result that is not text");
  }
  return result;
}

describe("tools", () => {
  it("lists the commit's files, all of them or under a path", async () => {
    const { tools: set, workspace } = await tools();

    expect(await call(set, "list_files", {})).toBe("README.md\nempty.txt\nlogo.png\nsrc/limits.ts\nsrc/rates.ts");
    expect(await call(set, "list_files", { path: "src" })).toBe("src/limits.ts\nsrc/rates.ts");
    expect(await call(set, "list_files", { path: "docs" })).toBe("no files at docs");
    expect(workspace.commands.map((command) => command.argv)).toEqual([
      ["ls-tree", "-r", "--name-only", "--end-of-options", HEAD],
      ["ls-tree", "-r", "--name-only", "--end-of-options", HEAD, "src"],
      ["ls-tree", "-r", "--name-only", "--end-of-options", HEAD, "docs"],
    ]);
  });

  it("reads a file at the commit with line numbers, and says what failed as text", async () => {
    const { tools: set, workspace } = await tools();

    expect(await call(set, "read_file", { path: "src/rates.ts" })).toBe(
      [
        "1\texport const rate = 2;",
        "2\texport function total(n: number) {",
        "3\t  return n * rate;",
        "4\t}",
        "5\texport const Limit = 10;",
      ].join("\n"),
    );
    expect(await call(set, "read_file", { path: "src/rates.ts", startLine: 4 })).toBe(
      "4\t}\n5\texport const Limit = 10;",
    );
    expect(await call(set, "read_file", { path: "nope.ts" })).toBe(
      `error: fatal: path 'nope.ts' does not exist in '${HEAD}'`,
    );
    expect(await call(set, "read_file", { path: "logo.png" })).toBe("binary file, 9 bytes");
    expect(await call(set, "read_file", { path: "empty.txt" })).toBe("(empty file)");
    expect(await call(set, "read_file", { path: "src/rates.ts", startLine: 9 })).toBe(
      "error: startLine 9 is past the end of the file (5 lines)",
    );
    expect(workspace.commands[0]?.argv).toEqual(["show", "--end-of-options", `${HEAD}:src/rates.ts`]);
  });

  it("greps the commit as path:line:text, with git's message for a bad pattern", async () => {
    const { tools: set, workspace } = await tools();

    expect(await call(set, "grep", { pattern: "limit" })).toBe("src/limits.ts:1:export const limit = 10;");
    expect(await call(set, "grep", { pattern: "limit", ignoreCase: true, path: "src/rates.ts" })).toBe(
      "src/rates.ts:5:export const Limit = 10;",
    );
    expect(await call(set, "grep", { pattern: "absent" })).toBe("no matches");
    expect(await call(set, "grep", { pattern: "a(" })).toMatch(/^error: fatal: -e option, 'a\(': /);
    expect(workspace.commands[1]?.argv).toEqual(toolArgv.grep(HEAD, "limit", "src/rates.ts", true));
    expect(workspace.commands[1]?.argv).toEqual([
      "grep",
      "-n",
      "-I",
      "-E",
      "-i",
      "-e",
      "limit",
      "--end-of-options",
      HEAD,
      "--",
      "src/rates.ts",
    ]);
  });

  it("shows the change from the merge base: the changed files, or one file's patch", async () => {
    const { tools: set, workspace } = await tools();

    expect(await call(set, "diff", {})).toBe(
      "0\t1\tdocs/old.md\n0\t0\tempty.txt\n-\t-\tlogo.png\n1\t0\tsrc/limits.ts\n2\t1\tsrc/rates.ts",
    );
    expect(await call(set, "diff", { path: "src/rates.ts" })).toBe(
      [
        "diff --git a/src/rates.ts b/src/rates.ts",
        "--- a/src/rates.ts",
        "+++ b/src/rates.ts",
        "@@ -1,4 +1,5 @@",
        "-export const rate = 1;",
        "+export const rate = 2;",
        " export function total(n: number) {",
        "   return n * rate;",
        " }",
        "+export const Limit = 10;",
      ].join("\n"),
    );
    expect(await call(set, "diff", { path: "README.md" })).toBe("no changes to README.md");
    expect(workspace.commands.map((command) => command.argv)).toEqual([
      ["diff", "--numstat", "--end-of-options", BASE, HEAD, "--"],
      ["diff", "--end-of-options", BASE, HEAD, "--", "src/rates.ts"],
      ["diff", "--end-of-options", BASE, HEAD, "--", "README.md"],
    ]);
  });

  it("says when diff compares the two tips because the history did not reach the merge base", async () => {
    const { tools: set } = await tools({ mergeBase: false });

    const result = await call(set, "diff", { path: "src/limits.ts" });

    expect(result.split("\n")[0]).toBe(TWO_TIPS);
    expect(result).toContain("+export const limit = 10;");
  });

  it("returns a failed workspace call as text", async () => {
    const set = stubTools(async () => {
      throw new Error("the container stopped");
    });

    expect(await call(set, "read_file", { path: "src/rates.ts" })).toBe("error: the container stopped");
  });

  it("keeps every result within 12,000 characters, with a note on what was left out", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 2000 }, (_, index) => [`src/generated/module-${String(index).padStart(4, "0")}.ts`, "x\n"]),
    );
    const long = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}: limit`).join("\n");
    const { tools: set } = await tools({ head: { ...many, "long.txt": long } });

    const listed = await call(set, "list_files", {});
    const shown = listed.split("\n").slice(0, -1);
    expect(listed.length).toBeLessThanOrEqual(TOOL_RESULT_CHARS);
    expect(listed.split("\n").at(-1)).toBe(`[${2001 - shown.length} more paths not shown; narrow the path]`);

    const read = await call(set, "read_file", { path: "long.txt" });
    expect(read.length).toBeLessThanOrEqual(TOOL_RESULT_CHARS);
    const last = Number(read.split("\n").at(-2)?.split("\t")[0]);
    expect(read.split("\n").at(-1)).toBe(`[truncated at line ${last + 1}; call again with startLine ${last + 1}]`);

    const grepped = await call(set, "grep", { pattern: "limit" });
    const matches = grepped.split("\n").slice(0, -1);
    expect(grepped.length).toBeLessThanOrEqual(TOOL_RESULT_CHARS);
    expect(matches[0]).toBe("long.txt:1:line 1: limit");
    expect(grepped.split("\n").at(-1)).toBe(
      `[${3000 - matches.length} more matching lines not shown; narrow the pattern or the path]`,
    );
  });
});

// One read_file page's lines and note, parsed.
function parsePage(result: string) {
  const lines = result.split("\n");
  const note = /^\[truncated (?:at|inside) line \d+; call again with startLine (\d+)(?: and startChar (\d+))?\]$/.exec(
    lines.at(-1) ?? "",
  );
  const body = note === null ? lines : lines.slice(0, -1);
  return {
    lines: body.map((line) => {
      const tab = line.indexOf("\t");
      return { number: Number(line.slice(0, tab)), text: line.slice(tab + 1) };
    }),
    next: note === null ? null : { startLine: Number(note[1]), startChar: Number(note[2] ?? 0) },
  };
}

// A line of every width a UTF-8 decoder meets: ASCII, two- and three-byte characters, and surrogate pairs, so a chunk
// boundary falls inside a character somewhere.
function mixedLine(length: number): string {
  const alphabet = ["a", "b", "é", "ß", "漢", "字", "😀", "→", "z", " "];
  let line = "";
  for (let index = 0; line.length < length; index += 1) {
    line += alphabet[(index * 7) % alphabet.length];
  }
  return line;
}

describe("paging", () => {
  it("reaches every part of a 50,000-character line through startChar", async () => {
    const line = mixedLine(50_000);
    const { tools: set } = await tools({ head: { "min.js": `${line}\nafter\n` }, chunkBytes: 1000 });

    const parts: string[] = [];
    const after: string[] = [];
    let next: { startLine: number; startChar: number } | null = { startLine: 1, startChar: 0 };
    for (let page = 0; page < 20 && next !== null; page += 1) {
      const result = await call(set, "read_file", { path: "min.js", ...next });
      expect(result.length).toBeLessThanOrEqual(TOOL_RESULT_CHARS);
      const parsed = parsePage(result);
      for (const shown of parsed.lines) {
        (shown.number === 1 ? parts : after).push(shown.text);
      }
      next = parsed.next;
    }

    expect(parts.length).toBeGreaterThan(4);
    expect(parts.join("")).toBe(line);
    expect(after).toEqual(["after"]);
  });

  it("returns a page that starts after line 90,000", async () => {
    const file = Array.from({ length: 100_000 }, (_, index) => `row ${index + 1}`).join("\n");
    const { tools: set } = await tools({ head: { "big.txt": file } });

    const page = parsePage(await call(set, "read_file", { path: "big.txt", startLine: 90_001 }));

    expect(page.lines[0]).toEqual({ number: 90_001, text: "row 90001" });
    expect(page.lines.every((shown) => shown.text === `row ${shown.number}`)).toBe(true);
    expect(page.next?.startLine).toBe(90_001 + page.lines.length);
  });
});

// The platform's AbortSignal.timeout, which the AI SDK's toolMs uses, on vitest's fake clock.
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
    return controller.signal;
  });
}

// Waits, on the real clock, for a check that should hold at once; a call left pending fails within a second.
async function settles(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) {
      return;
    }
    await scheduler.wait(20);
  }
  throw new Error(`${what}: still pending after 1 s`);
}

// A turn's stream with the production loop over a workspace whose commands never answer.
async function hangingTurn(abortSignal?: AbortSignal) {
  const workspace = new FakeWorkspace({ head: HEAD_FILES });
  const prepared = await workspace.prepare(TARGET, new AbortController().signal);
  workspace.hang = true;
  const model = new ScriptedModel().add(
    [toolCall("read_file", { path: "src/rates.ts" }), finish("tool-calls")],
    answerScript("answered from what was read"),
  );
  const loop = await toolLoop({ workspace, target: TARGET, prepared }, 131_072, { system: "s", messages: [] });
  const ended: unknown[] = [];
  const result = streamText({
    model: model.model,
    system: "s",
    prompt: "What changed?",
    ...TURN_LOOP,
    tools: loop.tools,
    prepareStep: loop.prepareStep,
    onLanguageModelCallEnd: loop.onLanguageModelCallEnd,
    onToolExecutionEnd: ({ toolOutput }) => {
      ended.push(toolOutput.type === "tool-result" ? toolOutput.output : toolOutput.error);
    },
    ...(abortSignal === undefined ? {} : { abortSignal }),
  });
  let finished = false;
  const consumed = Promise.resolve(result.consumeStream()).finally(() => {
    finished = true;
  });
  await until(() => workspace.commands.length === 1, "the tool's command");
  return { model, result, consumed, ended, finished: () => finished };
}

describe("tool abort", () => {
  it("ends a call the workspace never answers at the backstop, not a tick sooner, and the turn goes on", async () => {
    fakeClock();
    const { model, result, consumed, ended, finished } = await hangingTurn();

    await vi.advanceTimersByTimeAsync(WORKSPACE_CALL_MS - 1);
    expect(ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await settles(finished, "the turn");
    await consumed;

    expect(ended).toEqual([WORKSPACE_TIMED_OUT]);
    expect(await result.text).toBe("answered from what was read");
    expect(model.calls).toHaveLength(2);
    expect(await result.finishReason).toBe("stop");
  });

  it("ends the call at once when the turn is aborted", async () => {
    fakeClock();
    const turn = new AbortController();
    const { consumed, ended } = await hangingTurn(turn.signal);

    turn.abort();
    await settles(() => ended.length === 1, "the tool call");
    await consumed;

    expect(ended).toEqual(["error: the tool call was cancelled"]);
  });

  it("starts no call once the turn has aborted, so no call's failure goes unhandled", async () => {
    const unhandled: unknown[] = [];
    const record = (event: PromiseRejectionEvent): void => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    addEventListener("unhandledrejection", record);
    try {
      let started = 0;
      const set = stubTools(async () => {
        started += 1;
        throw new Error("the container stopped");
      });
      const turn = new AbortController();
      turn.abort();

      const result = await call(set, "read_file", { path: "src/rates.ts" }, turn.signal);
      // The platform reports an unhandled rejection after the microtasks run out.
      await scheduler.wait(50);

      expect(result).toBe("error: the tool call was cancelled");
      expect(unhandled).toEqual([]);
      expect(started).toBe(0);
    } finally {
      removeEventListener("unhandledrejection", record);
    }
  });
});

describe("no bypass writers", () => {
  it("declares no approval on any tool", async () => {
    const { tools: set } = await tools();

    expect(Object.keys(set)).toEqual(["diff", "grep", "list_files", "read_file"]);
    for (const definition of Object.values(set)) {
      expect(definition.needsApproval).toBeUndefined();
    }
  });

  it("stores a tool turn only through the commit's append", async () => {
    captureLogs();
    const session = await cloudSession("tools", sockets);
    const { stub, ref } = session;
    useCloudModel(
      new ScriptedModel().add(
        [toolCall("read_file", { path: "src/rates.ts" }), finish("tool-calls")],
        [toolCall("grep", { pattern: "rate" }, "call-2"), toolCall("diff", {}, "call-3"), finish("tool-calls")],
        answerScript("the summary"),
      ),
    );
    useWorkspace(new FakeWorkspace({ base: BASE_FILES, head: HEAD_FILES }));
    const writes = await runInDurableObject(stub, (instance) => {
      const store = instance.sessions.session();
      return { upserts: vi.spyOn(store, "upsertMessage"), deletes: vi.spyOn(store, "deleteMessages") };
    });

    await push(ref, "a");

    expect(await untilEnded(stub, sha("a"))).toEqual({ state: "done", failure: null });
    const [job] = await jobRows(stub);
    const written = await runInDurableObject(stub, () => ({
      upserts: writes.upserts.mock.calls.map(([message]) => message.id),
      deletes: writes.deletes.mock.calls.length,
    }));
    expect(written).toEqual({ upserts: [`analysis-${job?.job_id}`], deletes: 0 });
  });
});
