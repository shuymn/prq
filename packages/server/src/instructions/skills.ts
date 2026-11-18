import { type AllowedTool, type Skill, SKILL_FILES, SkillName, SkillRef, SkillSource } from "@prq/protocol";
import * as v from "valibot";

import { runnableEntry } from "./command.ts";
import type { SkillFrontmatter } from "./skill.ts";

// The host's skills as the Hub stores them: one prq_skills row per registered name, pinned to a commit, and its regular
// files at that commit in prq_skill_files, each whole in one BLOB.

// A file of a skill: its path in the skill, git mode, size, git blob SHA-1, and bytes.
export type SkillFileContent = {
  path: string;
  mode: "100644" | "100755";
  size: number;
  blob: string;
  content: Uint8Array;
};

// A skill read from GitHub at one commit and checked: its frontmatter, where it came from, and every file. What a
// register or an update stores.
export type SkillVersion = SkillFrontmatter & {
  source: SkillSource;
  ref: SkillRef;
  sha: string;
  files: SkillFileContent[];
};

// A registered skill with its files, as a reader of the stored copy gets it.
export type SkillBundle = { skill: Skill; files: SkillFileContent[] };

// What the Hub takes over RPC as a version, checked before any write: the stored columns' rules.
const Version = v.object({
  name: SkillName,
  description: v.string(),
  license: v.nullable(v.string()),
  allowedTools: v.nullable(v.array(v.string())),
  source: SkillSource,
  ref: SkillRef,
  sha: v.string(),
  files: v.pipe(
    v.array(
      v.object({
        path: v.string(),
        mode: v.picklist(["100644", "100755"]),
        size: v.number(),
        blob: v.string(),
        content: v.instance(Uint8Array),
      }),
    ),
    v.maxLength(SKILL_FILES),
  ),
});

// Why an update is refused when the registration is no longer at the revision it was previewed against: updated, or
// removed (and maybe registered again) since.
export function skillChanged(name: string): string {
  return `the skill ${name} was updated or removed since the preview; preview it again`;
}

export function isSkillVersion(value: unknown): value is SkillVersion {
  return v.is(Version, value);
}

type SkillRow = {
  name: string;
  rev: number;
  owner: string;
  repo: string;
  path: string;
  ref: string;
  ref_kind: SkillRef["kind"];
  sha: string;
  description: string;
  allowed_tools: string | null;
  license: string | null;
  registered_at: number;
  updated_at: number;
};

type FileRow = { path: string; mode: "100644" | "100755"; size: number; blob: string; content: ArrayBuffer };

const ALLOWED_TOOLS = v.array(v.string());

// allowed-tools' entries as written, each with whether a cloud turn runs it against the skill's stored files.
export function allowedToolsOf(entries: readonly string[] | null, files: readonly string[]): AllowedTool[] | null {
  const stored = new Set(files);
  return entries?.map((entry) => ({ entry, runs: runnableEntry(entry, stored) !== null })) ?? null;
}

