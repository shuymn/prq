import {
  Sha,
  SKILL_BYTES,
  SKILL_FILE_BYTES,
  SKILL_FILES,
  skillDirectoryIssue,
  skillManifestIssue,
  skillPathIssue,
  type SkillPreview,
  SkillRef,
  SkillSource,
} from "@prq/protocol";
import pLimit from "p-limit";
import * as v from "valibot";

import { GITHUB_API_VERSION, type GithubClient, githubExchange, githubRequest, githubStatus } from "../github.ts";
import { log } from "../log.ts";
import { WaitTimeout, withTimeout } from "../wait.ts";
import type { SkillLink } from "./link.ts";
import { readSkillMd, type SkillFrontmatter } from "./skill.ts";
import type { SkillFileContent, SkillVersion } from "./skills.ts";

// Reading a skill from GitHub (docs/design.md, Instructions and skills): the App's installation, the ref split and its
// commit, the skill's subtree at that commit with its caps, and its blobs byte for byte. A preview reads SKILL.md alone;
// a confirm reads every file by the previewed SHA, never a ref. Every GitHub call ends within GITHUB_CALL_MS, a preview
// within SKILL_PREVIEW_MS and a confirm within SKILL_FETCH_MS; their ending aborts every request still in flight.

export const SKILL_PREVIEW_MS = 30_000;
export const SKILL_FETCH_MS = 60_000;
// Blob reads at once: the Workers limit on a request's simultaneous outgoing connections.
const BLOB_READS = 6;

const API = "https://api.github.com";
const SKILL_MD = "SKILL.md";

// Why a skill could not be read, as the route answers it: the error code and the detail the settings show.
export class SkillFailure extends Error {
  override readonly name = "SkillFailure";
  readonly code: "not_found" | "invalid_skill" | "unavailable";
  readonly detail: string;

  constructor(code: SkillFailure["code"], detail: string) {
    super(detail);
    this.code = code;
    this.detail = detail;
  }
}

// A blob read's answer other than 200, as @octokit/request reports one: its status and headers.
class GithubAnswer extends Error {
  override readonly name = "GithubAnswer";
  readonly status: number;
  readonly response: { headers: Record<string, string> };

  constructor(status: number, headers: Record<string, string>) {
    super(`GitHub answered ${status}`);
    this.status = status;
    this.response = { headers };
  }
}

const AnswerHeaders = v.object({
  status: v.number(),
  response: v.object({ headers: v.record(v.string(), v.unknown()) }),
});

// When GitHub's rate limit lets the App call again (epoch ms), for a 403 or 429 that says the limit is reached.
function rateLimitReset(error: unknown): number | null {
  if (!(error instanceof Error) || !v.is(AnswerHeaders, error) || (error.status !== 403 && error.status !== 429)) {
    return null;
  }
  const { headers } = error.response;
  const reset = String(headers["x-ratelimit-reset"]);
  if (String(headers["x-ratelimit-remaining"]) === "0" && /^[0-9]+$/.test(reset)) {
    return Number(reset) * 1000;
  }
  const retryAfter = String(headers["retry-after"]);
  return /^[0-9]+$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : null;
}

// A call's failure as the route answers it: GitHub's rate limit with its reset time, or GitHub not answering.
function unavailable(error: unknown, what: string): SkillFailure {
  if (error instanceof SkillFailure) {
    return error;
  }
  const reset = rateLimitReset(error);
  if (reset !== null) {
    return new SkillFailure("unavailable", `GitHub's rate limit is reached until ${new Date(reset).toISOString()}`);
  }
  const status = githubStatus(error);
  return new SkillFailure("unavailable", `GitHub could not answer ${what} (${status ?? "no answer"}); try again`);
}

// A GitHub call: its answer, or the failure the route answers, with notFound for a 404 (or a 422, which GitHub gives a
// tree-ish naming no tree) when the caller names one.
async function call<T>(what: string, notFound: string | null, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const status = githubStatus(error);
    if (notFound !== null && (status === 404 || status === 422)) {
      throw new SkillFailure("not_found", notFound);
    }
    throw unavailable(error, what);
  }
}

function invalid(detail: string): SkillFailure {
  return new SkillFailure("invalid_skill", detail);
}

