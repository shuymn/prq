import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SKILL_FILES, type SkillFilesResponse } from "@prq/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "./errors.ts";
import { blobSha, readSkillFiles, writeSkillFiles } from "./skills.ts";

type Entry = SkillFilesResponse["files"][number];

function entry(path: string, text: string, mode: Entry["mode"] = "100644"): Entry {
  const bytes = Buffer.from(text);
  return { path, mode, size: bytes.byteLength, blob: blobSha(bytes), content: bytes.toString("base64") };
}

// Answers the pages in order, recording the cursor each asked with.
function pages(...answers: SkillFilesResponse[]) {
  const asked: (string | undefined)[] = [];
  const page = async (cursor: string | undefined) => {
    asked.push(cursor);
    const answer = answers.shift();
    if (answer === undefined) {
      throw new Error("no page left");
    }
    return answer;
  };
  return { asked, page };
}

async function refusal(...answers: SkillFilesResponse[]): Promise<string> {
  const error: unknown = await readSkillFiles("polish", pages(...answers).page).then(
    () => null,
    (failure: unknown) => failure,
  );
  if (!(error instanceof CliError) || error.exitCode !== 1) {
    throw new Error(`expected exit 1, got ${String(error)}`);
  }
  return error.message;
}

describe("readSkillFiles", () => {
  it("joins the pages, following each cursor, into the files with their bytes", async () => {
    const { asked, page } = pages(
      { files: [entry("SKILL.md", "---\nname: polish\n---\n")], nextCursor: "scripts/check.py" },
      { files: [entry("scripts/check.py", "print(1)\n", "100755")], nextCursor: null },
    );
    const files = await readSkillFiles("polish", page);
    expect(asked).toEqual([undefined, "scripts/check.py"]);
    expect(files.map(({ path, mode, content }) => ({ path, mode, text: content.toString() }))).toEqual([
      { path: "SKILL.md", mode: "100644", text: "---\nname: polish\n---\n" },
      { path: "scripts/check.py", mode: "100755", text: "print(1)\n" },
    ]);
  });

  it("refuses a wrong byte, a wrong size, a path twice, a cursor read before and a path the shared check refuses", async () => {
    const good = entry("SKILL.md", "body");
    const wrongByte = { ...good, content: Buffer.from("bodY").toString("base64") };
    expect(await refusal({ files: [wrongByte], nextCursor: null })).toBe(
      `the skill polish is refused: the bytes of "SKILL.md" are not its blob ${good.blob}`,
    );
    expect(await refusal({ files: [{ ...good, size: 5 }], nextCursor: null })).toBe(
      'the skill polish is refused: "SKILL.md" holds 4 bytes, not 5',
    );
    expect(await refusal({ files: [good], nextCursor: "a" }, { files: [good], nextCursor: null })).toBe(
      'the skill polish is refused: the path "SKILL.md" comes twice',
    );
    expect(
      await refusal(
        { files: [good], nextCursor: "a" },
        { files: [entry("a", "a")], nextCursor: "b" },
        { files: [entry("b", "b")], nextCursor: "a" },
      ),
    ).toBe("the skill polish is refused: a page names a cursor already read");
    expect(await refusal({ files: [good, entry("../x", "x")], nextCursor: null })).toBe(
      'the skill polish is refused: the path "../x" has an empty, . or .. segment',
    );
  });

  it("refuses paths that differ only in case where they first differ, naming both, and accepts the rest", async () => {
    expect(await refusal({ files: [entry("README.md", "a"), entry("Readme.md", "b")], nextCursor: null })).toBe(
      'the skill polish is refused: the paths "README.md" and "Readme.md" differ only in the case of "Readme.md"',
    );
    expect(
      await refusal(
        { files: [entry("Docs/a.md", "a")], nextCursor: "d" },
        {
          files: [entry("docs/b.md", "b")],
          nextCursor: null,
        },
      ),
    ).toBe('the skill polish is refused: the paths "Docs/a.md" and "docs/b.md" differ only in the case of "docs"');

    const accepted = pages({
      files: [
        entry("SKILL.md", "s"),
        entry("a/Docs/x.md", "x"),
        entry("b/docs/y.md", "y"),
        entry("docs/a.md", "a"),
        entry("docs/b.md", "b"),
      ],
      nextCursor: null,
    });
    expect((await readSkillFiles("polish", accepted.page)).map((file) => file.path)).toEqual([
      "SKILL.md",
      "a/Docs/x.md",
      "b/docs/y.md",
      "docs/a.md",
      "docs/b.md",
    ]);
  });

  it("refuses a page with no files", async () => {
    expect(await refusal({ files: [entry("SKILL.md", "s")], nextCursor: "a" }, { files: [], nextCursor: null })).toBe(
      "the skill polish is refused: a page holds no files",
    );
  });

  it("refuses a skill with no SKILL.md at its root", async () => {
    expect(await refusal({ files: [entry("docs/SKILL.md", "s"), entry("skill.md", "s")], nextCursor: null })).toBe(
      "the skill polish is refused: it has no SKILL.md at its root",
    );
  });

  it("stops reading past SKILL_FILES files", async () => {
    const many = Array.from({ length: SKILL_FILES + 1 }, (_, index) => entry(`f${index}`, ""));
    const { asked, page } = pages(
      { files: many.slice(0, SKILL_FILES), nextCursor: "next" },
      { files: many.slice(SKILL_FILES), nextCursor: "after" },
    );
    await expect(readSkillFiles("polish", page)).rejects.toThrow(`it has more than ${SKILL_FILES} files`);
    expect(asked).toEqual([undefined, "next"]);
  });
});

describe("writeSkillFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prq-skill-files-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes each file at its path with mode 0755 for 100755 and 0644 otherwise, and never over an entry", async () => {
    const target = join(dir, "polish");
    const files = [
      { path: "SKILL.md", mode: "100644" as const, content: Buffer.from("body") },
      { path: "scripts/deep/check.py", mode: "100755" as const, content: Buffer.from("print(1)\n") },
    ];
    await writeSkillFiles(target, files);

    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("body");
    expect((await stat(join(target, "SKILL.md"))).mode & 0o777).toBe(0o644);
    expect(await readFile(join(target, "scripts/deep/check.py"), "utf8")).toBe("print(1)\n");
    expect((await stat(join(target, "scripts/deep/check.py"))).mode & 0o777).toBe(0o755);

    await writeFile(join(dir, "taken"), "kept");
    await expect(
      writeSkillFiles(dir, [{ path: "taken", mode: "100644", content: Buffer.from("new") }]),
    ).rejects.toThrow("EEXIST");
    expect(await readFile(join(dir, "taken"), "utf8")).toBe("kept");
  });
});
