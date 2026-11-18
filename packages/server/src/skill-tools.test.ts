import type { ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SkillRead } from "./instructions/skills.ts";
import { ContextRoom } from "./pr-session/room.ts";
import { type SkillContext, skillMarker, skillTools, type TurnSkill } from "./pr-session/skill-tools.ts";
import { NO_ROOM, TOOL_RESULT_CHARS } from "./pr-session/tools.ts";
import { captureLogs, events } from "./test/access.ts";
import { latch } from "./test/latch.ts";

// The skill tools over a skill held in memory (docs/design.md, Model context): activate_skill pages a SKILL.md's body,
// read_skill_resource reads a file of an activated skill, each result led by the server's status line, and an earlier
// turn's result read back as its marker from that line alone. The Hub's read and its bound are the session's
// (cloud-skills.test.ts).

afterEach(() => {
  vi.restoreAllMocks();
});

const SHA = "a1b2c3d".padEnd(40, "0");
const SKILL: TurnSkill = {
  name: "polish",
  description: "Polishes text.",
  rev: 3,
  sha: SHA,
  source: { owner: "octo", repo: "skills", path: "skills/polish" },
};

function status(tool: string, outcome: string): string {
  return `[${tool} skill polish at ${SHA} rev 3: ${outcome}]`;
}

const HEADER = [
  "From octo/skills, skills/polish.",
  'Read its files with read_skill_resource and a path relative to the skill; a directory\'s path lists it, "." lists all.',
  "It runs no scripts here: use its instructions and files.",
];

const FRONTMATTER = "---\nname: polish\ndescription: Polishes text.\n---\n";

type Files = Record<string, string | Uint8Array>;

// The Hub's read over files held here, at revision 3; each read waits first for what `hold` gives when it starts.
function readOf(files: Files, hold?: () => Promise<void> | undefined): SkillContext["read"] & { calls: string[] } {
  const calls: string[] = [];
  const read = async (name: string, rev: number, path: string): Promise<SkillRead> => {
    calls.push(path);
    await hold?.();
    if (name !== SKILL.name || rev !== SKILL.rev) {
      return { kind: "changed" };
    }
    const content = files[path];
    if (content !== undefined) {
      return { kind: "file", content: typeof content === "string" ? new TextEncoder().encode(content) : content };
    }
    return { kind: "paths", paths: Object.keys(files).toSorted() };
  };
  return Object.assign(read, { calls });
}

// A read of a registration that moved since the turn listed it, and one whose call failed.
async function movedRead(): Promise<SkillRead> {
  return { kind: "changed" };
}

function failedRead(): Promise<SkillRead> {
  return Promise.reject(new TypeError("the Hub is gone"));
}

function skillSet(
  files: Files,
  { room = new ContextRoom(1_048_576), read = readOf(files) }: { room?: ContextRoom; read?: SkillContext["read"] } = {},
) {
  const activated = new Set<string>();
  const calls: string[] = [];
  const tools = skillTools({
    skills: new Map([[SKILL.name, SKILL]]),
    kind: "answer",
    read: (name, rev, path, signal) => {
      calls.push(path);
      return read(name, rev, path, signal);
    },
    room,
    activated,
    fields: { pr: "octo~skills~1", jobId: "job-1" },
  });
  return { tools, activated, room, read: { calls } };
}

// A room with `left` characters left.
function roomOf(left: number): ContextRoom {
  const room = new ContextRoom(1_048_576);
  room.take(room.leftChars() - left);
  return room;
}

async function call(set: ToolSet, name: string, input: Record<string, unknown>): Promise<string> {
  const execute = set[name]?.execute;
  if (execute === undefined) {
    throw new Error(`no tool ${name}`);
  }
  const result: unknown = await execute(input, { toolCallId: "call", messages: [], context: undefined });
  if (typeof result !== "string") {
    throw new Error("a tool result that is not text");
  }
  return result;
}

