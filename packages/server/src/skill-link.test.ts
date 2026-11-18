import {
  SKILL_ALLOWED_TOOLS_CHARS,
  SKILL_DESCRIPTION_CHARS,
  SKILL_LICENSE_CHARS,
  SKILL_PATH_BYTES,
  skillManifestIssue,
  skillPathIssue,
} from "@prq/protocol";
import { describe, expect, it } from "vitest";

import { parseSkillLink } from "./instructions/link.ts";
import { readSkillMd } from "./instructions/skill.ts";

// A skill's link, its SKILL.md's frontmatter and its paths, read without GitHub (docs/design.md, Instructions and
// skills).

const utf8 = new TextEncoder();

function skillMd(fields: string, body = "# Body\n"): Uint8Array {
  return utf8.encode(`---\n${fields}\n---\n${body}`);
}

describe("a skill's link", () => {
  it("takes the repository and the segments between blob/ and the final SKILL.md", () => {
    expect(parseSkillLink("https://github.com/nanaism/yomiyasu/blob/main/skills/yomiyasu/SKILL.md")).toEqual({
      owner: "nanaism",
      repo: "yomiyasu",
      segments: ["main", "skills", "yomiyasu"],
    });
    // A skill at the root leaves the ref alone; the query and the fragment are ignored; segments are decoded.
    expect(parseSkillLink("https://github.com/o/r/blob/main/SKILL.md")).toEqual({
      owner: "o",
      repo: "r",
      segments: ["main"],
    });
    expect(parseSkillLink("https://github.com/o/r/blob/pr/oga/v3.2.0/skills/y/SKILL.md?plain=1#L1")).toEqual({
      owner: "o",
      repo: "r",
      segments: ["pr", "oga", "v3.2.0", "skills", "y"],
    });
    expect(parseSkillLink("  https://github.com/o/r/blob/main/%E8%AA%AD%E3%82%80/SKILL.md\n")).toEqual({
      owner: "o",
      repo: "r",
      segments: ["main", "読む"],
    });
  });

  it.each([
    ["another host", "https://gitlab.com/o/r/blob/main/SKILL.md"],
    ["a host ending in github.com", "https://github.com.example/o/r/blob/main/SKILL.md"],
    ["http", "http://github.com/o/r/blob/main/SKILL.md"],
    ["a port", "https://github.com:443/o/r/blob/main/SKILL.md"],
    ["credentials", "https://user@github.com/o/r/blob/main/SKILL.md"],
    ["a tree link", "https://github.com/o/r/tree/main/skills/x"],
    ["a raw link", "https://raw.githubusercontent.com/o/r/main/SKILL.md"],
    ["github.com/raw", "https://github.com/o/r/raw/main/SKILL.md"],
    ["another file", "https://github.com/o/r/blob/main/README.md"],
    ["a lowercase skill.md", "https://github.com/o/r/blob/main/skill.md"],
    ["no ref", "https://github.com/o/r/blob/SKILL.md"],
    ["a .. segment", "https://github.com/o/r/blob/main/a/../SKILL.md"],
    ["an encoded .. segment", "https://github.com/o/r/blob/main/a/%2e%2e/SKILL.md"],
    ["a . segment", "https://github.com/o/r/blob/main/./SKILL.md"],
    ["an empty segment", "https://github.com/o/r/blob/main//SKILL.md"],
    ["a trailing slash", "https://github.com/o/r/blob/main/SKILL.md/"],
    ["an encoded /", "https://github.com/o/r/blob/main/a%2Fb/SKILL.md"],
    ["bad percent-encoding", "https://github.com/o/r/blob/main/%E8/SKILL.md"],
    ["an owner GitHub refuses", "https://github.com/-o/r/blob/main/SKILL.md"],
    ["not a URL", "github.com/o/r/blob/main/SKILL.md"],
  ])("refuses %s", (_, link) => {
    expect(parseSkillLink(link)).toHaveProperty("issue");
  });
});

