import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";

import { SKILL_BYTES, SKILL_FILES, type SkillFilesResponse, skillPathsIssue } from "@prq/protocol";

import { CliError, EXIT } from "./errors.ts";

// The host's skills as prq context writes them for a local agent (docs/design.md, Local CLI): each registered skill's
// files at the revision the context listed, read from /cli/skill and checked before any of them is written.

// A file of a skill, read and checked: its path in the skill, git mode and bytes.
export type SkillFile = { path: string; mode: "100644" | "100755"; content: Buffer };

// The git blob SHA-1 of a file's bytes, as a tree names it.
export function blobSha(content: Uint8Array): string {
  return createHash("sha1").update(`blob ${content.byteLength}\0`).update(content).digest("hex");
}

// Reads every page of a skill's files, from no cursor until nextCursor is null, and checks them before the caller
// writes any: every page holds files, each file's bytes have its size and hash to its blob, no path comes twice, the
// skill stays within SKILL_FILES and SKILL_BYTES while it is read (so a server cannot make prq hold more), the paths
// pass the shared checks (no two differing only in case among them, which a case-insensitive disk would merge), and a
// SKILL.md is at the skill's root. A cursor seen before ends the read, as a context's does.
export async function readSkillFiles(
  name: string,
  page: (cursor: string | undefined) => Promise<SkillFilesResponse>,
): Promise<SkillFile[]> {
  const refused = (reason: string) => new CliError(EXIT.error, `the skill ${name} is refused: ${reason}`);
  const files: SkillFile[] = [];
  const paths = new Set<string>();
  const cursors = new Set<string>();
  let bytes = 0;
  let cursor: string | undefined;
  for (;;) {
    const response = await page(cursor);
    if (response.files.length === 0) {
      throw refused("a page holds no files");
    }
    for (const file of response.files) {
      if (paths.has(file.path)) {
        throw refused(`the path ${JSON.stringify(file.path)} comes twice`);
      }
      paths.add(file.path);
      bytes += file.size;
      if (paths.size > SKILL_FILES || bytes > SKILL_BYTES) {
        throw refused(`it has more than ${SKILL_FILES} files or ${SKILL_BYTES} bytes`);
      }
      const content = Buffer.from(file.content, "base64");
      if (content.byteLength !== file.size) {
        throw refused(`${JSON.stringify(file.path)} holds ${content.byteLength} bytes, not ${file.size}`);
      }
      if (blobSha(content) !== file.blob) {
        throw refused(`the bytes of ${JSON.stringify(file.path)} are not its blob ${file.blob}`);
      }
      files.push({ path: file.path, mode: file.mode, content });
    }
    if (response.nextCursor === null) {
      break;
    }
    if (cursors.has(response.nextCursor)) {
      throw refused("a page names a cursor already read");
    }
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  const issue = skillPathsIssue([...paths]);
  if (issue !== null) {
    throw refused(issue);
  }
  if (!paths.has("SKILL.md")) {
    throw refused("it has no SKILL.md at its root");
  }
  return files;
}

// Writes a skill's checked files under dir, a directory no one has written into yet. Each file is created exclusively
// (an existing entry, which the checks above leave no way to reach, fails the write), with mode 0755 for a git mode
// 100755, else 0644, whatever the umask, and synced, as prompt.md is.
export async function writeSkillFiles(dir: string, files: readonly SkillFile[]): Promise<void> {
  for (const file of files) {
    const path = join(dir, ...file.path.split("/"));
    const mode = file.mode === "100755" ? 0o755 : 0o644;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, "wx", mode);
    try {
      await handle.writeFile(file.content);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