// A body of 15,698 characters (yomiyasu's SKILL.md at planning) whose 41st line is longer than a page.
function longBody(): string {
  const lines = Array.from({ length: 40 }, (_, index) => `rule ${index + 1}: `.padEnd(60, "r"));
  lines.push("a long line ".padEnd(12_500, "l"));
  for (let index = 1; index <= 11; index += 1) {
    lines.push(`tail ${index} `.padEnd(60, "t"));
  }
  const body = `${lines.join("\n")}\n`;
  return `${body}${"end ".padEnd(15_698 - body.length - 1, "e")}\n`;
}

type Parsed = { status: string; header: string[]; lines: string[]; next: { line: number; char: number } | null };

// A page of the body: its status line, the first page's header, the body's lines, and where the next page starts.
function parsePage(result: string, first: boolean): Parsed {
  const all = result.split("\n");
  let lines = all.slice(first ? 4 : 1);
  const note = /^\[truncated (?:at|inside) line \d+; call again with startLine (\d+)(?: and startChar (\d+))?\]$/.exec(
    lines.at(-1) ?? "",
  );
  if (note !== null) {
    lines = lines.slice(0, -1);
  }
  return {
    status: all[0] ?? "",
    header: first ? all.slice(1, 4) : [],
    lines,
    next: note === null ? null : { line: Number(note[1]), char: Number(note[2] ?? 0) },
  };
}

describe("activate_skill", () => {
  it("pages a 15,698-character body, a long line split by startChar, into pages that join into the body", async () => {
    const body = longBody();
    expect(body).toHaveLength(15_698);
    const { tools, activated } = skillSet({ "SKILL.md": `${FRONTMATTER}${body}` });

    const pages: Parsed[] = [];
    let input: Record<string, unknown> = { name: "polish" };
    for (let page = 0; page < 10; page += 1) {
      const result = await call(tools, "activate_skill", input);
      expect(result.length).toBeLessThanOrEqual(TOOL_RESULT_CHARS);
      const parsed = parsePage(result, page === 0);
      pages.push(parsed);
      if (parsed.next === null) {
        break;
      }
      input = { name: "polish", startLine: parsed.next.line, startChar: parsed.next.char };
    }

    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.every((page) => page.status === status("activate_skill", "read"))).toBe(true);
    expect(pages[0]?.header).toEqual(HEADER);
    // A page cut inside a line continues it on the next page, joined once; the last keeps the body's final line end.
    let joined = "";
    for (const [index, page] of pages.entries()) {
      const before = pages[index - 1];
      joined += `${index === 0 || (before?.next?.char ?? 0) > 0 ? "" : "\n"}${page.lines.join("\n")}`;
    }
    expect(pages.some((page) => (page.next?.char ?? 0) > 0)).toBe(true);
    expect(joined).toBe(body);
    expect([...activated]).toEqual(["polish"]);
  });

  it("cuts a page to the room left, as read_file does, and still activates the skill", async () => {
    const { tools, activated } = skillSet({ "SKILL.md": `${FRONTMATTER}${longBody()}` }, { room: roomOf(3000) });

    const result = await call(tools, "activate_skill", { name: "polish" });

    expect(result.length).toBeLessThanOrEqual(3000);
    expect(result.split("\n").slice(0, 4)).toEqual([status("activate_skill", "read"), ...HEADER]);
    expect(result).toMatch(
      /\n\[cut at line \d+ \(startLine \d+\): the context has no room for more; answer from what you have read\]$/,
    );
    expect([...activated]).toEqual(["polish"]);
  });

  it("answers a startLine past the end as an error that activates nothing", async () => {
    const body = "one\ntwo\nthree\n";
    const { tools, activated } = skillSet({ "SKILL.md": `${FRONTMATTER}${body}` });

    const result = await call(tools, "activate_skill", { name: "polish", startLine: 4 });

    expect(result).toBe(
      `${status("activate_skill", "error")}\nerror: startLine 4 is past the end of the body (3 lines)`,
    );
    expect(activated.size).toBe(0);
  });

  it("answers a start at the end of a body without a final line end as an error, so its files stay refused", async () => {
    const { tools, activated } = skillSet({ "SKILL.md": `${FRONTMATTER}Use Japanese`, "references/a.md": "a\n" });

    const result = await call(tools, "activate_skill", { name: "polish", startLine: 1, startChar: 12 });

    expect(result).toBe(
      `${status("activate_skill", "error")}\nerror: startLine 1 and startChar 12 is at the end of the body (1 lines)`,
    );
    expect(activated.size).toBe(0);
    expect(await call(tools, "read_skill_resource", { name: "polish", path: "references/a.md" })).toContain(
      "error: activate polish first",
    );
  });

  it("delivers an empty body as one page, and its files are then reachable", async () => {
    const { tools, activated } = skillSet({ "SKILL.md": FRONTMATTER, "references/a.md": "a\n" });

    const result = await call(tools, "activate_skill", { name: "polish" });

    expect(result).toBe([status("activate_skill", "read"), ...HEADER, "(empty body)"].join("\n"));
    expect([...activated]).toEqual(["polish"]);
    expect(await call(tools, "read_skill_resource", { name: "polish", path: "references/a.md" })).toBe(
      `${status("read_skill_resource", "read")}\n1\ta`,
    );
  });

  it("refuses a skill the turn did not list, without a status line or a read", async () => {
    const { tools, read } = skillSet({ "SKILL.md": FRONTMATTER });

    const result = await call(tools, "activate_skill", { name: "other" });

    expect(result).toBe(
      'error: no skill is named "other"; the skills you can activate are listed in the system message',
    );
    expect(read.calls).toEqual([]);
  });

  it("answers a registration that moved since the turn listed it without a status line", async () => {
    const files = { "SKILL.md": `${FRONTMATTER}body B\n` };
    const { tools, activated } = skillSet(files, { read: movedRead });

    const result = await call(tools, "activate_skill", { name: "polish" });

    expect(result).toBe(
      "error: the skill polish was updated or removed after this answer started; its current version applies from " +
        "the next question",
    );
    expect(result).not.toContain("body B");
    expect(activated.size).toBe(0);
  });
});