// A path's segments percent-encoded, joined by /.
function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// One unit of GitHub calls, bounded as a whole: its result, or a SkillFailure once ms has passed. Its ending, whatever
// it is, aborts its signal, which every request of the unit carries.
async function unit<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  try {
    // The bound is armed before the work starts, a microtask later.
    return await withTimeout(
      Promise.resolve().then(() => run(controller.signal)),
      ms,
      "a skill's reads from GitHub",
    );
  } catch (error) {
    if (error instanceof WaitTimeout) {
      throw new SkillFailure("unavailable", `GitHub did not answer within ${ms / 1000} s; try again`);
    }
    throw error;
  } finally {
    controller.abort();
  }
}

// --- The App's installation ---

const Installation = v.object({ id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)) });
const Installations = v.array(v.object({ id: Installation.entries.id, suspended_at: v.nullish(v.string()) }));

// The installation whose token reads the repository: the App's on the repository itself (private ones included), else
// the first active one on one page of the App's installations, whose token reads any public repository.
async function installationFor(client: GithubClient, owner: string, repo: string, signal: AbortSignal) {
  const jwt = await call("the App's JWT", null, () => client.appToken());
  const headers = { authorization: `bearer ${jwt}` };
  try {
    const answer = await githubRequest("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo,
      headers,
      request: { signal },
    });
    return v.parse(Installation, answer.data).id;
  } catch (error) {
    if (githubStatus(error) !== 404) {
      throw unavailable(error, "the App's installation on the repository");
    }
  }
  const installations = await call("the App's installations", null, async () => {
    const answer = await githubRequest("GET /app/installations", { per_page: 100, headers, request: { signal } });
    return v.parse(Installations, answer.data);
  });
  const active = installations.find((installation) => installation.suspended_at === null);
  if (active === undefined) {
    throw new SkillFailure("unavailable", "no active installation of the GitHub App");
  }
  return active.id;
}

// What reads one repository: its installation's token, and the unit's signal.
type Reader = { owner: string; repo: string; installationId: number; token: string; signal: AbortSignal };

// The unit's signal does not reach the token's minting: auth-app shares one mint of an installation's token among every
// concurrent caller in the isolate, so a unit that ends stops waiting for it and leaves it to its own bounds (the App's
// JWT signed within GITHUB_CALL_MS, the token request answered within GITHUB_CALL_MS).
async function readerFor(client: GithubClient, owner: string, repo: string, signal: AbortSignal): Promise<Reader> {
  const installationId = await installationFor(client, owner, repo, signal);
  const token = await call("the installation token", null, () => client.installationToken(installationId));
  return { owner, repo, installationId, token, signal };
}

// GitHub's message for an empty repository ("Git Repository is empty." from the Git database).
const EMPTY_REPOSITORY = /\brepository is empty\b/i;

const ErrorBody = v.object({ message: v.string() });

// The message of GitHub's error answer, or "" when its body is not GitHub's JSON error.
async function messageOf(response: Response): Promise<string> {
  try {
    const body: unknown = JSON.parse(await response.text());
    return v.is(ErrorBody, body) ? body.message : "";
  } catch {
    return "";
  }
}

// A GET of the repository's API path (written out, its segments percent-encoded: a tree-ish's `sha:path` would read as
// a template variable to @octokit/request) with the installation's token, its answer read by read.
function readRepository<T>(
  reader: Reader,
  path: string,
  accept: string,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const init = {
    headers: {
      accept,
      authorization: `token ${reader.token}`,
      "user-agent": "prq",
      "x-github-api-version": GITHUB_API_VERSION,
    },
    signal: reader.signal,
  };
  return githubExchange(`${API}/repos/${reader.owner}/${reader.repo}/${path}`, init, async (response) => {
    // GitHub answers 409 both for a repository without a commit and for one it cannot serve now: only the first, which
    // its message names, is nothing to retry.
    if (response.status === 409 && EMPTY_REPOSITORY.test(await messageOf(response))) {
      throw new SkillFailure("not_found", `${reader.owner}/${reader.repo} is empty: it has no commit`);
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      throw new GithubAnswer(response.status, Object.fromEntries(response.headers));
    }
    return read(response);
  });
}

const JSON_MEDIA = "application/vnd.github+json";

function noRepository(reader: Reader): string {
  return `no repository ${reader.owner}/${reader.repo} the GitHub App can read (a private one needs the App installed on it)`;
}

// --- Refs ---

const MatchingRefs = v.array(v.object({ ref: v.string() }));

