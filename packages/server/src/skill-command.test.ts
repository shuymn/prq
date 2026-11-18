import { describe, expect, it } from "vitest";

import { commandArgv, parseEntry, type RunnableEntry, runnableEntry } from "./instructions/command.ts";
import { allowedToolsOf } from "./instructions/skills.ts";

// The command grammar of skill scripts (docs/design.md, Workspace (cloud)): the words a command is read as, the entries
// a skill's allowed-tools runs, and the argv a command runs as.

const FILES = new Set(["SKILL.md", "scripts/check.py", "scripts/fmt.py", "scripts/stance.py", "references/a.md"]);
const ENTRIES = [
  "Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/check.py *)",
  "Bash(python scripts/fmt.py --mode=fix)",
  "Bash(python3 scripts/stance.py:*)",
].map((entry) => runnableEntry(entry, FILES) ?? expect.unreachable(entry));
const DIR = "/workspace/skills/polish";

function argvOf(command: string, entries: readonly RunnableEntry[] = ENTRIES) {
  return commandArgv(command, "polish", entries);
}

describe("a command the skill allows", () => {
  it.each([
    {
      command: "python3 ${CLAUDE_SKILL_DIR}/scripts/check.py --stance=説明 'two words' \"double quoted\"",
      argv: ["--stance=説明", "two words", "double quoted"],
      script: "scripts/check.py",
    },
    // The script word as the skill's absolute directory, or as a relative path: the same manifest path.
    { command: `python3 ${DIR}/scripts/check.py`, argv: [], script: "scripts/check.py" },
    { command: "python3 scripts/check.py a", argv: ["a"], script: "scripts/check.py" },
    {
      command: "python3 ${CLAUDE_SKILL_DIR}/scripts/check.py ${CLAUDE_SKILL_DIR}/references/a.md",
      argv: [`${DIR}/references/a.md`],
      script: "scripts/check.py",
    },
    // Adjacent parts make one word; tabs separate words; quotes keep what the shell would expand.
    {
      command: "python3\tscripts/check.py a'b c'\"d\" '$HOME' '*'",
      argv: ["ab cd", "$HOME", "*"],
      script: "scripts/check.py",
    },
    { command: "python scripts/fmt.py --mode=fix", argv: ["--mode=fix"], script: "scripts/fmt.py" },
    { command: "python3 scripts/stance.py", argv: [], script: "scripts/stance.py" },
    { command: "python3 scripts/stance.py x y", argv: ["x", "y"], script: "scripts/stance.py" },
  ])("runs $command as python3, the pinned file's absolute path, then its words", ({ command, argv, script }) => {
    expect(argvOf(command)).toEqual({ argv: ["python3", `${DIR}/${script}`, ...argv], script });
  });
});

