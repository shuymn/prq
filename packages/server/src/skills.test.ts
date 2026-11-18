import {
  Instructions,
  Skill,
  SKILL_BYTES,
  SKILL_COUNT,
  SKILL_FILE_BYTES,
  SKILL_FILES,
  SKILL_PATH_BYTES,
  SkillPreview,
  SkillUpdatePreview,
} from "@prq/protocol";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureLogs, events, type LogEntry } from "./test/access.ts";
import { hostToken } from "./test/chat.ts";
import { type FakeFile, type FakeRepository, type GithubApi, gitBlobSha, serveGithub } from "./test/github.ts";
import { clearSkills, hub } from "./test/session.ts";
import {
  blobReads,
  confirmation,
  errorOf,
  link,
  OWNER,
  POLISH_MD,
  polishFiles,
  REPO,
  refReads,
  seedVersion,
  send,
  storedFiles,
  storedRows,
} from "./test/skills.ts";

// Registering, updating and removing skills through /api/skills (docs/design.md, Instructions and skills), against an
// in-memory GitHub: the preview resolves the ref and reads SKILL.md by its SHA, the confirm stores exactly the files at
// the previewed SHA, and the Hub's transaction guards the name and the revision.

const POLISH_B = POLISH_MD.replace("Polishes text.", "Polishes text, version B.");
const POLISH_MD_BYTES = new TextEncoder().encode(POLISH_MD).byteLength;

let api: GithubApi;
let repo: FakeRepository;
let token: string;
let logs: LogEntry[];

beforeEach(async () => {
  logs = captureLogs();
  token = await hostToken();
  api = serveGithub();
  api.installations([{ id: 9 }]);
  api.install(OWNER, REPO, 5);
  repo = api.repository(OWNER, REPO);
  await clearSkills();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// A route's answer of the expected status, read by the schema; another status fails with the body it carries.
async function answered<T>(res: Response, status: number, schema: v.GenericSchema<unknown, T>): Promise<T> {
  const body: unknown = await res.json();
  expect({ status: res.status, body }).toMatchObject({ status });
  return v.parse(schema, body);
}

async function preview(url: string): Promise<SkillPreview> {
  return answered(await send(token, "POST", "/api/skills/preview", { url }), 200, SkillPreview);
}

async function register(sha: string, options: Parameters<typeof confirmation>[1] = {}): Promise<Skill> {
  return answered(await send(token, "POST", "/api/skills", confirmation(sha, options)), 201, Skill);
}

async function refusedPreview(url: string) {
  return errorOf(await send(token, "POST", "/api/skills/preview", { url }));
}

async function previewed(url: string) {
  const { ref, sha, source } = await preview(url);
  return { ref, sha, path: source.path };
}

// A confirm of the polish skill with the given files added under its directory (and SKILL.md replaced when given): its
// status and detail, and how many blobs it read.
async function confirmWith(files: Record<string, FakeFile>, skillMd?: string) {
  await clearSkills();
  const sha = await repo.commit(
    polishFiles("skills/polish", skillMd === undefined ? files : { ...files, "SKILL.md": skillMd }),
  );
  const before = blobReads(api).length;
  const res = await send(token, "POST", "/api/skills", confirmation(sha));
  const body = res.status === 201 ? null : (await errorOf(res)).body;
  return { status: res.status, detail: body?.detail ?? null, blobs: blobReads(api).length - before };
}

// count small files under references/.
function manyFiles(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`references/${index}.md`, `${index}\n`]));
}

function withField(field: string): string {
  return POLISH_MD.replace("license: MIT", field);
}

async function instructions(): Promise<Instructions> {
  const res = await send(token, "GET", "/api/instructions");
  expect(res.status).toBe(200);
  return v.parse(Instructions, await res.json());
}

// The files a commit holds under dir, as the stored copy should hold them: path, mode, size, blob SHA.
function treeUnder(files: Record<string, FakeFile>, commit: string, dir: string) {
  const prefix = dir === "" ? "" : `${dir}/`;
  return Object.entries(files)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, file]) => ({
      path: path.slice(prefix.length),
      mode: typeof file === "object" && "mode" in file ? file.mode : "100644",
      blob: repo.blobOf(commit, path),
    }))
    .toSorted((a, b) => (a.path < b.path ? -1 : 1));
}