// The branch or tag names starting with the prefix: GitHub matches at any character, so `feature` gives `feature`,
// `feature/x` and `featurex`.
async function refsStartingWith(reader: Reader, kind: "heads" | "tags", prefix: string): Promise<Set<string>> {
  const what = kind === "heads" ? "the branches" : "the tags";
  const refs = await call(what, noRepository(reader), async () => {
    const path = `git/matching-refs/${kind}/${encodeURIComponent(prefix)}`;
    return v.parse(MatchingRefs, await readRepository(reader, path, JSON_MEDIA, (response) => response.json()));
  });
  const leading = `refs/${kind}/`;
  return new Set(refs.flatMap(({ ref }) => (ref.startsWith(leading) ? [ref.slice(leading.length)] : [])));
}

// The commit a branch or tag names now, annotated tags peeled.
async function commitOf(reader: Reader, ref: SkillRef): Promise<string> {
  const kind = ref.kind === "branch" ? "heads" : "tags";
  const text = await call(`the commit of ${ref.kind} ${ref.name}`, `no ${ref.kind} ${ref.name}`, () =>
    readRepository(reader, `commits/refs/${kind}/${encodedPath(ref.name)}`, "application/vnd.github.sha", (response) =>
      response.text(),
    ),
  );
  const sha = text.trim();
  if (!v.is(Sha, sha)) {
    throw new SkillFailure("unavailable", `GitHub's answer for ${ref.kind} ${ref.name} is not a commit SHA; try again`);
  }
  return sha;
}

// The SHA, when it names a commit of the repository: read by the SHA itself (the Git database's commits, which take no
// ref), since the trees endpoint takes a tree's SHA as readily and would list that directory as a commit's root.
async function requireCommit(reader: Reader, sha: string): Promise<void> {
  const notACommit = `no commit ${sha} in ${reader.owner}/${reader.repo} (a tree's or a blob's SHA is not one)`;
  const commit = await call(`the commit ${sha}`, notACommit, () =>
    readRepository(reader, `git/commits/${sha}`, JSON_MEDIA, (response) => response.json()),
  );
  if (!v.is(v.object({ sha: v.literal(sha) }), commit)) {
    throw new SkillFailure("unavailable", `GitHub's answer for the commit ${sha} is not that commit; try again`);
  }
}

type Resolved = { ref: SkillRef; sha: string; path: string };

// The ref the segments start with and the directory the rest name: the longest run of whole segments that names a
// branch or tag (a branch before a tag of the same name), else the first segment when it is a commit's SHA, in either
// case (GitHub's links take both; prq keeps it in lowercase). With whole, the ref is all the segments.
async function resolveRef(reader: Reader, segments: readonly string[], whole: boolean): Promise<Resolved> {
  const [first = ""] = segments;
  const [branches, tags] = await Promise.all([
    refsStartingWith(reader, "heads", first),
    refsStartingWith(reader, "tags", first),
  ]);
  for (let count = segments.length; count >= (whole ? segments.length : 1); count -= 1) {
    const name = segments.slice(0, count).join("/");
    const kind = branches.has(name) ? "branch" : tags.has(name) ? "tag" : null;
    if (kind !== null) {
      const ref = { name, kind } as const;
      return { ref, sha: await commitOf(reader, ref), path: segments.slice(count).join("/") };
    }
  }
  const sha = first.toLowerCase();
  if (v.is(Sha, sha) && (!whole || segments.length === 1)) {
    await requireCommit(reader, sha);
    return { ref: { name: sha, kind: "commit" }, sha, path: segments.slice(1).join("/") };
  }
  const named = whole ? segments.join("/") : first;
  throw new SkillFailure("not_found", `no branch, tag or commit named ${named} in ${reader.owner}/${reader.repo}`);
}

// --- The tree and its blobs ---

// A regular file of the skill as its tree lists it.
type TreeFile = Omit<SkillFileContent, "content">;

const Tree = v.object({
  truncated: v.boolean(),
  tree: v.array(
    v.object({ path: v.string(), mode: v.string(), type: v.string(), sha: v.string(), size: v.optional(v.number()) }),
  ),
});

function where(reader: Reader, path: string, sha: string): string {
  return `${reader.owner}/${reader.repo}${path === "" ? "" : ` ${path}`} at ${sha.slice(0, 7)}`;
}

