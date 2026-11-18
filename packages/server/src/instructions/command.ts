import { skillPathIssue } from "@prq/protocol";

import { RUNNER_ROOT } from "../skill-runner.ts";

// A skill script's command (docs/design.md, Workspace (cloud)): prq's own small grammar, never a shell. The words of a
// command the model writes and of each `allowed-tools` entry are read by the same function, and a command runs only
// when it matches an entry prq runs in the cloud (`Bash(python3|python <a file of the skill> [*])`); its argv is then
// built from the entry, the pinned file's absolute path in place of the model's script word.

// Where the container's runner installs a skill: `${CLAUDE_SKILL_DIR}` is this directory.
const SKILLS_ROOT = `${RUNNER_ROOT}/skills`;

function skillDirectory(name: string): string {
  return `${SKILLS_ROOT}/${name}`;
}

// The longest command the model may write, in UTF-16 code units.
export const COMMAND_CHARS = 4000;

// A word as written: its text after a leading `${CLAUDE_SKILL_DIR}` (`skillDir`), or the whole word.
type Word = { skillDir: boolean; text: string };

const SKILL_DIR = "${CLAUDE_SKILL_DIR}";
// What an unquoted part may not hold: whitespace and every shell metacharacter.
const UNQUOTED_REFUSED = /[\s|&;<>(){}$`\\"'*?[\]#~!]/;
// What a double-quoted part may not hold.
const DOUBLE_QUOTED_REFUSED = /[$`\\]/;

// The words of a command, or why it is refused: words separated by spaces or tabs, each a run of unquoted characters
// other than whitespace and `| & ; < > ( ) { } $ \` \ " ' * ? [ ] # ~ !`, a single-quoted string (no escapes) or a
// double-quoted string holding none of `$ \` \`, adjacent parts joined into one word, and no NUL anywhere; the only
// expansion is `${CLAUDE_SKILL_DIR}` at a word's start.
function commandWords(command: string): Word[] | { issue: string } {
  // An argument cannot hold a NUL, quoted or not.
  if (command.includes("\0")) {
    return { issue: "the command holds a NUL character" };
  }
  const words: Word[] = [];
  let index = 0;
  while (index < command.length) {
    if (command[index] === " " || command[index] === "\t") {
      index += 1;
      continue;
    }
    const skillDir = command.startsWith(SKILL_DIR, index);
    if (skillDir) {
      index += SKILL_DIR.length;
    }
    let text = "";
    for (;;) {
      const next = command[index];
      if (next === undefined || next === " " || next === "\t") {
        break;
      }
      if (next === "'" || next === '"') {
        const end = command.indexOf(next, index + 1);
        if (end === -1) {
          return { issue: `a ${next === "'" ? "single" : "double"} quote is not closed` };
        }
        const quoted = command.slice(index + 1, end);
        if (next === '"' && DOUBLE_QUOTED_REFUSED.test(quoted)) {
          return { issue: "a double-quoted string holds $, a backtick or a backslash" };
        }
        text += quoted;
        index = end + 1;
      } else if (UNQUOTED_REFUSED.test(next)) {
        return { issue: `${JSON.stringify(next)} outside quotes is not taken: no shell runs the command` };
      } else {
        text += next;
        index += 1;
      }
    }
    words.push({ skillDir, text });
  }
  if (words.length === 0) {
    return { issue: "the command is empty" };
  }
  return words;
}

// The interpreters a runnable entry may name; both run the image's python3.
const INTERPRETERS = new Set(["python3", "python"]);

// An entry prq runs in the cloud: the command it stands for (the words inside `Bash(…)`, as an activation lists them),
// its interpreter word, the manifest path of its script, the words it requires after the script, and whether it takes
// any further words (a trailing ` *` or `:*`).
export type RunnableEntry = {
  entry: string;
  command: string;
  interpreter: string;
  script: string;
  words: Word[];
  rest: boolean;
};

// The path a script word names in the skill, or null: `${CLAUDE_SKILL_DIR}/<path>`, the skill's directory as an
// absolute path followed by `/<path>` (with `name`), or a relative `<path>`, each through the shared path validator.
function scriptPath(word: Word, name: string | null): string | null {
  let path: string;
  if (word.skillDir) {
    if (!word.text.startsWith("/")) {
      return null;
    }
    path = word.text.slice(1);
  } else if (name !== null && word.text.startsWith(`${skillDirectory(name)}/`)) {
    path = word.text.slice(skillDirectory(name).length + 1);
  } else {
    path = word.text;
  }
  return skillPathIssue(path) === null ? path : null;
}

// An allowed-tools entry in the form prq runs in the cloud, or null for every other form (`Read`, `Bash(git:*)`,
// `py -3`, a `*` anywhere but last): `Bash(<interpreter> <script> [<words>] [*])` or `… :*)`, the interpreter python3
// or python, the script `${CLAUDE_SKILL_DIR}/<path>` or `<path>` through the shared path validator.
export function parseEntry(entry: string): RunnableEntry | null {
  const inner = /^Bash\((.*)\)$/su.exec(entry)?.[1];
  if (inner === undefined) {
    return null;
  }
  const rest = inner.endsWith(" *") || inner.endsWith(":*");
  const words = commandWords(rest ? inner.slice(0, -2) : inner);
  if ("issue" in words) {
    return null;
  }
  const [interpreter, script, ...required] = words;
  if (
    interpreter === undefined ||
    interpreter.skillDir ||
    !INTERPRETERS.has(interpreter.text) ||
    script === undefined
  ) {
    return null;
  }
  const path = scriptPath(script, null);
  return path === null
    ? null
    : { entry, command: inner, interpreter: interpreter.text, script: path, words: required, rest };
}

// An entry prq runs in the cloud for a skill: its form, and its script one of the skill's stored files.
export function runnableEntry(entry: string, files: ReadonlySet<string>): RunnableEntry | null {
  const parsed = parseEntry(entry);
  return parsed !== null && files.has(parsed.script) ? parsed : null;
}

// A word's value in the container: `${CLAUDE_SKILL_DIR}` expanded to the skill's directory.
function expanded(word: Word, name: string): string {
  return word.skillDir ? `${skillDirectory(name)}${word.text}` : word.text;
}

// The argv a command runs as, or why it does not run: its words matched against the skill's runnable entries (the
// interpreter word as the entry wrote it, the script naming the same file, then the entry's words, then any words when
// the entry ends with `*`); argv is python3, the pinned file's absolute path, then the command's words after its
// script.
export function commandArgv(
  command: string,
  name: string,
  entries: readonly RunnableEntry[],
): { argv: string[]; script: string } | { issue: string } {
  const words = commandWords(command);
  if ("issue" in words) {
    return words;
  }
  const [interpreter, script, ...after] = words;
  const path = script === undefined ? null : scriptPath(script, name);
  const values = after.map((word) => expanded(word, name));
  const entry = entries.find(
    (candidate) =>
      interpreter !== undefined &&
      !interpreter.skillDir &&
      interpreter.text === candidate.interpreter &&
      path === candidate.script &&
      (candidate.rest ? values.length >= candidate.words.length : values.length === candidate.words.length) &&
      candidate.words.every((word, index) => expanded(word, name) === values[index]),
  );
  if (entry === undefined) {
    return { issue: "the command is not one the skill allows" };
  }
  return { argv: ["python3", `${skillDirectory(name)}/${entry.script}`, ...values], script: entry.script };
}