describe("read_skill_resource", () => {
  const FILES: Files = {
    "SKILL.md": `${FRONTMATTER}# Polish\n`,
    "references/style.md": "# Style\nShort sentences.\n",
    "references/tone.md": "# Tone\n",
    "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0x04]),
    "assets/latin1.txt": new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
    "scripts/check.py": "print('ok')\n",
  };

  it("refuses a skill not activated in the turn, without reading the Hub", async () => {
    const { tools, read } = skillSet(FILES);

    const result = await call(tools, "read_skill_resource", { name: "polish", path: "references/style.md" });

    expect(result).toBe(
      `${status("read_skill_resource", "error")}\nerror: activate polish first: call activate_skill with its name`,
    );
    expect(read.calls).toEqual([]);
  });

  it("reads files, binaries and directories of an activated skill, and refuses SKILL.md and paths it does not hold", async () => {
    const { tools } = skillSet(FILES);
    await call(tools, "activate_skill", { name: "polish" });
    const read = (path: string) => call(tools, "read_skill_resource", { name: "polish", path });
    const ok = status("read_skill_resource", "read");
    const refused = status("read_skill_resource", "error");

    expect(await read("references/style.md")).toBe(`${ok}\n1\t# Style\n2\tShort sentences.`);
    expect(await read("assets/logo.png")).toBe(`${ok}\nbinary file, 9 bytes`);
    expect(await read("assets/latin1.txt")).toBe(`${ok}\nbinary file, 4 bytes`);
    expect(await read("references")).toBe(`${ok}\nreferences/style.md\nreferences/tone.md`);
    expect(await read(".")).toBe(`${ok}\n${Object.keys(FILES).toSorted().join("\n")}`);
    expect(await read("SKILL.md")).toBe(
      `${refused}\nerror: SKILL.md is the skill's instructions: read it with activate_skill`,
    );
    expect(await read("../polish/SKILL.md")).toBe(
      `${refused}\nerror: the path "../polish/SKILL.md" has an empty, . or .. segment`,
    );
    expect(await read("references/")).toBe(`${refused}\nerror: the path "references/" has an empty, . or .. segment`);
    expect(await read("missing.md")).toBe(`${refused}\nerror: the skill polish has no file or directory missing.md`);
    expect(await read("refer")).toBe(`${refused}\nerror: the skill polish has no file or directory refer`);
  });

  it("cuts a file to the room left with the status line kept", async () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");
    const room = new ContextRoom(1_048_576);
    const { tools } = skillSet({ ...FILES, "references/long.md": lines }, { room });
    await call(tools, "activate_skill", { name: "polish" });
    room.take(room.leftChars() - 800);

    const result = await call(tools, "read_skill_resource", { name: "polish", path: "references/long.md" });

    expect(result.length).toBeLessThanOrEqual(800);
    expect(result.split("\n")[0]).toBe(status("read_skill_resource", "read"));
    expect(result.split("\n")[1]).toBe("1\tline 1");
    expect(result).toMatch(
      /\n\[cut at line \d+ \(startLine \d+\): the context has no room for more; answer from what you have read\]$/,
    );
  });
});

