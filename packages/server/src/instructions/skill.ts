import {
  SKILL_ALLOWED_TOOLS_CHARS,
  SKILL_DESCRIPTION_CHARS,
  SKILL_LICENSE_CHARS,
  SKILL_NAME_CHARS,
  SkillName,
} from "@prq/protocol";
import * as v from "valibot";
import { parse } from "yaml";

// A SKILL.md's frontmatter (the Agent Skills specification): the fields prq keeps, each within its bound. Anything
// else in it is ignored.
export type SkillFrontmatter = {
  name: string;
  description: string;
  license: string | null;
  // Each entry of allowed-tools as written; null when the field is absent.
  allowedTools: string[] | null;
};

// The bytes as UTF-8, a leading BOM dropped; null when they are not UTF-8.
function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

const NAME_ISSUE = `name is not a skill name (1–${SKILL_NAME_CHARS} lowercase letters, digits and single hyphens)`;
const DESCRIPTION_ISSUE = `description is not 1–${SKILL_DESCRIPTION_CHARS} characters`;

// The fields prq keeps, each issue naming its field; an absent license or allowed-tools is null or undefined.
const Fields = v.object({
  name: v.pipe(
    v.string(NAME_ISSUE),
    v.check((name) => v.is(SkillName, name), NAME_ISSUE),
  ),
  description: v.pipe(
    v.string(DESCRIPTION_ISSUE),
    v.check((text) => text.trim() !== "", DESCRIPTION_ISSUE),
    v.maxLength(SKILL_DESCRIPTION_CHARS, DESCRIPTION_ISSUE),
  ),
  license: v.nullish(
    v.pipe(
      v.string("license is not a string"),
      v.maxLength(SKILL_LICENSE_CHARS, `license is longer than ${SKILL_LICENSE_CHARS} characters`),
    ),
  ),
  "allowed-tools": v.nullish(
    v.union([v.string(), v.array(v.string())], "allowed-tools is neither a string nor a list of strings"),
  ),
});

// allowed-tools' entries as written: a string split at whitespace outside parentheses (`Bash(python3 x.py *) Read` is
// two entries), or a list's items.
function allowedToolsEntries(field: string | string[]): string[] {
  if (Array.isArray(field)) {
    return field;
  }
  const entries: string[] = [];
  let entry = "";
  let depth = 0;
  for (const char of field) {
    if (/\s/.test(char) && depth === 0) {
      if (entry !== "") {
        entries.push(entry);
      }
      entry = "";
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")" && depth > 0) {
      depth -= 1;
    }
    entry += char;
  }
  if (entry !== "") {
    entries.push(entry);
  }
  return entries;
}

// A frontmatter delimiter line, read without its trailing whitespace, so with or without a line end, LF or CRLF.
function isDelimiter(line: string | undefined): boolean {
  return line?.trimEnd() === "---";
}

// Where a SKILL.md's frontmatter closes: the first delimiter line after a first line that is one, or -1 when there is
// no frontmatter between them.
function frontmatterEnd(lines: readonly string[]): number {
  return isDelimiter(lines[0]) ? lines.findIndex((line, index) => index > 0 && isDelimiter(line)) : -1;
}

// A SKILL.md's body: its text after the frontmatter's closing `---` line and that line's end, as stored (a leading BOM
// dropped); null when the bytes are not UTF-8 or hold no frontmatter, which registration refuses.
export function skillBody(bytes: Uint8Array): string | null {
  // Each line with its line end, so the lines after the closing one join into the rest exactly.
  const lines = utf8Text(bytes)?.split(/(?<=\n)/) ?? [];
  const end = frontmatterEnd(lines);
  return end === -1 ? null : lines.slice(end + 1).join("");
}

// The frontmatter of a SKILL.md, or why it is refused: the text between a first line `---` and the next `---` line,
// read as YAML with aliases refused; name in the specification's form, description 1–1,024 characters, license and
// allowed-tools within their caps.
export function readSkillMd(bytes: Uint8Array): SkillFrontmatter | { issue: string } {
  const text = utf8Text(bytes);
  if (text === null) {
    return { issue: "SKILL.md is not UTF-8" };
  }
  const lines = text.split(/\r?\n/);
  const end = frontmatterEnd(lines);
  if (end === -1) {
    return { issue: "SKILL.md has no frontmatter between --- lines" };
  }
  let fields: unknown;
  try {
    fields = parse(lines.slice(1, end).join("\n"), { maxAliasCount: 0, logLevel: "error" });
  } catch (error) {
    const reason = error instanceof Error ? (error.message.split("\n")[0] ?? "") : "";
    return { issue: `SKILL.md's frontmatter is not YAML this reads: ${reason.slice(0, 200)}` };
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return { issue: "SKILL.md's frontmatter is not a mapping" };
  }
  const record = Object.fromEntries(Object.entries(fields));
  // Each kept field is read, present or not, so an absent one gets its own field's issue.
  const read = v.safeParse(Fields, {
    name: record["name"],
    description: record["description"],
    license: record["license"],
    "allowed-tools": record["allowed-tools"],
  });
  if (!read.success) {
    return { issue: `the frontmatter's ${read.issues[0].message}` };
  }
  const { name, description, license, "allowed-tools": allowedTools } = read.output;
  // A list's length is its entries' joined by spaces, as the string form would be.
  const chars = typeof allowedTools === "string" ? allowedTools.length : (allowedTools?.join(" ").length ?? 0);
  if (chars > SKILL_ALLOWED_TOOLS_CHARS) {
    return { issue: `the frontmatter's allowed-tools is longer than ${SKILL_ALLOWED_TOOLS_CHARS} characters` };
  }
  return {
    name,
    description,
    license: license ?? null,
    allowedTools: allowedTools === null || allowedTools === undefined ? null : allowedToolsEntries(allowedTools),
  };
}
