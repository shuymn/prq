import {
  ErrorResponse,
  PRQ_VERSION_HEADER,
  ROUTE_CALL_MS,
  type Skill,
  SKILL_FILE_BYTES,
  SKILL_PATH_BYTES,
  SkillFilesResponse,
} from "@prq/protocol";
import { runInDurableObject } from "cloudflare:test";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Hub } from "./hub.ts";
import type { SkillVersion } from "./instructions/skills.ts";
import { CONTEXT_PAGE_BYTES } from "./pr-session/context.ts";
import { captureLogs } from "./test/access.ts";
import { hostToken } from "./test/chat.ts";
import { fetchBounded, heldBound, post, postRequest } from "./test/cli.ts";
import { gitBlobSha } from "./test/github.ts";
import { clearSkills, gate, hub, tracked, within } from "./test/session.ts";
import { registered } from "./test/skills.ts";
import { SERVER_VERSION } from "./version.ts";

// /cli/skill (docs/design.md, Local CLI): a registered skill's files, whole, in pages within the context page budget,
// at the revision a local agent's context listed.

const encoder = new TextEncoder();

beforeEach(async () => {
  await clearSkills();
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Files = Record<string, { bytes: Uint8Array; mode?: "100644" | "100755" }>;

// A version of a skill with the given files, each with its real git blob SHA-1.
async function version(name: string, files: Files, sha = "1".repeat(40)): Promise<SkillVersion> {
  return {
    name,
    description: `The ${name} skill.`,
    license: null,
    allowedTools: null,
    source: { owner: "octo", repo: "skills", path: name },
    ref: { name: "main", kind: "branch" },
    sha,
    files: await Promise.all(
      Object.entries(files).map(async ([path, { bytes, mode = "100644" }]) => ({
        path,
        mode,
        size: bytes.byteLength,
        blob: await gitBlobSha(bytes),
        content: bytes,
      })),
    ),
  };
}

function filled(size: number, byte: number): Uint8Array {
  return new Uint8Array(size).fill(byte);
}

function decoded(content: string): Uint8Array {
  return Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
}

// A page's request, the cursor after the first.
function pageOf(token: string, { name, rev }: Pick<Skill, "name" | "rev">, cursor?: string): Promise<Response> {
  return post("/cli/skill", token, cursor === undefined ? { name, rev } : { name, rev, cursor });
}

// Every page of a skill, each response's body checked against the budget; the pages and their sizes.
async function allPages(token: string, skill: Pick<Skill, "name" | "rev">) {
  const pages: { page: SkillFilesResponse; bytes: number }[] = [];
  let cursor: string | undefined;
  do {
    const res = await pageOf(token, skill, cursor);
    expect(res.status).toBe(200);
    expect(res.headers.get(PRQ_VERSION_HEADER)).toBe(SERVER_VERSION);
    const text = await res.text();
    const bytes = encoder.encode(text).byteLength;
    expect(bytes).toBeLessThanOrEqual(CONTEXT_PAGE_BYTES);
    const page = v.parse(SkillFilesResponse, JSON.parse(text));
    pages.push({ page, bytes });
    expect(pages.length).toBeLessThan(16);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return pages;
}

async function refusal(response: Promise<Response>) {
  const res = await response;
  return { status: res.status, error: v.parse(ErrorResponse, await res.json()).error };
}

// A file as a page's JSON holds it, its bytes as base64 characters (none of which JSON escapes).
function entry(path: string, size: number) {
  return { path, mode: "100644", size, blob: "0".repeat(40), content: "A".repeat(4 * Math.ceil(size / 3)) };
}

// Five files at the size cap, then a filler, then the file with the longest path a skill may have. The filler's path
// and size are found here so that a page holding the first six, with the last file's path as its cursor, is exactly
// `target` bytes of JSON: the body the route writes, measured independently of how the route sizes its pages.
function pagedFiles(target: number): Files {
  const big = ["a1", "a2", "a3", "a4", "a5"];
  const last = "c".repeat(SKILL_PATH_BYTES);
  const bigEntries = big.map((path) => entry(path, SKILL_FILE_BYTES));
  const bytesWith = (path: string, size: number) =>
    encoder.encode(JSON.stringify({ files: [...bigEntries, entry(path, size)], nextCursor: last })).byteLength;
  for (let length = 1; length <= 4; length += 1) {
    const path = `b${"x".repeat(length)}`;
    const room = target - bytesWith(path, 0);
    for (let size = Math.floor((room * 3) / 4) - 6; size <= Math.floor((room * 3) / 4) + 6; size += 1) {
      if (bytesWith(path, size) === target) {
        return {
          ...Object.fromEntries(big.map((name, index) => [name, { bytes: filled(SKILL_FILE_BYTES, index) }])),
          [path]: { bytes: filled(size, 0x62), mode: "100755" },
          [last]: { bytes: encoder.encode("the last file\n") },
        };
      }
    }
  }
  throw new Error(`no filler makes a page of ${target} bytes`);
}

describe("/cli/skill", () => {
  it("fills a page exactly with whole files, the next file on the next page, and rebuilds the manifest", async () => {
    captureLogs();
    const token = await hostToken();
    const files = pagedFiles(CONTEXT_PAGE_BYTES);
    const stored = await version("paged", files);
    const skill = await registered(stored);

    const pages = await allPages(token, skill);

    expect(pages.map(({ page }) => page.files.length)).toEqual([6, 1]);
    expect(pages[0]?.bytes).toBe(CONTEXT_PAGE_BYTES);
    expect(pages[0]?.page.nextCursor).toBe("c".repeat(SKILL_PATH_BYTES));
    expect(pages[1]?.page.nextCursor).toBeNull();
    // Every file whole, in path order: paths, modes, sizes, blobs, and bytes that hash to the blob.
    const read = pages.flatMap(({ page }) => page.files);
    const sorted = stored.files.toSorted((a, b) => (a.path < b.path ? -1 : 1));
    expect(read.map(({ path, mode, size, blob }) => ({ path, mode, size, blob }))).toEqual(
      sorted.map(({ path, mode, size, blob }) => ({ path, mode, size, blob })),
    );
    for (const file of read) {
      expect(await gitBlobSha(decoded(file.content))).toBe(file.blob);
    }
  });

  it("moves a file that would make the page a byte over the budget to the next page", async () => {
    captureLogs();
    const token = await hostToken();
    const skill = await registered(await version("paged", pagedFiles(CONTEXT_PAGE_BYTES + 1)));

    const pages = await allPages(token, skill);

    expect(pages.map(({ page }) => page.files.map((file) => file.path[0]))).toEqual([
      ["a", "a", "a", "a", "a"],
      ["b", "c"],
    ]);
  });

  it("answers 404 for a skill not registered, 409 for another revision, 400 for a cursor that names no file", async () => {
    captureLogs();
    const token = await hostToken();
    const files = { "SKILL.md": { bytes: encoder.encode("---\nname: polish\n---\n") } };
    const first = await registered(await version("polish", files));

    expect(await refusal(pageOf(token, { name: "absent", rev: first.rev }))).toEqual({
      status: 404,
      error: "not_found",
    });
    expect(await refusal(pageOf(token, first, "no/such/file.md"))).toEqual({ status: 400, error: "bad_request" });
    expect(await refusal(post("/cli/skill", token, { name: "Not A Name", rev: 1 }))).toEqual({
      status: 400,
      error: "bad_request",
    });

    // Removed and registered again at the same commit and files: another revision, which the old one does not read.
    await (await hub()).removeSkill("polish");
    expect(await refusal(pageOf(token, first))).toEqual({ status: 404, error: "not_found" });
    const again = await registered(await version("polish", files));
    expect(again.rev).toBeGreaterThan(first.rev);
    expect(await refusal(pageOf(token, first))).toEqual({ status: 409, error: "skill_changed" });
    expect((await allPages(token, again)).flatMap(({ page }) => page.files.map((file) => file.path))).toEqual([
      "SKILL.md",
    ]);
  });

  it("refuses a later page once the skill was updated, so one read never mixes two versions", async () => {
    captureLogs();
    const token = await hostToken();
    const files = pagedFiles(CONTEXT_PAGE_BYTES);
    const skill = await registered(await version("paged", files));
    const res = await pageOf(token, skill);
    const first = v.parse(SkillFilesResponse, await res.json());
    expect(first.nextCursor).not.toBeNull();

    const updated = await (await hub()).updateSkill(await version("paged", files, "2".repeat(40)), skill.rev);
    expect(updated).toMatchObject({ sha: "2".repeat(40) });

    expect(await refusal(pageOf(token, skill, first.nextCursor ?? undefined))).toEqual({
      status: 409,
      error: "skill_changed",
    });
  });

  it("answers 503 when the Hub does not answer in time; the late read changes nothing", async () => {
    captureLogs();
    const token = await hostToken();
    const skill = await registered(
      await version("polish", { "SKILL.md": { bytes: encoder.encode("---\nname: polish\n---\n") } }),
    );
    const stub = await hub();
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const page = instance.skillPage.bind(instance);
      // RPC calls the method from the class, so the spy is on the prototype.
      vi.spyOn(Hub.prototype, "skillPage").mockImplementationOnce(async (...args) => {
        await held.wait();
        return page(...args);
      });
    });
    const limit = heldBound();
    const res = tracked(
      fetchBounded(limit.bound, postRequest("/cli/skill", token, { name: skill.name, rev: skill.rev })),
    );
    await held.reached();
    expect(res.settled()).toBe(false);

    limit.expire();
    expect(await refusal(within(res.promise, 3000))).toEqual({ status: 503, error: "unavailable" });
    expect(limit.bounds).toEqual([{ ms: ROUTE_CALL_MS, what: "the skill" }]);
    await held.open();
    expect(await limit.late()).toMatchObject({ nextCursor: null });
  });
});