function skillOf(row: SkillRow, files: readonly string[]): Skill {
  const entries = row.allowed_tools === null ? null : v.parse(ALLOWED_TOOLS, JSON.parse(row.allowed_tools));
  return {
    name: row.name,
    rev: row.rev,
    description: row.description,
    license: row.license,
    source: { owner: row.owner, repo: row.repo, path: row.path },
    ref: { name: row.ref, kind: row.ref_kind },
    sha: row.sha,
    allowedTools: allowedToolsOf(entries, files),
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}

// The stored paths of a skill, or of every skill by name.
function storedPaths(sql: SqlStorage, name?: string): Map<string, string[]> {
  const rows =
    name === undefined
      ? sql.exec<{ name: string; path: string }>("SELECT name, path FROM prq_skill_files ORDER BY name, path")
      : sql.exec<{ name: string; path: string }>(
          "SELECT name, path FROM prq_skill_files WHERE name = ? ORDER BY path",
          name,
        );
  const paths = new Map<string, string[]>();
  for (const row of rows) {
    const list = paths.get(row.name);
    if (list === undefined) {
      paths.set(row.name, [row.path]);
    } else {
      list.push(row.path);
    }
  }
  return paths;
}

// Every registered skill, sorted by name.
export function readSkills(sql: SqlStorage): Skill[] {
  const paths = storedPaths(sql);
  return sql
    .exec<SkillRow>("SELECT * FROM prq_skills ORDER BY name")
    .toArray()
    .map((row) => skillOf(row, paths.get(row.name) ?? []));
}

export function readSkill(sql: SqlStorage, name: string): Skill | null {
  const [row] = sql.exec<SkillRow>("SELECT * FROM prq_skills WHERE name = ?", name).toArray();
  return row === undefined ? null : skillOf(row, storedPaths(sql, name).get(name) ?? []);
}

export function countSkills(sql: SqlStorage): number {
  return sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM prq_skills").one().count;
}

// A registered skill's files, sorted by path.
export function readSkillFiles(sql: SqlStorage, name: string): SkillFileContent[] {
  return sql
    .exec<FileRow>("SELECT path, mode, size, blob, content FROM prq_skill_files WHERE name = ? ORDER BY path", name)
    .toArray()
    .map((row) => ({
      path: row.path,
      mode: row.mode,
      size: row.size,
      blob: row.blob,
      content: new Uint8Array(row.content),
    }));
}

// What a cloud turn's skill tool reads of a registered skill at the revision its turn listed: a stored file's bytes;
// for a path that names no stored file, every path the skill stores (sorted), from which the tool lists a directory or
// says that nothing is there; or that the registration is no longer at that revision (updated, or removed).
export type SkillRead =
  | { kind: "file"; content: Uint8Array }
  | { kind: "paths"; paths: string[] }
  | { kind: "changed" };

// Whether the skill is still registered at the revision a turn listed.
function atRev(sql: SqlStorage, name: string, rev: number): boolean {
  const [row] = sql.exec<{ rev: number }>("SELECT rev FROM prq_skills WHERE name = ?", name).toArray();
  return row?.rev === rev;
}

export function readSkillPath(sql: SqlStorage, name: string, rev: number, path: string): SkillRead {
  if (!atRev(sql, name, rev)) {
    return { kind: "changed" };
  }
  const [file] = sql
    .exec<{ content: ArrayBuffer }>("SELECT content FROM prq_skill_files WHERE name = ? AND path = ?", name, path)
    .toArray();
  if (file !== undefined) {
    return { kind: "file", content: new Uint8Array(file.content) };
  }
  const paths = sql
    .exec<{ path: string }>("SELECT path FROM prq_skill_files WHERE name = ? ORDER BY path", name)
    .toArray()
    .map((entry) => entry.path);
  return { kind: "paths", paths };
}

// What a cloud turn's script run reads of a registered skill at the revision its turn listed: every stored file (path,
// mode and bytes), or that the registration is no longer at that revision.
export type SkillFilesRead =
  | { kind: "files"; files: Pick<SkillFileContent, "path" | "mode" | "content">[] }
  | { kind: "changed" };

export function readSkillFilesAt(sql: SqlStorage, name: string, rev: number): SkillFilesRead {
  if (!atRev(sql, name, rev)) {
    return { kind: "changed" };
  }
  const files = readSkillFiles(sql, name).map(({ path, mode, content }) => ({ path, mode, content }));
  return { kind: "files", files };
}

// Writes the version under its name at rev: the row (registered_at kept when the name is registered), and exactly its
// files, those of the version before removed; the stored skill. The caller runs it inside a transaction with its own
// checks.
export function writeSkill(sql: SqlStorage, version: SkillVersion, rev: number, now: number): Skill {
  const row = sql
    .exec<SkillRow>(
      `INSERT INTO prq_skills (name, rev, owner, repo, path, ref, ref_kind, sha, description, allowed_tools, license,
       registered_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET rev = excluded.rev, owner = excluded.owner, repo = excluded.repo,
       path = excluded.path, ref = excluded.ref, ref_kind = excluded.ref_kind, sha = excluded.sha,
       description = excluded.description, allowed_tools = excluded.allowed_tools, license = excluded.license,
       updated_at = excluded.updated_at
     RETURNING *`,
      version.name,
      rev,
      version.source.owner,
      version.source.repo,
      version.source.path,
      version.ref.name,
      version.ref.kind,
      version.sha,
      version.description,
      version.allowedTools === null ? null : JSON.stringify(version.allowedTools),
      version.license,
      now,
      now,
    )
    .one();
  sql.exec("DELETE FROM prq_skill_files WHERE name = ?", version.name);
  for (const file of version.files) {
    const { buffer, byteOffset, byteLength } = file.content;
    sql.exec(
      "INSERT INTO prq_skill_files (name, path, mode, size, blob, content) VALUES (?, ?, ?, ?, ?, ?)",
      version.name,
      file.path,
      file.mode,
      file.size,
      file.blob,
      buffer.slice(byteOffset, byteOffset + byteLength),
    );
  }
  return skillOf(
    row,
    version.files.map((file) => file.path),
  );
}

// Removes a skill's row and files; whether it was registered.
export function deleteSkill(sql: SqlStorage, name: string): boolean {
  sql.exec("DELETE FROM prq_skill_files WHERE name = ?", name);
  return sql.exec("DELETE FROM prq_skills WHERE name = ?", name).rowsWritten > 0;
}
