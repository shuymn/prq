import * as v from "valibot";

import { MAX_URL_CHARS, PrRef, Sha } from "./pr.ts";

// The host's instructions (docs/design.md, Instructions and skills): a free-form prompt for the summaries and one for
// the answers, read by every cloud turn of that kind and carried to local agents by /cli/context; and the skills the
// host registered, each pinned to a commit and stored by the Hub.

// The longest prompt, in UTF-16 code units. A style prompt is a few lines; the cap bounds the system prompt, the first
// context page and the Hub's row.
export const PROMPT_CHARS = 8000;

// Which prompt: the one an analysis reads, or the one an answer reads.
export const PromptKind = v.picklist(["analysis", "answer"]);
export type PromptKind = v.InferOutput<typeof PromptKind>;

const PromptText = v.pipe(v.string(), v.maxLength(PROMPT_CHARS));

// A prompt as stored: its text (empty when never saved) and when it was saved (epoch ms; null when never saved).
export const Prompt = v.object({ text: PromptText, savedAt: v.nullable(v.number()) });
export type Prompt = v.InferOutput<typeof Prompt>;

export const Prompts = v.object({ analysis: Prompt, answer: Prompt });
export type Prompts = v.InferOutput<typeof Prompts>;

// PUT /api/prompts/:kind: the prompt's new text, which replaces the stored one. The answer is the stored Prompt.
export const SavePromptRequest = v.object({ text: PromptText });
export type SavePromptRequest = v.InferOutput<typeof SavePromptRequest>;

// What the first /cli/context page carries for a local agent: both prompts, as the settings hold them.
export const ContextInstructions = v.object({ prompts: Prompts });
export type ContextInstructions = v.InferOutput<typeof ContextInstructions>;

// --- Skills ---

// The caps on a registered skill. Each bounds what the Hub stores and every read of it carries: the list in the
// settings and the system prompt, a confirm's blob requests, and the RPC payloads (32 MiB at most), all far under the
// Durable Object SQLite value limit (8 MB) and its 10 GB per object.
// Skills registered at once.
export const SKILL_COUNT = 32;
// Regular files in one skill.
export const SKILL_FILES = 200;
// One file's size, in bytes.
export const SKILL_FILE_BYTES = 1024 * 1024;
// One skill's files together, in bytes.
export const SKILL_BYTES = 8 * 1024 * 1024;
// A path inside the skill, in UTF-8 bytes: what the 100-byte name field of a ustar archive holds exactly.
export const SKILL_PATH_BYTES = 100;
// The frontmatter's `license` and `allowed-tools` (the whole field), in UTF-16 code units.
export const SKILL_LICENSE_CHARS = 200;
export const SKILL_ALLOWED_TOOLS_CHARS = 2000;
// The Agent Skills specification's bounds on `name` and `description`.
export const SKILL_NAME_CHARS = 64;
export const SKILL_DESCRIPTION_CHARS = 1024;

// The longest path to a skill's directory in its repository, in UTF-8 bytes: a display field, bounded like a URL.
const SOURCE_PATH_BYTES = 1024;
// git's ref names on GitHub are at most 255 bytes.
const REF_NAME_CHARS = 255;

// A string's length in UTF-8 bytes (a lone surrogate counts as U+FFFD, as TextEncoder writes it), without the DOM's
// TextEncoder, which this package's types leave out.
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// Why a /-separated relative path is refused, or null: an empty, `.` or `..` segment (a leading or trailing / makes an
// empty one), a NUL or a backslash anywhere, or more than maxBytes UTF-8 bytes.
function relativePathIssue(path: string, maxBytes: number): string | null {
  if (path.includes("\0") || path.includes("\\")) {
    return "holds a NUL or a backslash";
  }
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "has an empty, . or .. segment";
  }
  if (utf8Bytes(path) > maxBytes) {
    return `is longer than ${maxBytes} bytes`;
  }
  return null;
}

// Why a path inside a skill is refused, or null. The one check every path of a skill passes, wherever it is stored or
// written: relative, /-separated, at most SKILL_PATH_BYTES.
export function skillPathIssue(path: string): string | null {
  const issue = relativePathIssue(path, SKILL_PATH_BYTES);
  return issue === null ? null : `the path ${JSON.stringify(path)} ${issue}`;
}

// A path component as a case-insensitive file system compares it: case folded, Unicode normalized.
function folded(component: string): string {
  return component.normalize("NFC").toUpperCase().toLowerCase();
}

// Why a skill's set of paths is refused, or null: two paths that, where they first differ, have components equal but
// for case (`Docs/a.md` beside `docs/b.md`, or `Readme.md` beside `README.md`). A case-insensitive disk would merge them
// in a local copy. Paths that differ first in components unequal however compared (`a/Docs/x.md` beside `b/docs/y.md`)
// pass.
export function skillManifestIssue(paths: readonly string[]): string | null {
  // Under each directory (by its exact path), the folded name of each component seen there, with a path holding it.
  const seen = new Map<string, Map<string, { component: string; path: string }>>();
  for (const path of paths) {
    const components = path.split("/");
    for (const [depth, component] of components.entries()) {
      const parent = components.slice(0, depth).join("/");
      let children = seen.get(parent);
      if (children === undefined) {
        children = new Map();
        seen.set(parent, children);
      }
      const key = folded(component);
      const other = children.get(key);
      if (other === undefined) {
        children.set(key, { component, path });
      } else if (other.component !== component) {
        return `the paths ${JSON.stringify(other.path)} and ${JSON.stringify(path)} differ only in the case of ${JSON.stringify(component)}`;
      }
    }
  }
  return null;
}