// An activation of a body in a room with `left` characters left: its result and the skills it activated.
async function activateIn(body: string, left: number): Promise<{ result: string; activated: string[] }> {
  const set = skillSet({ "SKILL.md": `${FRONTMATTER}${body}` }, { room: roomOf(left) });
  return { result: await call(set.tools, "activate_skill", { name: "polish" }), activated: [...set.activated] };
}

describe("activation and the room", () => {
  it("decides when the call ends: an activation whose read waited while another result took the room is no room, and activates nothing", async () => {
    const held = latch();
    const read = readOf({ "SKILL.md": `${FRONTMATTER}# Polish\n`, "references/a.md": "a\n" }, () => held.promise);
    const { tools, activated, room } = skillSet({}, { read });

    const activation = call(tools, "activate_skill", { name: "polish" });
    await vi.waitFor(() => expect(read.calls).toEqual(["SKILL.md"]));
    // A parallel result of the same step takes the room while the read waits.
    room.take(room.leftChars() - 50);
    held.open();

    expect(await activation).toBe(`${status("activate_skill", "no room")}\n${NO_ROOM}`);
    expect(activated.size).toBe(0);
    // The next step measures the room anew.
    room.start(0);
    expect(await call(tools, "read_skill_resource", { name: "polish", path: "references/a.md" })).toBe(
      `${status("read_skill_resource", "error")}\nerror: activate polish first: call activate_skill with its name`,
    );
  });

  it("decides a resource read when it ends too: one whose read waited while another result took the room is no room", async () => {
    const files = { "SKILL.md": `${FRONTMATTER}# Polish\n`, "references/a.md": "a\n" };
    let hold: Promise<void> | undefined;
    const read = readOf(files, () => hold);
    const { tools, room } = skillSet(files, { read });
    await call(tools, "activate_skill", { name: "polish" });
    const held = latch();
    hold = held.promise;

    const resource = call(tools, "read_skill_resource", { name: "polish", path: "references/a.md" });
    await vi.waitFor(() => expect(read.calls).toEqual(["SKILL.md", "references/a.md"]));
    room.take(room.leftChars() - 50);
    held.open();

    const result = await resource;
    expect(result).toBe(`${status("read_skill_resource", "no room")}\n${NO_ROOM}`);
    expect(
      skillMarker({
        type: "tool-read_skill_resource",
        toolCallId: "c",
        state: "output-available",
        input: { name: "polish", path: "references/a.md" },
        output: result,
      }).output,
    ).toBe(
      "[read_skill_resource of skill polish at a1b2c3d rev 3 in an earlier turn: no room; activate the skill again to use it]",
    );
  });

  it("delivers a short body whole in a room too small for a page and its note, and refuses a long one there", async () => {
    const short = skillSet({ "SKILL.md": `${FRONTMATTER}SKILL-BODY-EXACT-SENTINEL\n` }, { room: roomOf(498) });
    const long = skillSet({ "SKILL.md": `${FRONTMATTER}${longBody()}` }, { room: roomOf(498) });

    const whole = await call(short.tools, "activate_skill", { name: "polish" });
    const refused = await call(long.tools, "activate_skill", { name: "polish" });

    expect(whole).toBe([status("activate_skill", "read"), ...HEADER, "SKILL-BODY-EXACT-SENTINEL\n"].join("\n"));
    expect([...short.activated]).toEqual(["polish"]);
    expect(refused).toBe(`${status("activate_skill", "no room")}\n${NO_ROOM}`);
    expect(long.activated.size).toBe(0);
  });

  it.each([
    ["with", "\n"],
    ["without", ""],
  ])(
    "delivers a body whose whole result fills the room exactly, %s a final line end, and not one a character over",
    async (_label, end) => {
      const framing = [status("activate_skill", "read"), ...HEADER, ""].join("\n").length;
      // At 498 characters no page and its note fit, so one character over is no room.
      const short = `${"x".repeat(498 - framing - end.length)}${end}`;
      const lines = `${Array.from({ length: 30 }, (_, index) => `line ${index + 1} `.padEnd(40, "l")).join("\n")}${end}`;

      expect(await activateIn(short, 498)).toEqual({
        result: [status("activate_skill", "read"), ...HEADER, short].join("\n"),
        activated: ["polish"],
      });
      expect(await activateIn(short, 497)).toEqual({
        result: `${status("activate_skill", "no room")}\n${NO_ROOM}`,
        activated: [],
      });
      expect(await activateIn(lines, framing + lines.length)).toEqual({
        result: [status("activate_skill", "read"), ...HEADER, lines].join("\n"),
        activated: ["polish"],
      });
      const paged = await activateIn(lines, framing + lines.length - 1);
      expect(paged.result.length).toBeLessThan(framing + lines.length - 1);
      expect(paged.result.split("\n").slice(0, 4)).toEqual([status("activate_skill", "read"), ...HEADER]);
      expect(paged.result).toMatch(
        /\n\[cut at line \d+ \(startLine \d+\): the context has no room for more; [^\]]*\]$/,
      );
      expect(paged.activated).toEqual(["polish"]);
    },
  );

  it("is no room, before any read, when the room cannot hold the status line and the header", async () => {
    const reserve = [status("activate_skill", "read"), ...HEADER].join("\n").length + 1;
    const { tools, activated, read } = skillSet({ "SKILL.md": `${FRONTMATTER}# Polish\n` }, { room: roomOf(reserve) });

    expect(await call(tools, "activate_skill", { name: "polish" })).toBe(
      `${status("activate_skill", "no room")}\n${NO_ROOM}`,
    );
    expect(read.calls).toEqual([]);
    expect(activated.size).toBe(0);
  });

  it("activates nothing when the Hub's read fails, so the skill's files stay refused", async () => {
    const { tools, activated } = skillSet({}, { read: failedRead });

    expect(await call(tools, "activate_skill", { name: "polish" })).toBe(
      `${status("activate_skill", "error")}\nerror: the skill's files were not read (TypeError)`,
    );
    expect(activated.size).toBe(0);
    expect(await call(tools, "read_skill_resource", { name: "polish", path: "references/a.md" })).toContain(
      "error: activate polish first",
    );
  });
});