// The skill's regular files at the commit, sorted by path, its SKILL.md among them, and their bytes in all, checked
// against every cap before any blob is read: no symlink or submodule, a complete tree, each path through the shared
// validator, no paths differing only in case, at most SKILL_FILES files, SKILL_FILE_BYTES each and SKILL_BYTES in all,
// and a SKILL.md at its root.
async function readTree(
  reader: Reader,
  sha: string,
  path: string,
): Promise<{ files: TreeFile[]; skillMd: TreeFile; total: number }> {
  const at = where(reader, path, sha);
  const tree = await call(`the tree of ${at}`, `no directory ${path === "" ? "/" : path} at ${sha}`, async () => {
    const treeish = path === "" ? sha : `${sha}:${encodedPath(path)}`;
    const answer = await readRepository(reader, `git/trees/${treeish}?recursive=1`, JSON_MEDIA, (response) =>
      response.json(),
    );
    return v.parse(Tree, answer);
  });
  if (tree.truncated) {
    throw invalid(`GitHub cut the tree of ${at} short: it has too many entries`);
  }
  const files: TreeFile[] = [];
  for (const entry of tree.tree) {
    if (entry.mode === "120000" || entry.mode === "160000") {
      throw invalid(`${at} holds a ${entry.mode === "120000" ? "symlink" : "submodule"} at ${entry.path}`);
    }
    if (entry.type === "tree") {
      continue;
    }
    if (
      entry.type !== "blob" ||
      (entry.mode !== "100644" && entry.mode !== "100755") ||
      entry.size === undefined ||
      !v.is(Sha, entry.sha)
    ) {
      throw invalid(`${at} holds ${entry.path} of a kind prq does not store (mode ${entry.mode})`);
    }
    files.push({ path: entry.path, mode: entry.mode, size: entry.size, blob: entry.sha });
  }
  for (const file of files) {
    const issue = skillPathIssue(file.path);
    if (issue !== null) {
      throw invalid(issue);
    }
  }
  const collision = skillManifestIssue(files.map((file) => file.path));
  if (collision !== null) {
    throw invalid(collision);
  }
  if (files.length > SKILL_FILES) {
    throw invalid(`${at} has ${files.length} files, more than ${SKILL_FILES}`);
  }
  const large = files.find((file) => file.size > SKILL_FILE_BYTES);
  if (large !== undefined) {
    throw invalid(`${large.path} is ${large.size} bytes, more than ${SKILL_FILE_BYTES}`);
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > SKILL_BYTES) {
    throw invalid(`${at} is ${total} bytes, more than ${SKILL_BYTES}`);
  }
  const skillMd = files.find((file) => file.path === SKILL_MD);
  if (skillMd === undefined) {
    throw new SkillFailure("not_found", `no ${SKILL_MD} in ${at}`);
  }
  return { files: files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), skillMd, total };
}

const utf8 = new TextEncoder();