describe("a preview", () => {
  it("resolves the link's ref to its commit and reads the tree and SKILL.md by that SHA, storing nothing", async () => {
    const files = polishFiles();
    const sha = await repo.commit(files);
    repo.heads.set("main", sha);

    expect(await preview(link("main", "skills/polish"))).toEqual({
      name: "polish",
      description: "Polishes text.",
      license: "MIT",
      allowedTools: [{ entry: "Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/check.py *)" }, { entry: "Read" }],
      source: { owner: OWNER, repo: REPO, path: "skills/polish" },
      ref: { name: "main", kind: "branch" },
      sha,
      files: [
        { path: "SKILL.md", size: POLISH_MD_BYTES, mode: "100644", script: false },
        { path: "references/style.md", size: 8, mode: "100644", script: false },
        { path: "scripts/check.py", size: 12, mode: "100755", script: true },
      ],
    });
    // One blob read, SKILL.md's; the tree read by the SHA; nothing stored.
    expect(blobReads(api).map((request) => request.path)).toEqual([
      `/repos/${OWNER}/${REPO}/git/blobs/${repo.blobOf(sha, "skills/polish/SKILL.md")}`,
    ]);
    expect(
      api.requests.some((request) => request.path === `/repos/${OWNER}/${REPO}/git/trees/${sha}:skills/polish`),
    ).toBe(true);
    expect((await instructions()).skills).toEqual([]);
    expect(events(logs, "prq.skill.fetched")).toEqual([
      {
        event: "prq.skill.fetched",
        phase: "preview",
        installationId: 5,
        repo: `${OWNER}/${REPO}`,
        sha,
        files: 3,
        bytes: POLISH_MD_BYTES,
      },
    ]);
  });

  it("splits the segments at the longest branch or tag, a branch before a tag, else at a commit SHA", async () => {
    // Refs that can live together in Git: a branch `feature` beside a tag `feature/x` (another namespace), and a
    // branch and a tag both named `release`. Each commit holds the skill where the other split would look too.
    const a = await repo.commit({ ...polishFiles(), ...polishFiles("x/skills/polish") });
    const b = await repo.commit({
      ...polishFiles("skills/polish", { "SKILL.md": POLISH_B }),
      ...polishFiles("x/skills/polish"),
    });
    const root = await repo.commit(polishFiles(""));
    const hexBranch = "f".repeat(40);
    repo.heads.set("feature", a);
    repo.tags.set("feature/x", b);
    repo.heads.set("release", a);
    repo.tags.set("release", b);
    repo.tags.set("v1", b);
    repo.annotated.add("v1");
    repo.heads.set(hexBranch, a);
    repo.heads.set("a/b", root);
    repo.heads.set("main", root);

    // The longest: the tag feature/x over the branch feature; the branch over the tag of the same name.
    expect(await previewed(link("feature/x", "skills/polish"))).toEqual({
      ref: { name: "feature/x", kind: "tag" },
      sha: b,
      path: "skills/polish",
    });
    expect(await previewed(link("feature", "skills/polish"))).toEqual({
      ref: { name: "feature", kind: "branch" },
      sha: a,
      path: "skills/polish",
    });
    expect(await previewed(link("release", "skills/polish"))).toEqual({
      ref: { name: "release", kind: "branch" },
      sha: a,
      path: "skills/polish",
    });
    // An annotated tag, peeled to its commit.
    expect(await previewed(link("v1", "x/skills/polish"))).toEqual({
      ref: { name: "v1", kind: "tag" },
      sha: b,
      path: "x/skills/polish",
    });
    // A commit SHA, and a branch whose name is 40 hex digits, which is the branch.
    expect(await previewed(link(b, "x/skills/polish"))).toEqual({
      ref: { name: b, kind: "commit" },
      sha: b,
      path: "x/skills/polish",
    });
    expect(await previewed(link(hexBranch, "skills/polish"))).toEqual({
      ref: { name: hexBranch, kind: "branch" },
      sha: a,
      path: "skills/polish",
    });
    // A skill at the root: the whole remainder is the ref.
    expect(await previewed(link("main", ""))).toEqual({ ref: { name: "main", kind: "branch" }, sha: root, path: "" });
    expect(await previewed(link("a/b", ""))).toEqual({ ref: { name: "a/b", kind: "branch" }, sha: root, path: "" });
    // Two ref requests per split, whatever the depth.
    api.requests.length = 0;
    await previewed(link("feature/x", "skills/polish"));
    expect(api.requests.filter((request) => request.path.includes("/matching-refs/")).map((r) => r.path)).toEqual([
      `/repos/${OWNER}/${REPO}/git/matching-refs/heads/feature`,
      `/repos/${OWNER}/${REPO}/git/matching-refs/tags/feature`,
    ]);

    expect(
      await errorOf(await send(token, "POST", "/api/skills/preview", { url: link("nope", "skills/polish") })),
    ).toEqual({
      status: 404,
      body: { error: "not_found", detail: `no branch, tag or commit named nope in ${OWNER}/${REPO}` },
    });
  });

  it("reads the tree and SKILL.md by the resolved SHA, so a ref moved after the resolve changes nothing", async () => {
    const a = await repo.commit(polishFiles());
    const b = await repo.commit(polishFiles("skills/polish", { "SKILL.md": POLISH_B }));
    repo.heads.set("main", a);
    // The branch moves to B right after GitHub answered the resolve.
    api.intercept(
      (request) => request.path.endsWith("/commits/refs/heads/main"),
      async (_, serve) => {
        const answer = await serve();
        repo.heads.set("main", b);
        return answer;
      },
      1,
    );

    const shown = await preview(link("main", "skills/polish"));
    expect(shown.sha).toBe(a);
    expect(shown.description).toBe("Polishes text.");
    expect(repo.heads.get("main")).toBe(b);
  });

  it("takes a commit SHA in any case, after the exact branch and tag names", async () => {
    const a = await repo.commit(polishFiles());
    const b = await repo.commit(polishFiles("skills/polish", { "SKILL.md": POLISH_B }));
    const upper = b.toUpperCase();
    expect(await previewed(link(upper, "skills/polish"))).toEqual({
      ref: { name: b, kind: "commit" },
      sha: b,
      path: "skills/polish",
    });
    await register(a);
    expect(
      v.parse(
        SkillUpdatePreview,
        await (await send(token, "POST", "/api/skills/polish/preview", { ref: upper })).json(),
      ),
    ).toMatchObject({ ref: { name: b, kind: "commit" }, sha: b });
    // A branch of that name is the branch.
    await clearSkills();
    repo.heads.set(upper, a);
    expect(await previewed(link(upper, "skills/polish"))).toEqual({
      ref: { name: upper, kind: "branch" },
      sha: a,
      path: "skills/polish",
    });
  });

  it("refuses a directory the confirm would refuse before reading its tree, and shows a pin the confirm takes", async () => {
    // Five components of 205 bytes: 1,029 bytes, past the 1,024 a skill's directory may have.
    const long = ["a", "b", "c", "d", "e"].map((letter) => letter.repeat(205)).join("/");
    const backslash = "skills/a\\polish";
    const atCap = ["a", "b", "c", "d", "e"].map((letter) => letter.repeat(204)).join("/");
    const sha = await repo.commit({
      ...polishFiles(),
      ...polishFiles(long),
      ...polishFiles(backslash),
      ...polishFiles(atCap),
    });
    repo.heads.set("main", sha);
    // A branch whose name is longer than the 255 characters a pin's ref may have, before a valid directory.
    const longRef = "r".repeat(257);
    repo.heads.set(longRef, sha);

    expect(await refusedPreview(link("main", long))).toEqual({
      status: 422,
      body: { error: "invalid_skill", detail: expect.stringContaining("is longer than 1024 bytes") },
    });
    expect(await refusedPreview(link("main", "skills/a%5Cpolish"))).toEqual({
      status: 422,
      body: { error: "invalid_skill", detail: expect.stringContaining("holds a NUL or a backslash") },
    });
    expect(await refusedPreview(link(longRef, "skills/polish"))).toEqual({
      status: 422,
      body: { error: "invalid_skill", detail: `the ref ${longRef} is too long to pin` },
    });
    expect(api.requests.filter((request) => /\/git\/(trees|blobs)\//.test(request.path))).toEqual([]);

    // A preview's pin, sent as it came, is one the confirm takes.
    const shown = await preview(link("main", atCap));
    expect(new TextEncoder().encode(shown.source.path).byteLength).toBe(1024);
    const { name, source, ref, sha: pinned } = shown;
    expect(
      await answered(await send(token, "POST", "/api/skills", { name, source, ref, sha: pinned }), 201, Skill),
    ).toMatchObject({
      source,
      sha,
    });
  });

  it("pins only a commit: a tree's SHA in a link or a pin is refused before any tree is read", async () => {
    const sha = await repo.commit(polishFiles());
    repo.heads.set("main", sha);
    const tree = await repo.treeOf(sha, "skills/polish");
    const notACommit = {
      status: 404,
      body: {
        error: "not_found",
        detail: `no commit ${tree} in ${OWNER}/${REPO} (a tree's or a blob's SHA is not one)`,
      },
    };

    expect(await refusedPreview(link(tree, ""))).toEqual(notACommit);
    const asCommit = confirmation(tree, { path: "", ref: { name: tree, kind: "commit" } });
    expect(await errorOf(await send(token, "POST", "/api/skills", asCommit))).toEqual(notACommit);
    expect(await errorOf(await send(token, "POST", "/api/skills", confirmation(tree, { path: "" })))).toEqual(
      notACommit,
    );
    expect(api.requests.filter((request) => /\/git\/(trees|blobs)\//.test(request.path))).toEqual([]);
    expect(await storedRows()).toEqual({ skills: 0, files: 0 });
  });

  it("refuses an empty repository as one, and keeps any other 409 retryable", async () => {
    api.repository(OWNER, "empty");
    const empty = { status: 404, body: { error: "not_found", detail: `${OWNER}/empty is empty: it has no commit` } };
    expect(await refusedPreview(link("main", "skills/polish", "empty"))).toEqual(empty);
    const pin = { ...confirmation("1".repeat(40)), source: { owner: OWNER, repo: "empty", path: "skills/polish" } };
    expect(await errorOf(await send(token, "POST", "/api/skills", pin))).toEqual(empty);

    // GitHub's 409 for a repository it cannot serve now, or one whose body says nothing: a preview and a confirm may
    // be tried again.
    const sha = await repo.commit(polishFiles());
    repo.heads.set("main", sha);
    api.intercept(
      (request) => request.path.includes("/matching-refs/heads/"),
      async () => Response.json({ message: "Repository is temporarily unavailable." }, { status: 409 }),
      1,
    );
    expect(await refusedPreview(link("main", "skills/polish"))).toEqual({
      status: 503,
      body: { error: "unavailable", detail: "GitHub could not answer the branches (409); try again" },
    });
    api.intercept(
      (request) => request.path.includes("/git/commits/"),
      async () => new Response("conflict", { status: 409 }),
      1,
    );
    expect(await errorOf(await send(token, "POST", "/api/skills", confirmation(sha)))).toEqual({
      status: 503,
      body: { error: "unavailable", detail: `GitHub could not answer the commit ${sha} (409); try again` },
    });
  });

  it("refuses a link that is not one, a missing repository, directory or SKILL.md, and a registered name", async () => {
    const sha = await repo.commit(polishFiles());
    repo.heads.set("main", sha);

    expect(await refusedPreview("https://github.com/octo/skills/tree/main/skills/polish")).toMatchObject({
      status: 400,
      body: { error: "bad_request" },
    });
    expect(api.requests).toEqual([]);
    expect(await refusedPreview(link("main", "skills/polish", "missing"))).toMatchObject({
      status: 404,
      body: { error: "not_found", detail: expect.stringContaining("needs the App installed on it") },
    });
    expect(await refusedPreview(link("main", "skills/absent"))).toMatchObject({
      status: 404,
      body: { error: "not_found" },
    });
    expect(await refusedPreview(link("main", "skills"))).toEqual({
      status: 404,
      body: { error: "not_found", detail: `no SKILL.md in ${OWNER}/${REPO} skills at ${sha.slice(0, 7)}` },
    });

    await register(sha);
    expect(await refusedPreview(link("main", "skills/polish"))).toEqual({
      status: 409,
      body: { error: "skill_exists", detail: "a skill named polish is registered already; update it" },
    });
  });
});

describe("a confirm", () => {
  it("stores exactly the files at the given SHA without a ref request, and the settings list the skill", async () => {
    const files = polishFiles();
    const a = await repo.commit(files);
    const b = await repo.commit(polishFiles("skills/polish", { "SKILL.md": POLISH_B, "references/new.md": "new\n" }));
    repo.heads.set("main", a);
    const shown = await preview(link("main", "skills/polish"));
    // The branch moves before the confirm, which still pins the previewed SHA.
    repo.heads.set("main", b);
    api.requests.length = 0;

    const skill = await register(shown.sha);
    expect(refReads(api)).toEqual([]);
    expect(skill).toMatchObject({
      name: "polish",
      description: "Polishes text.",
      source: shown.source,
      ref: shown.ref,
      sha: a,
      allowedTools: shown.allowedTools,
      license: "MIT",
    });
    expect(skill.rev).toBeGreaterThan(0);
    expect((await instructions()).skills).toEqual([skill]);

    const stored = await storedFiles("polish");
    expect(stored?.files.map(({ path, mode, blob }) => ({ path, mode, blob }))).toEqual(
      treeUnder(files, a, "skills/polish"),
    );
    for (const file of stored?.files ?? []) {
      expect(await gitBlobSha(file.content)).toBe(file.blob);
      expect(file.content.byteLength).toBe(file.size);
    }
    // SKILL.md first, then the others.
    expect(blobReads(api)[0]?.path).toContain(repo.blobOf(a, "skills/polish/SKILL.md"));
    expect(events(logs, "prq.skill.fetched").at(-1)).toMatchObject({
      phase: "confirm",
      installationId: 5,
      sha: a,
      files: 3,
    });
    expect(events(logs, "prq.skill.registered")).toEqual([
      { event: "prq.skill.registered", name: "polish", rev: skill.rev, sha: a, files: 3 },
    ]);
  });

  it("keeps every byte: a text file with a BOM and a binary file, stored with their tree's sizes and blob SHAs", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hello\n")]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
    const sha = await repo.commit(polishFiles("skills/polish", { "references/bom.md": bom, "assets/logo.png": png }));
    await register(sha);

    const stored = await storedFiles("polish");
    const byPath = new Map(stored?.files.map((file) => [file.path, file]));
    expect(byPath.get("references/bom.md")?.content).toEqual(bom);
    expect(byPath.get("assets/logo.png")?.content).toEqual(png);
    expect(byPath.get("references/bom.md")?.blob).toBe(await gitBlobSha(bom));
    expect(byPath.get("assets/logo.png")?.blob).toBe(await gitBlobSha(png));
    expect(byPath.get("assets/logo.png")?.blob).toBe(repo.blobOf(sha, "skills/polish/assets/logo.png"));
  });

  it("refuses a blob whose bytes do not match its tree, storing nothing", async () => {
    const sha = await repo.commit(polishFiles());
    const style = repo.blobOf(sha, "skills/polish/references/style.md");
    api.intercept(
      (request) => request.path.endsWith(`/git/blobs/${style}`),
      async () => new Response("# Stole\n", { headers: { "content-type": "text/plain; charset=utf-8" } }),
      1,
    );

    expect(await errorOf(await send(token, "POST", "/api/skills", confirmation(sha)))).toEqual({
      status: 422,
      body: {
        error: "invalid_skill",
        detail: "the blob of references/style.md does not match its tree (size or SHA-1)",
      },
    });
    expect(await storedRows()).toEqual({ skills: 0, files: 0 });

    // A body shorter than its tree says, whose SHA-1 is that of the bytes sent.
    const short = await repo.commit(
      polishFiles("skills/polish", { "references/short.md": { bytes: "8 bytes!", mode: "100644", size: 9 } }),
    );
    expect(await errorOf(await send(token, "POST", "/api/skills", confirmation(short)))).toEqual({
      status: 422,
      body: {
        error: "invalid_skill",
        detail: "the blob of references/short.md does not match its tree (size or SHA-1)",
      },
    });
    expect(await storedRows()).toEqual({ skills: 0, files: 0 });
  });

  it("stores allowed-tools written as a list exactly as written, spacing included", async () => {
    const listed = POLISH_MD.replace(
      /allowed-tools: .*/,
      'allowed-tools:\n  - Read\n  - "Bash(python3  a.py *) "\n  - " Grep"',
    );
    const sha = await repo.commit(polishFiles("skills/polish", { "SKILL.md": listed }));
    const entries = [{ entry: "Read" }, { entry: "Bash(python3  a.py *) " }, { entry: " Grep" }];
    expect((await register(sha)).allowedTools).toEqual(entries);
    expect((await instructions()).skills.map((skill) => skill.allowedTools)).toEqual([entries]);
  });

  it("reads and checks SKILL.md before any other blob, and stores only the skill whose SKILL.md has the name sent", async () => {
    const sha = await repo.commit({
      ...polishFiles("a/alpha", { "SKILL.md": POLISH_MD.replace("name: polish", "name: alpha") }),
      ...polishFiles("b/beta", { "SKILL.md": POLISH_MD.replace("name: polish", "name: beta") }),
    });

    expect(
      await errorOf(await send(token, "POST", "/api/skills", confirmation(sha, { name: "alpha", path: "b/beta" }))),
    ).toEqual({
      status: 422,
      body: {
        error: "invalid_skill",
        detail: `the SKILL.md of ${OWNER}/${REPO} b/beta at ${sha.slice(0, 7)} is named beta, not alpha`,
      },
    });
    expect(blobReads(api).map((request) => request.path)).toEqual([
      `/repos/${OWNER}/${REPO}/git/blobs/${repo.blobOf(sha, "b/beta/SKILL.md")}`,
    ]);
    expect(await storedRows()).toEqual({ skills: 0, files: 0 });
  });
});

describe("the caps", () => {
  it("refuses a symlink, a submodule and a truncated tree before any blob", async () => {
    expect(await confirmWith({ "references/link": { bytes: "../../README.md", mode: "120000" } })).toEqual({
      status: 422,
      detail: expect.stringContaining("symlink at references/link"),
      blobs: 0,
    });
    expect(await confirmWith({ vendor: { bytes: "", mode: "160000" } })).toMatchObject({
      status: 422,
      detail: expect.stringContaining("submodule at vendor"),
      blobs: 0,
    });
    repo.truncated = true;
    expect(await confirmWith({})).toMatchObject({
      status: 422,
      detail: expect.stringContaining("too many entries"),
      blobs: 0,
    });
  });

  it("takes SKILL_FILES files and refuses one more before any blob", async () => {
    // polishFiles holds three files of the skill.
    expect(await confirmWith(manyFiles(SKILL_FILES - 3))).toMatchObject({ status: 201, blobs: SKILL_FILES });
    expect(await confirmWith(manyFiles(SKILL_FILES - 2))).toEqual({
      status: 422,
      detail: expect.stringContaining(`${SKILL_FILES + 1} files, more than ${SKILL_FILES}`),
      blobs: 0,
    });
  });

  it("takes a file of SKILL_FILE_BYTES and a skill of SKILL_BYTES, and refuses a byte more of either before any blob", async () => {
    expect(await confirmWith({ "assets/big.bin": new Uint8Array(SKILL_FILE_BYTES) })).toMatchObject({ status: 201 });
    expect(await confirmWith({ "assets/big.bin": new Uint8Array(SKILL_FILE_BYTES + 1) })).toEqual({
      status: 422,
      detail: `assets/big.bin is ${SKILL_FILE_BYTES + 1} bytes, more than ${SKILL_FILE_BYTES}`,
      blobs: 0,
    });
    // The three polish files, then files of SKILL_FILE_BYTES up to the cap, the last one short of it.
    const small = POLISH_MD_BYTES + 8 + 12;
    const fill = (extra: number) => {
      const files: Record<string, Uint8Array> = {};
      let left = SKILL_BYTES - small + extra;
      for (let index = 0; left > 0; index += 1) {
        const size = Math.min(left, SKILL_FILE_BYTES);
        files[`assets/${index}.bin`] = new Uint8Array(size).fill(index);
        left -= size;
      }
      return files;
    };
    expect(await confirmWith(fill(0))).toMatchObject({ status: 201 });
    expect(await confirmWith(fill(1))).toMatchObject({
      status: 422,
      detail: expect.stringContaining(`${SKILL_BYTES + 1} bytes, more than ${SKILL_BYTES}`),
      blobs: 0,
    });
  });

  it("takes a path of SKILL_PATH_BYTES bytes, multibyte counted in bytes, and refuses one more", async () => {
    const atCap = `r/bb${"あ".repeat((SKILL_PATH_BYTES - 4) / 3)}`;
    expect(await confirmWith({ [atCap]: "x" })).toMatchObject({ status: 201 });
    expect(await confirmWith({ [`${atCap}x`]: "x" })).toMatchObject({
      status: 422,
      detail: expect.stringContaining("longer than 100 bytes"),
      blobs: 0,
    });
  });

  it("refuses paths whose first differing components are equal but for case, and takes the others", async () => {
    expect(await confirmWith({ "Docs/a.md": "a", "docs/b.md": "b" })).toMatchObject({
      status: 422,
      detail: expect.stringContaining("differ only in the case"),
      blobs: 0,
    });
    expect(await confirmWith({ "Readme.md": "a", "README.md": "b" })).toMatchObject({ status: 422, blobs: 0 });
    expect(
      await confirmWith({ "docs/a.md": "a", "docs/b.md": "b", "a/Docs/x.md": "x", "b/docs/y.md": "y" }),
    ).toMatchObject({
      status: 201,
    });
  });

  it("refuses frontmatter over a cap, invalid, or not UTF-8 after reading SKILL.md alone", async () => {
    expect(await confirmWith({}, withField(`license: ${"l".repeat(200)}`))).toMatchObject({ status: 201 });
    expect(await confirmWith({}, withField(`license: ${"l".repeat(201)}`))).toMatchObject({
      status: 422,
      detail: expect.stringContaining("license"),
      blobs: 1,
    });
    expect(
      await confirmWith({}, POLISH_MD.replace(/allowed-tools: .*/, `allowed-tools: ${"t".repeat(2000)}`)),
    ).toMatchObject({
      status: 201,
    });
    expect(
      await confirmWith({}, POLISH_MD.replace(/allowed-tools: .*/, `allowed-tools: ${"t".repeat(2001)}`)),
    ).toMatchObject({
      status: 422,
      detail: expect.stringContaining("allowed-tools"),
      blobs: 1,
    });
    expect(await confirmWith({}, "# No frontmatter\n")).toMatchObject({ status: 422, blobs: 1 });
    expect(
      await confirmWith({
        "SKILL.md": new Uint8Array([...new TextEncoder().encode("---\nname: polish\n"), 0xff, 0x0a]),
      }),
    ).toMatchObject({ status: 422, detail: "SKILL.md is not UTF-8", blobs: 1 });
  });
});

describe("an update", () => {
  it("pins a ref of the registered source, leaving exactly the new version's files", async () => {
    const aFiles = polishFiles("skills/polish", { "references/old.md": "old\n" });
    const a = await repo.commit(aFiles);
    const bFiles = polishFiles("skills/polish", { "SKILL.md": POLISH_B, "references/new.md": "new\n" });
    const b = await repo.commit(bFiles);
    repo.heads.set("main", a);
    repo.tags.set("v2", b);
    const registered = await register(a);

    const res = await send(token, "POST", "/api/skills/polish/preview", { ref: "v2" });
    expect(res.status).toBe(200);
    const update = v.parse(SkillUpdatePreview, await res.json());
    expect(update).toMatchObject({
      sha: b,
      ref: { name: "v2", kind: "tag" },
      source: registered.source,
      description: "Polishes text, version B.",
      current: {
        source: registered.source,
        ref: registered.ref,
        sha: a,
        rev: registered.rev,
        allowedTools: registered.allowedTools,
      },
    });

    const put = await send(token, "PUT", "/api/skills/polish", {
      ...confirmation(b, { ref: update.ref }),
      expectedRev: update.current.rev,
    });
    expect(put.status).toBe(200);
    const updated = v.parse(Skill, await put.json());
    expect(updated).toMatchObject({ sha: b, ref: { name: "v2", kind: "tag" }, registeredAt: registered.registeredAt });
    expect(updated.rev).toBeGreaterThan(registered.rev);
    const stored = await storedFiles("polish");
    expect(stored?.files.map(({ path, mode, blob }) => ({ path, mode, blob }))).toEqual(
      treeUnder(bFiles, b, "skills/polish"),
    );

    // The old revision no longer applies.
    expect(
      await errorOf(
        await send(token, "PUT", "/api/skills/polish", { ...confirmation(a), expectedRev: registered.rev }),
      ),
    ).toMatchObject({ status: 409, body: { error: "skill_changed" } });
    expect((await storedFiles("polish"))?.skill.sha).toBe(b);

    // A full SHA is a ref of its own.
    const bySha = await send(token, "POST", "/api/skills/polish/preview", { ref: a });
    expect(v.parse(SkillUpdatePreview, await bySha.json())).toMatchObject({ sha: a, ref: { name: a, kind: "commit" } });
  });

  it("pins a new link's source, a permalink whose skill moved directory, and refuses another name", async () => {
    const a = await repo.commit(polishFiles());
    const registered = await register(a);
    const c = await repo.commit(polishFiles("moved/polish"));
    const d = await repo.commit(
      polishFiles("skills/polish", { "SKILL.md": POLISH_MD.replace("name: polish", "name: other") }),
    );

    const res = await send(token, "POST", "/api/skills/polish/preview", { url: link(c, "moved/polish") });
    const update = v.parse(SkillUpdatePreview, await res.json());
    expect(update).toMatchObject({
      sha: c,
      ref: { name: c, kind: "commit" },
      source: { owner: OWNER, repo: REPO, path: "moved/polish" },
      current: { sha: a, source: { path: "skills/polish" } },
    });
    const put = await send(token, "PUT", "/api/skills/polish", {
      ...confirmation(c, { path: "moved/polish", ref: update.ref }),
      expectedRev: registered.rev,
    });
    expect(v.parse(Skill, await put.json())).toMatchObject({ sha: c, source: { path: "moved/polish" } });

    expect(
      await errorOf(await send(token, "POST", "/api/skills/polish/preview", { url: link(d, "skills/polish") })),
    ).toEqual({
      status: 422,
      body: { error: "invalid_skill", detail: "the skill there is named other, not polish" },
    });
    const current = (await storedFiles("polish"))?.skill;
    expect(
      await errorOf(await send(token, "PUT", "/api/skills/polish", { ...confirmation(d), expectedRev: current?.rev })),
    ).toMatchObject({ status: 422, body: { error: "invalid_skill" } });
    expect((await storedFiles("polish"))?.skill).toEqual(current);
    // Unknown names, and a body naming another skill than the path.
    expect(await errorOf(await send(token, "POST", "/api/skills/absent/preview", { ref: "main" }))).toMatchObject({
      status: 404,
    });
    expect(
      await errorOf(
        await send(token, "PUT", "/api/skills/polish", { ...confirmation(c, { name: "other" }), expectedRev: 1 }),
      ),
    ).toMatchObject({ status: 400 });
  });
});

describe("an update's source and revision", () => {
  it("pins a link to another repository, reading it there", async () => {
    const registered = await register(await repo.commit(polishFiles()));
    const fork = api.repository(OWNER, "fork");
    const forkFiles = polishFiles("skills/polish", { "SKILL.md": POLISH_B });
    const f = await fork.commit(forkFiles);
    fork.heads.set("main", f);

    const res = await send(token, "POST", "/api/skills/polish/preview", { url: link("main", "skills/polish", "fork") });
    const update = v.parse(SkillUpdatePreview, await res.json());
    expect(update).toMatchObject({
      sha: f,
      source: { owner: OWNER, repo: "fork", path: "skills/polish" },
      description: "Polishes text, version B.",
      current: { source: registered.source },
    });
    api.requests.length = 0;
    const { name, source, ref, sha } = update;
    const put = await send(token, "PUT", "/api/skills/polish", { name, source, ref, sha, expectedRev: registered.rev });
    expect(v.parse(Skill, await put.json())).toMatchObject({ sha: f, source: { repo: "fork" } });
    expect(
      api.requests
        .filter((request) => request.path.startsWith("/repos/"))
        .every((request) => request.path.startsWith(`/repos/${OWNER}/fork/`)),
    ).toBe(true);
    const stored = await storedFiles("polish");
    expect(stored?.files.every((file) => file.blob === fork.blobOf(f, `skills/polish/${file.path}`))).toBe(true);
  });

  it("refuses an update at another revision, or of a removed skill, before reading GitHub", async () => {
    const a = await repo.commit(polishFiles());
    const b = await repo.commit(polishFiles("skills/polish", { "SKILL.md": POLISH_B }));
    const registered = await register(a);
    const changed = {
      status: 409,
      body: {
        error: "skill_changed",
        detail: "the skill polish was updated or removed since the preview; preview it again",
      },
    };
    api.requests.length = 0;
    const stale = { ...confirmation(b), expectedRev: registered.rev + 1 };
    expect(await errorOf(await send(token, "PUT", "/api/skills/polish", stale))).toEqual(changed);
    expect(await send(token, "DELETE", "/api/skills/polish")).toHaveProperty("status", 204);
    const removed = { ...confirmation(b), expectedRev: registered.rev };
    expect(await errorOf(await send(token, "PUT", "/api/skills/polish", removed))).toEqual(changed);
    expect(api.requests).toEqual([]);
  });
});

describe("a remove and the count", () => {
  it("removes the row and the files; a register past SKILL_COUNT answers 400", async () => {
    const sha = await repo.commit(polishFiles());
    await register(sha);
    const remove = await send(token, "DELETE", "/api/skills/polish");
    expect(remove.status).toBe(204);
    expect(await storedRows()).toEqual({ skills: 0, files: 0 });
    expect((await instructions()).skills).toEqual([]);
    expect(await errorOf(await send(token, "DELETE", "/api/skills/polish"))).toMatchObject({ status: 404 });
    expect(events(logs, "prq.skill.removed")).toEqual([{ event: "prq.skill.removed", name: "polish" }]);

    const stub = await hub();
    for (let index = 0; index < SKILL_COUNT; index += 1) {
      expect(await stub.registerSkill(seedVersion(`seed-${index}`))).toHaveProperty("rev");
    }
    expect(await errorOf(await send(token, "POST", "/api/skills", confirmation(sha)))).toEqual({
      status: 400,
      body: { error: "bad_request", detail: `${SKILL_COUNT} skills are registered already; remove one first` },
    });
    expect((await storedRows()).skills).toBe(SKILL_COUNT);
    expect((await instructions()).skills.map((skill) => skill.name)).toEqual(
      Array.from({ length: SKILL_COUNT }, (_, index) => `seed-${index}`).toSorted((a, b) => (a < b ? -1 : 1)),
    );
  });
});

describe("the installation", () => {
  it("reads with the repository's installation, else the first active one of the App's list", async () => {
    const sha = await repo.commit(polishFiles());
    repo.heads.set("main", sha);
    await preview(link("main", "skills/polish"));
    expect(api.tokens().map((request) => request.path)).toEqual(["/app/installations/5/access_tokens"]);
    expect(api.requests.some((request) => request.path === "/app/installations")).toBe(false);

    const other = api.repository(OWNER, "third-party");
    other.heads.set("main", await other.commit(polishFiles()));
    api.installations([{ id: 11, suspended: true }, { id: 12 }, { id: 13 }]);
    api.requests.length = 0;
    await preview(link("main", "skills/polish", "third-party"));
    expect(api.requests.filter((request) => request.path === "/app/installations").map((r) => r.search)).toEqual([
      "?per_page=100",
    ]);
    expect(api.tokens().map((request) => request.path)).toEqual(["/app/installations/12/access_tokens"]);
    expect(events(logs, "prq.skill.fetched").at(-1)).toMatchObject({ installationId: 12 });

    api.installations([{ id: 11, suspended: true }]);
    api.requests.length = 0;
    expect(
      await errorOf(
        await send(token, "POST", "/api/skills/preview", { url: link("main", "skills/polish", "third-party") }),
      ),
    ).toEqual({
      status: 503,
      body: { error: "unavailable", detail: "no active installation of the GitHub App" },
    });
    expect(api.tokens()).toEqual([]);
  });

  it("answers 500 without the App, and 503 with the reset time when GitHub's rate limit is reached", async () => {
    expect(
      await errorOf(
        await send(token, "POST", "/api/skills/preview", { url: link("main", "skills/polish") }, { app: false }),
      ),
    ).toEqual({ status: 500, body: { error: "internal", detail: "the GitHub App is not configured" } });
    expect(api.requests).toEqual([]);

    const reset = Math.floor(Date.UTC(2026, 10, 18, 12) / 1000);
    api.intercept(
      (request) => request.path.includes("/matching-refs/"),
      async () =>
        Response.json(
          { message: "API rate limit exceeded" },
          { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } },
        ),
    );
    expect(
      await errorOf(await send(token, "POST", "/api/skills/preview", { url: link("main", "skills/polish") })),
    ).toEqual({
      status: 503,
      body: { error: "unavailable", detail: "GitHub's rate limit is reached until 2026-11-18T12:00:00.000Z" },
    });
  });
});