describe("a SKILL.md's frontmatter", () => {
  const YOMIYASU_TOOLS =
    "Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/yomiyasu_lint.py *) Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/yomiyasu_check.py *) " +
    "Bash(python ${CLAUDE_SKILL_DIR}/scripts/yomiyasu_lint.py *) Bash(python ${CLAUDE_SKILL_DIR}/scripts/yomiyasu_check.py *) " +
    "Bash(py -3 ${CLAUDE_SKILL_DIR}/scripts/yomiyasu_lint.py *) Bash(py -3 ${CLAUDE_SKILL_DIR}/scripts/yomiyasu_check.py *)";

  it("keeps name, description and license, and allowed-tools as its entries, written as a string or a list", () => {
    expect(
      readSkillMd(
        skillMd(`name: yomiyasu\ndescription: Polishes text.\nlicense: MIT\nallowed-tools: ${YOMIYASU_TOOLS}`),
      ),
    ).toEqual({
      name: "yomiyasu",
      description: "Polishes text.",
      license: "MIT",
      allowedTools: [
        "Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/yomiyasu_lint.py *)",
        "Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/yomiyasu_check.py *)",
        "Bash(python ${CLAUDE_SKILL_DIR}/scripts/yomiyasu_lint.py *)",
        "Bash(python ${CLAUDE_SKILL_DIR}/scripts/yomiyasu_check.py *)",
        "Bash(py -3 ${CLAUDE_SKILL_DIR}/scripts/yomiyasu_lint.py *)",
        "Bash(py -3 ${CLAUDE_SKILL_DIR}/scripts/yomiyasu_check.py *)",
      ],
    });
    expect(
      readSkillMd(
        skillMd("name: a\ndescription: >\n  Folded\n  text.\nallowed-tools:\n  - Read\n  - Bash(git status)"),
      ),
    ).toEqual({ name: "a", description: "Folded text.\n", license: null, allowedTools: ["Read", "Bash(git status)"] });
    // Absent fields are null; other fields are ignored; a BOM and CRLF line ends are read.
    expect(readSkillMd(utf8.encode("﻿---\r\nname: a\r\ndescription: d\r\nmetadata:\r\n  x: 1\r\n---\r\nbody"))).toEqual({
      name: "a",
      description: "d",
      license: null,
      allowedTools: null,
    });
  });

  it("takes each bound at its cap and refuses it one past", () => {
    const at = (fields: string) => readSkillMd(skillMd(`name: a\n${fields}`));
    expect(at(`description: ${"d".repeat(SKILL_DESCRIPTION_CHARS)}`)).not.toHaveProperty("issue");
    expect(at(`description: ${"d".repeat(SKILL_DESCRIPTION_CHARS + 1)}`)).toHaveProperty("issue");
    expect(at(`description: d\nlicense: ${"l".repeat(SKILL_LICENSE_CHARS)}`)).not.toHaveProperty("issue");
    expect(at(`description: d\nlicense: ${"l".repeat(SKILL_LICENSE_CHARS + 1)}`)).toMatchObject({
      issue: expect.stringContaining("license"),
    });
    expect(at(`description: d\nallowed-tools: ${"t".repeat(SKILL_ALLOWED_TOOLS_CHARS)}`)).not.toHaveProperty("issue");
    expect(at(`description: d\nallowed-tools: ${"t".repeat(SKILL_ALLOWED_TOOLS_CHARS + 1)}`)).toMatchObject({
      issue: expect.stringContaining("allowed-tools"),
    });
    // A list counts its entries joined by spaces.
    const half = "t".repeat(SKILL_ALLOWED_TOOLS_CHARS / 2);
    expect(at(`description: d\nallowed-tools:\n  - ${half.slice(1)}\n  - ${half}`)).not.toHaveProperty("issue");
    expect(at(`description: d\nallowed-tools:\n  - ${half}\n  - ${half}`)).toHaveProperty("issue");
    expect(readSkillMd(skillMd(`name: ${"a".repeat(64)}\ndescription: d`))).not.toHaveProperty("issue");
    expect(readSkillMd(skillMd(`name: ${"a".repeat(65)}\ndescription: d`))).toHaveProperty("issue");
  });

  it.each([
    ["not UTF-8", new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a])],
    ["no frontmatter", utf8.encode("# Title\nname: a\n")],
    ["an unclosed frontmatter", utf8.encode("---\nname: a\ndescription: d\n")],
    ["YAML that does not parse", skillMd("name: a\ndescription: [d")],
    ["an alias", skillMd("name: &n a\ndescription: *n")],
    ["a duplicate key", skillMd("name: a\nname: b\ndescription: d")],
    ["a list", skillMd("- name: a")],
    ["no name", skillMd("description: d")],
    ["a name in capitals", skillMd("name: Polish\ndescription: d")],
    ["a name with a doubled hyphen", skillMd("name: a--b\ndescription: d")],
    ["a name with a leading hyphen", skillMd("name: -a\ndescription: d")],
    ["a name that is a number", skillMd("name: 12\ndescription: d")],
    ["no description", skillMd("name: a")],
    ["a blank description", skillMd("name: a\ndescription: '  '")],
    ["a license that is a number", skillMd("name: a\ndescription: d\nlicense: 2")],
    ["allowed-tools as a map", skillMd("name: a\ndescription: d\nallowed-tools:\n  Read: true")],
    ["allowed-tools with a number", skillMd("name: a\ndescription: d\nallowed-tools:\n  - 1")],
  ])("refuses %s", (_, bytes) => {
    expect(readSkillMd(bytes)).toHaveProperty("issue");
  });
});

describe("a skill's paths", () => {
  it("takes a relative path of up to SKILL_PATH_BYTES UTF-8 bytes, multibyte counted in bytes", () => {
    const atCap = `a/bb${"あ".repeat((SKILL_PATH_BYTES - 4) / 3)}`;
    expect(utf8.encode(atCap).byteLength).toBe(SKILL_PATH_BYTES);
    expect(skillPathIssue(atCap)).toBeNull();
    expect(skillPathIssue(`${atCap}x`)).toMatch(/longer than 100 bytes/);
    const refused = ["", "/a", "a/", "a//b", "./a", "a/../b", "..", "a\\b", "a\0b"];
    expect(refused.filter((path) => skillPathIssue(path) === null)).toEqual([]);
  });

  it("refuses two paths whose first differing components are equal but for case, and takes the others", () => {
    expect(skillManifestIssue(["Docs/a.md", "docs/b.md"])).toMatch(/differ only in the case/);
    expect(skillManifestIssue(["SKILL.md", "Readme.md", "README.md"])).toMatch(/Readme\.md.*README\.md/);
    // Unicode normalization too: é composed and decomposed.
    expect(skillManifestIssue(["café.md", "café.md"])).not.toBeNull();
    expect(skillManifestIssue(["docs/a.md", "docs/b.md"])).toBeNull();
    expect(skillManifestIssue(["a/Docs/x.md", "b/docs/y.md"])).toBeNull();
  });
});