describe("logs", () => {
  it("name each skill call by identifiers and counts, never its text", async () => {
    const logs = captureLogs();
    const { tools } = skillSet({ "SKILL.md": `${FRONTMATTER}BODY-SENTINEL\n`, "references/a.md": "FILE-SENTINEL\n" });

    const activation = await call(tools, "activate_skill", { name: "polish" });
    const file = await call(tools, "read_skill_resource", { name: "polish", path: "references/a.md" });

    expect(events(logs, "prq.skill.activated")).toEqual([
      {
        event: "prq.skill.activated",
        pr: "octo~skills~1",
        jobId: "job-1",
        name: "polish",
        rev: 3,
        sha: SHA,
        startLine: 1,
        startChar: 0,
        outcome: "read",
        chars: activation.length,
      },
    ]);
    expect(events(logs, "prq.skill.read")).toEqual([
      {
        event: "prq.skill.read",
        pr: "octo~skills~1",
        jobId: "job-1",
        name: "polish",
        rev: 3,
        sha: SHA,
        path: "references/a.md",
        startLine: 1,
        startChar: 0,
        outcome: "read",
        chars: file.length,
      },
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/SENTINEL/);
  });
});

// A settled skill call as a commit stores it.
function settled(output: string, tool = "activate_skill", input: unknown = { name: "polish" }) {
  return { type: `tool-${tool}`, toolCallId: "c", state: "output-available", input, output } as const;
}

describe("an earlier turn's marker", () => {
  const tail = "in an earlier turn";
  const again = "activate the skill again to use it";

  it("reads the commit, the revision and the outcome from the status line alone", () => {
    const noRoom = skillMarker(settled(`${status("activate_skill", "no room")}\n${NO_ROOM}`));
    expect(noRoom).toEqual({
      type: "tool-activate_skill",
      toolCallId: "c",
      state: "output-available",
      input: { name: "polish" },
      output: `[activate_skill of skill polish at a1b2c3d rev 3 ${tail}: no room; ${again}]`,
    });
    // The outcome a later line names cannot stand in for the status line's.
    const spoofed = settled(`${status("activate_skill", "no room")}\n${status("activate_skill", "read")}`);
    expect(skillMarker(spoofed).output).toBe(
      `[activate_skill of skill polish at a1b2c3d rev 3 ${tail}: no room; ${again}]`,
    );
    const read = skillMarker(
      settled(`${status("read_skill_resource", "read")}\n1\tFILE-SENTINEL`, "read_skill_resource", {
        name: "polish",
        path: "references/secret.md",
      }),
    );
    expect(read.input).toEqual({ name: "polish" });
    expect(read.output).toBe(`[read_skill_resource of skill polish at a1b2c3d rev 3 ${tail}: read; ${again}]`);
  });

  it("names a result without a status line: the no-room notice, an error state, and any other text", () => {
    expect(skillMarker(settled(NO_ROOM)).output).toBe(
      `[activate_skill of skill polish at unknown rev unknown ${tail}: no room; ${again}]`,
    );
    expect(
      skillMarker({
        type: "tool-activate_skill",
        toolCallId: "c",
        state: "output-error",
        input: { name: 7 },
        errorText: "Invalid input",
      }).output,
    ).toBe(`[activate_skill of skill ? at unknown rev unknown ${tail}: error; ${again}]`);
    expect(skillMarker(settled(`body text\n${status("activate_skill", "read")}`)).output).toBe(
      `[activate_skill of skill polish at unknown rev unknown ${tail}: error; ${again}]`,
    );
    // A status line of another tool or skill than the call's is no status line of it.
    expect(skillMarker(settled(status("read_skill_resource", "read"))).output).toContain("at unknown rev unknown");
    expect(skillMarker(settled(status("activate_skill", "read"), "activate_skill", { name: "other" })).output).toBe(
      `[activate_skill of skill other at unknown rev unknown ${tail}: error; ${again}]`,
    );
  });
});