// A skill's name, as the Agent Skills specification writes it: lowercase letters, digits and single hyphens between
// them, at most SKILL_NAME_CHARS.
export const SkillName = v.pipe(
  v.string(),
  v.maxLength(SKILL_NAME_CHARS),
  v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "is not a skill name (lowercase letters, digits and single hyphens)"),
);

// Why the path of a skill's directory in its repository is refused, or null ("" is the root): relative, without a NUL
// or a backslash, at most SOURCE_PATH_BYTES. A preview refuses such a directory before a confirm could.
export function skillDirectoryIssue(path: string): string | null {
  const issue = path === "" ? null : relativePathIssue(path, SOURCE_PATH_BYTES);
  return issue === null ? null : `the skill's directory ${JSON.stringify(path)} ${issue}`;
}

// Where a skill was registered from: the repository and the path of its directory there ("" for the root).
export const SkillSource = v.object({
  owner: PrRef.entries.owner,
  repo: PrRef.entries.repo,
  path: v.pipe(
    v.string(),
    v.check((path) => skillDirectoryIssue(path) === null, "is not a directory path"),
  ),
});
export type SkillSource = v.InferOutput<typeof SkillSource>;

// The ref a skill was pinned from, as the link or the update named it: a branch, a tag, or a commit (a permalink,
// whose name is the SHA itself).
export const SkillRef = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(REF_NAME_CHARS)),
  kind: v.picklist(["branch", "tag", "commit"]),
});
export type SkillRef = v.InferOutput<typeof SkillRef>;

// One entry of a skill's `allowed-tools`, as the frontmatter wrote it.
export const AllowedTool = v.object({ entry: v.string() });
export type AllowedTool = v.InferOutput<typeof AllowedTool>;

// The frontmatter fields the settings show: name, description, license (null when absent) and allowed-tools (null when
// absent).
const SkillFields = {
  name: SkillName,
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(SKILL_DESCRIPTION_CHARS)),
  license: v.nullable(v.pipe(v.string(), v.maxLength(SKILL_LICENSE_CHARS))),
  allowedTools: v.nullable(v.array(AllowedTool)),
};

// A registered skill, pinned to sha. rev is its registration's revision: every register and update takes a new one, so
// a remove and a register of the same name, even at the same SHA, is another revision.
export const Skill = v.object({
  ...SkillFields,
  rev: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  source: SkillSource,
  ref: SkillRef,
  sha: Sha,
  registeredAt: v.number(),
  updatedAt: v.number(),
});
export type Skill = v.InferOutput<typeof Skill>;

// A file of a previewed skill: its path in the skill, size, git mode, and whether it looks like a script (under
// scripts/, or executable).
export const SkillFile = v.object({
  path: v.string(),
  size: v.number(),
  mode: v.picklist(["100644", "100755"]),
  script: v.boolean(),
});
export type SkillFile = v.InferOutput<typeof SkillFile>;

// POST /api/skills/preview: what a confirm would pin, read from GitHub and stored nowhere.
export const SkillPreview = v.object({
  ...SkillFields,
  source: SkillSource,
  ref: SkillRef,
  sha: Sha,
  files: v.array(SkillFile),
});
export type SkillPreview = v.InferOutput<typeof SkillPreview>;

// POST /api/skills/:name/preview: the new version beside the registered one.
export const SkillUpdatePreview = v.object({
  ...SkillPreview.entries,
  current: v.object({
    source: SkillSource,
    ref: SkillRef,
    sha: Sha,
    rev: Skill.entries.rev,
    allowedTools: SkillFields.allowedTools,
  }),
});
export type SkillUpdatePreview = v.InferOutput<typeof SkillUpdatePreview>;

const SkillLink = v.pipe(v.string(), v.maxLength(MAX_URL_CHARS));

export const PreviewSkillRequest = v.object({ url: SkillLink });
export type PreviewSkillRequest = v.InferOutput<typeof PreviewSkillRequest>;

const SkillPin = { name: SkillName, source: SkillSource, ref: SkillRef, sha: Sha };

// A commit's ref is its SHA.
function pinnedAtItsSha<T extends { ref: SkillRef; sha: string }>() {
  return v.check<T, string>(
    ({ ref, sha }) => ref.kind !== "commit" || ref.name === sha,
    "names a commit other than its SHA",
  );
}

// POST /api/skills: the preview's name, source, ref and SHA. The confirm fetches by the SHA only; the ref is what the
// settings show.
export const RegisterSkillRequest = v.pipe(v.object(SkillPin), pinnedAtItsSha());
export type RegisterSkillRequest = v.InferOutput<typeof RegisterSkillRequest>;

// POST /api/skills/:name/preview: a ref of the registered repository and path (a branch, a tag or a full SHA), or a new
// link.
export const PreviewUpdateRequest = v.union([
  v.strictObject({ ref: SkillRef.entries.name }),
  v.strictObject({ url: SkillLink }),
]);
export type PreviewUpdateRequest = v.InferOutput<typeof PreviewUpdateRequest>;

// PUT /api/skills/:name: the update preview's name, source, ref and SHA, and the revision it was previewed against.
export const UpdateSkillRequest = v.pipe(v.object({ ...SkillPin, expectedRev: Skill.entries.rev }), pinnedAtItsSha());
export type UpdateSkillRequest = v.InferOutput<typeof UpdateSkillRequest>;

// GET /api/instructions: both prompts, and the registered skills sorted by name.
export const Instructions = v.object({ prompts: Prompts, skills: v.array(Skill) });
export type Instructions = v.InferOutput<typeof Instructions>;
