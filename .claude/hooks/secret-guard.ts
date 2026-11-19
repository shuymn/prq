#!/usr/bin/env node
// Claude Code PreToolUse hook (.claude/settings.json): no command or file read in this repository shows a secret file,
// the owner's secrets directory (~/.config/prq, in any spelling of the home directory) or packages/server/.dev.vars,
// which the dev-vars script writes from it (packages/cli/src/test/dev-vars.ts). Any mention in a command is refused,
// since a "harmless" listing (`cut -d= -f1`) still prints a multi-line value, except a file passed as "$(cat <file>)"
// to the command that needs it, which is how a secret delivered as a file is used. The dev-vars script's command lines
// name neither path. A Read, Grep or Glob is refused when its path names one.
//
// Reads the hook's JSON on stdin; prints a deny decision, or nothing to let the call through.

import { readFileSync } from "node:fs";

// A .dev.vars, but not .dev.vars.example or another .dev.vars.* name; any file under the secrets directory, or the
// directory itself.
const SECRET_FILE = /\.dev\.vars(?![\w.])|\.config\/prq(?![\w.-])/;
const CAT_SUBST = new RegExp(
  String.raw`"?\$\((?:cat\s+|<\s*)["']?[^"')]*(?:` + SECRET_FILE.source + String.raw`)[^"')]*["']?\)"?`,
  "g",
);
const REASON =
  "Commands and reads must not show a secret file (packages/server/.dev.vars, or one under ~/.config/prq). Pass a " +
  'secret file only as "$(cat <file>)" to the command that needs it. Write and remove packages/server/.dev.vars only ' +
  "with the dev-vars script, in packages/cli: `pnpm run dev-vars write [--window <tokens>]`, `pnpm run dev-vars " +
  "status` (names the variables it sets) and `pnpm run dev-vars remove`; none of them prints a secret.";

// A field of a JSON object, or undefined.
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function shows(input: unknown): boolean {
  const tool = field(input, "tool_name");
  const parameters = field(input, "tool_input");
  if (tool === "Bash") return SECRET_FILE.test(text(field(parameters, "command")).replace(CAT_SUBST, ""));
  if (tool === "Read" || tool === "Grep" || tool === "Glob") {
    return SECRET_FILE.test(`${text(field(parameters, "file_path"))} ${text(field(parameters, "path"))}`);
  }
  return false;
}

const input: unknown = JSON.parse(readFileSync(0, "utf8"));
if (shows(input)) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: REASON },
    }),
  );
}