// A blob's git ID: SHA-1 of "blob <size>\0" and its bytes.
async function blobId(bytes: Uint8Array): Promise<string> {
  const header = utf8.encode(`blob ${bytes.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + bytes.byteLength);
  object.set(header);
  object.set(bytes, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", object));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The response's body as bytes, counted while it streams: the read stops, and the exchange is aborted, as soon as the
// count passes the tree's size.
async function bodyBytes(response: Response, file: TreeFile): Promise<Uint8Array> {
  const bytes = new Uint8Array(file.size);
  let length = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      if (length + chunk.value.byteLength > file.size) {
        void reader.cancel().catch(() => undefined);
        throw invalid(`the blob of ${file.path} is longer than its tree says (${file.size} bytes)`);
      }
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
  }
  return bytes.subarray(0, length);
}

// A blob's bytes as GitHub stores them (the raw media type, read as bytes: no text decoding, so a BOM or a byte that
// is not UTF-8 stays), checked for the tree's size and blob SHA-1.
async function readBlob(reader: Reader, file: TreeFile): Promise<Uint8Array> {
  const bytes = await call(`the blob of ${file.path}`, null, () =>
    readRepository(reader, `git/blobs/${file.blob}`, "application/vnd.github.raw", (response) =>
      bodyBytes(response, file),
    ),
  );
  if (bytes.byteLength !== file.size || (await blobId(bytes)) !== file.blob) {
    throw invalid(`the blob of ${file.path} does not match its tree (size or SHA-1)`);
  }
  return bytes;
}

// SKILL.md's frontmatter, or the refusal of it.
function frontmatterOf(bytes: Uint8Array): SkillFrontmatter {
  const frontmatter = readSkillMd(bytes);
  if ("issue" in frontmatter) {
    throw invalid(frontmatter.issue);
  }
  return frontmatter;
}

// --- Preview and confirm ---

// What a preview reads: a link (its segments split into a ref and a path), or a ref named whole, against the
// registered repository and path.
type PreviewTarget = { link: SkillLink } | { source: SkillSource; ref: string };

// A preview: the ref resolved to its commit, the tree read by that SHA, and SKILL.md's frontmatter. Nothing is stored.
export function previewSkill(client: GithubClient, target: PreviewTarget): Promise<SkillPreview> {
  const { owner, repo } = "link" in target ? target.link : target.source;
  return unit(SKILL_PREVIEW_MS, async (signal) => {
    const reader = await readerFor(client, owner, repo, signal);
    const { ref, sha, path } =
      "link" in target
        ? await resolveRef(reader, target.link.segments, false)
        : { ...(await resolveRef(reader, target.ref.split("/"), true)), path: target.source.path };
    // The pin as the confirm checks it, before any tree is read: a preview never shows one the confirm refuses.
    const source = { owner, repo, path };
    if (!v.is(SkillSource, source) || !v.is(SkillRef, ref)) {
      throw invalid(skillDirectoryIssue(path) ?? `the ref ${ref.name} is too long to pin`);
    }
    const { files, skillMd } = await readTree(reader, sha, path);
    const frontmatter = frontmatterOf(await readBlob(reader, skillMd));
    log("prq.skill.fetched", {
      phase: "preview",
      installationId: reader.installationId,
      repo: `${owner}/${repo}`,
      sha,
      files: files.length,
      bytes: skillMd.size,
    });
    return {
      ...frontmatter,
      allowedTools: frontmatter.allowedTools?.map((entry) => ({ entry })) ?? null,
      source,
      ref,
      sha,
      files: files.map(({ path: file, size, mode }) => ({
        path: file,
        size,
        mode,
        script: file.startsWith("scripts/") || mode === "100755",
      })),
    };
  });
}

// A confirm: the previewed SHA checked to be a commit's, its tree read by it (no ref request), SKILL.md read first and
// its name checked, then every other blob, at most BLOB_READS at a time; the first failure aborts the reads in flight,
// and a queued one never starts.
export function fetchSkill(
  client: GithubClient,
  request: { name: string; source: SkillSource; ref: SkillRef; sha: string },
): Promise<SkillVersion> {
  const { owner, repo, path } = request.source;
  return unit(SKILL_FETCH_MS, async (signal) => {
    const reader = await readerFor(client, owner, repo, signal);
    await requireCommit(reader, request.sha);
    const { files, skillMd, total } = await readTree(reader, request.sha, path);
    const skillMdBytes = await readBlob(reader, skillMd);
    const frontmatter = frontmatterOf(skillMdBytes);
    if (frontmatter.name !== request.name) {
      throw invalid(
        `the ${SKILL_MD} of ${where(reader, path, request.sha)} is named ${frontmatter.name}, not ${request.name}`,
      );
    }
    // One controller for the reads: the first failure aborts the ones in flight and drops the queued ones, in the
    // failing read's own handler, before the limit could start the next one. A dropped read's promise never settles,
    // so the failure is what the reads reject with.
    const reads = new AbortController();
    const blobs = { ...reader, signal: AbortSignal.any([signal, reads.signal]) };
    const limit = pLimit(BLOB_READS);
    const others = await Promise.all(
      files
        .filter((file) => file !== skillMd)
        .map(async (file) => ({
          ...file,
          content: await limit(async () => {
            blobs.signal.throwIfAborted();
            try {
              return await readBlob(blobs, file);
            } catch (error) {
              reads.abort();
              limit.clearQueue();
              throw error;
            }
          }),
        })),
    );
    log("prq.skill.fetched", {
      phase: "confirm",
      installationId: reader.installationId,
      repo: `${owner}/${repo}`,
      sha: request.sha,
      files: files.length,
      bytes: total,
    });
    return {
      ...frontmatter,
      source: request.source,
      ref: request.ref,
      sha: request.sha,
      files: [{ ...skillMd, content: skillMdBytes }, ...others],
    };
  });
}