describe("a command that does not run", () => {
  const notAllowed = { issue: "the command is not one the skill allows" };

  it.each(["|", "&", ";", "<", ">", "(", ")", "{", "}", "$", "`", "\\", "*", "?", "[", "]", "#", "~", "!"])(
    "refuses %s outside quotes",
    (character) => {
      expect(argvOf(`python3 scripts/check.py a${character}b`)).toEqual({
        issue: `${JSON.stringify(character)} outside quotes is not taken: no shell runs the command`,
      });
    },
  );

  it.each([
    ["python3 scripts/check.py $HOME", { issue: '"$" outside quotes is not taken: no shell runs the command' }],
    ["python3 scripts/check.py $(id)", { issue: '"$" outside quotes is not taken: no shell runs the command' }],
    ["python3 scripts/check.py `id`", { issue: '"`" outside quotes is not taken: no shell runs the command' }],
    ['python3 scripts/check.py "$HOME"', { issue: "a double-quoted string holds $, a backtick or a backslash" }],
    ['python3 scripts/check.py "`id`"', { issue: "a double-quoted string holds $, a backtick or a backslash" }],
    ['python3 scripts/check.py "a\\b"', { issue: "a double-quoted string holds $, a backtick or a backslash" }],
    ["python3 scripts/check.py 'open", { issue: "a single quote is not closed" }],
    ['python3 scripts/check.py "open', { issue: "a double quote is not closed" }],
    ["python3 scripts/check.py a\nb", { issue: '"\\n" outside quotes is not taken: no shell runs the command' }],
    ["python3 scripts/check.py a\0b", { issue: "the command holds a NUL character" }],
    ["python3 scripts/check.py 'a\0b'", { issue: "the command holds a NUL character" }],
    ["", { issue: "the command is empty" }],
    [" \t ", { issue: "the command is empty" }],
    // ${CLAUDE_SKILL_DIR} expands only at a word's start.
    [
      "python3 x${CLAUDE_SKILL_DIR}/scripts/check.py",
      { issue: '"$" outside quotes is not taken: no shell runs the command' },
    ],
    // Scripts outside the skill, other interpreters, other files, the interpreter as another entry wrote it.
    ["python3 ../check.py", notAllowed],
    ["python3 /etc/check.py", notAllowed],
    ["python3 ${CLAUDE_SKILL_DIR}/../polish/scripts/check.py", notAllowed],
    ["python3 /workspace/skills/other/scripts/check.py", notAllowed],
    ["bash scripts/check.py", notAllowed],
    ["python3.12 scripts/check.py", notAllowed],
    ["python scripts/check.py", notAllowed],
    ["python3 scripts/fmt.py --mode=fix", notAllowed],
    ["python3 references/a.md", notAllowed],
    // An entry's fixed words, exactly, and nothing after them.
    ["python scripts/fmt.py", notAllowed],
    ["python scripts/fmt.py --mode=check", notAllowed],
    ["python scripts/fmt.py --mode=fix extra", notAllowed],
    ["${CLAUDE_SKILL_DIR}/scripts/check.py", notAllowed],
  ])("refuses %j", (command, issue) => {
    expect(argvOf(command)).toEqual(issue);
  });
});

describe("an allowed-tools entry", () => {
  it.each([
    [
      "Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/check.py *)",
      {
        command: "python3 ${CLAUDE_SKILL_DIR}/scripts/check.py *",
        interpreter: "python3",
        script: "scripts/check.py",
        rest: true,
      },
    ],
    [
      "Bash(python3 scripts/check.py:*)",
      { command: "python3 scripts/check.py:*", interpreter: "python3", script: "scripts/check.py", rest: true },
    ],
    [
      "Bash(python  scripts/check.py --flag)",
      { command: "python  scripts/check.py --flag", interpreter: "python", script: "scripts/check.py", rest: false },
    ],
  ])("runs in the cloud as %s", (entry, fields) => {
    expect(parseEntry(entry)).toMatchObject({ entry, ...fields });
  });

  it.each([
    "Read",
    "Bash(git:*)",
    "Bash(python3)",
    "Bash(py -3 scripts/check.py)",
    "Bash(node scripts/check.py)",
    "Bash(python3 scripts/check.py * more)",
    "Bash(python3 scripts/check.py | tee out)",
    "Bash(python3 ${CLAUDE_SKILL_DIR}/../check.py)",
    "Bash(python3 /abs/check.py)",
    "Bash(${CLAUDE_SKILL_DIR}/scripts/check.py)",
  ])("does not run in the cloud as %s", (entry) => {
    expect(parseEntry(entry)).toBeNull();
  });

  it("runs only when its script is one of the skill's files, as the stored copy and a preview mark it", () => {
    expect(runnableEntry("Bash(python3 scripts/missing.py)", FILES)).toBeNull();
    expect(
      allowedToolsOf(["Bash(python3 scripts/check.py *)", "Bash(python3 scripts/missing.py)", "Read"], [...FILES]),
    ).toEqual([
      { entry: "Bash(python3 scripts/check.py *)", runs: true },
      { entry: "Bash(python3 scripts/missing.py)", runs: false },
      { entry: "Read", runs: false },
    ]);
  });
});
