// What the skills checks share: GitHub read as the GitHub App for their oracle (its own JWT and an installation token,
// never through the Worker), the Worker's /api as the host calls it, and the skills they register.

import { createHash } from "node:crypto";

import { Skill, SkillPreview } from "@prq/protocol";
import { importPKCS8, SignJWT } from "jose";
import * as v from "valibot";
import { parse } from "yaml";

import type { GithubAppSettings, Worker } from "./worker.ts";

const API = "https://api.github.com";

// A skill's directory in a repository.
export type SkillDir = { owner: string; repo: string; path: string };

export const YOMIYASU: SkillDir = { owner: "nanaism", repo: "yomiyasu", path: "skills/yomiyasu" };
// A second public skill, without scripts, at the commit the plan pinned (resolved to its full SHA through GitHub).
export const INTERNAL_COMMS: SkillDir = { owner: "anthropics", repo: "skills", path: "skills/internal-comms" };
export const INTERNAL_COMMS_COMMIT = "e4bb5d96";

const Installations = v.array(v.object({ id: v.number(), suspended_at: v.nullish(v.string()) }));
const Token = v.object({ token: v.string() });
const Tree = v.object({
  truncated: v.boolean(),
  tree: v.array(
    v.object({ path: v.string(), mode: v.string(), type: v.string(), sha: v.string(), size: v.optional(v.number()) }),
  ),
});
const Frontmatter = v.object({ name: v.string(), description: v.string() });

type ManifestFile = { path: string; mode: string; size: number; blob: string };
// A skill's regular files at a commit, its SKILL.md's bytes and the name and description parsed from them.
export type Manifest = { sha: string; name: string; description: string; files: ManifestFile[]; skillMd: Uint8Array };

export function sha1Blob(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// SKILL.md's lines after the closing `---` of its frontmatter, read here.
export function bodyOf(skillMd: Uint8Array): string {
  const lines = new TextDecoder().decode(skillMd).split("\n");
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (lines[0]?.trimEnd() !== "---" || end < 0) {
    throw new Error("SKILL.md has no frontmatter");
  }
  return lines.slice(end + 1).join("\n");
}

// GitHub read as the App: the first active installation of its list, and reads with that installation's token, through
// the fetch from before the Worker's harness wrapped it.
export async function appGithub(app: GithubAppSettings, direct: typeof fetch) {
  const key = await importPKCS8(app.GITHUB_APP_PRIVATE_KEY, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(app.GITHUB_APP_ID)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .sign(key);
  const call = async (path: string, init: RequestInit, authorization: string) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", authorization);
    headers.set("user-agent", "prq-skills-check");
    headers.set("x-github-api-version", "2022-11-28");
    const res = await direct(`${API}${path}`, { ...init, headers });
    if (!res.ok) {
      throw new Error(`GitHub answered ${res.status} to ${init.method ?? "GET"} ${path}`);
    }
    return res;
  };
  const listed = v.parse(
    Installations,
    await (await call("/app/installations?per_page=100", {}, `Bearer ${jwt}`)).json(),
  );
  const installation = listed.find((entry) => entry.suspended_at === null || entry.suspended_at === undefined);
  if (installation === undefined) {
    throw new Error("the App has no active installation");
  }
  const minted = await call(`/app/installations/${installation.id}/access_tokens`, { method: "POST" }, `Bearer ${jwt}`);
  const { token } = v.parse(Token, await minted.json());
  const read = (path: string, accept: string) => call(path, { headers: { accept } }, `token ${token}`);
  const blob = async (dir: SkillDir, sha: string) =>
    new Uint8Array(
      await (
        await read(`/repos/${dir.owner}/${dir.repo}/git/blobs/${sha}`, "application/vnd.github.raw")
      ).arrayBuffer(),
    );
  return {
    installation: installation.id,
    installations: listed.length,
    // The commit a branch (heads/<name>) or tag (tags/<name>) names now, a tag peeled, or the commit an abbreviated SHA
    // names.
    commitOf: async (dir: SkillDir, ref: string) =>
      (
        await (
          await read(
            `/repos/${dir.owner}/${dir.repo}/commits/${/^(heads|tags)\//.test(ref) ? `refs/${encodedPath(ref)}` : ref}`,
            "application/vnd.github.sha",
          )
        ).text()
      ).trim(),
    blob,
    // The skill's regular files at the commit, and SKILL.md's name and description, read and parsed here.
    manifestAt: async (dir: SkillDir, sha: string): Promise<Manifest> => {
      const tree = v.parse(
        Tree,
        await (
          await read(
            `/repos/${dir.owner}/${dir.repo}/git/trees/${sha}:${encodedPath(dir.path)}?recursive=1`,
            "application/vnd.github+json",
          )
        ).json(),
      );
      if (tree.truncated) {
        throw new Error(`GitHub cut the tree at ${sha} short`);
      }
      const files = tree.tree
        .filter((entry) => entry.type === "blob")
        .map(({ path, mode, sha: blobSha, size }) => ({ path, mode, size: size ?? -1, blob: blobSha }))
        .toSorted((a, b) => (a.path < b.path ? -1 : 1));
      const entry = files.find((file) => file.path === "SKILL.md");
      if (entry === undefined) {
        throw new Error(`no SKILL.md in ${dir.path} at ${sha}`);
      }
      const skillMd = await blob(dir, entry.blob);
      if (sha1Blob(skillMd) !== entry.blob) {
        throw new Error("SKILL.md's bytes do not match its blob");
      }
      const lines = new TextDecoder().decode(skillMd).split(/\r?\n/);
      const end = lines.indexOf("---", 1);
      const { name, description } = v.parse(Frontmatter, parse(lines.slice(1, end).join("\n")));
      return { sha, name, description, files, skillMd };
    },
  };
}

export type Github = Awaited<ReturnType<typeof appGithub>>;

// A call to the Worker's /api with the host's Access token: its status and JSON body (null for none).
export async function api(worker: Worker, method: string, path: string, body?: unknown) {
  const res = await fetch(new URL(path, worker.url()), {
    method,
    headers: {
      "Cf-Access-Jwt-Assertion": await worker.token(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : (JSON.parse(text) as unknown) };
}

// The link to a skill's SKILL.md at a ref (a branch, a tag or a commit).
export function skillLink(dir: SkillDir, ref: string): string {
  return `https://github.com/${dir.owner}/${dir.repo}/blob/${ref}/${dir.path}/SKILL.md`;
}

// Registers the skill a link names, as the settings do: its preview, then the confirm with the previewed name and SHA.
export async function registerSkill(worker: Worker, url: string): Promise<Skill> {
  const previewed = await api(worker, "POST", "/api/skills/preview", { url });
  if (previewed.status !== 200) {
    throw new Error(`the preview of ${url} answered ${previewed.status} ${JSON.stringify(previewed.body)}`);
  }
  const { name, source, ref, sha } = v.parse(SkillPreview, previewed.body);
  const confirmed = await api(worker, "POST", "/api/skills", { name, source, ref, sha });
  if (confirmed.status !== 201) {
    throw new Error(`the confirm of ${name} answered ${confirmed.status} ${JSON.stringify(confirmed.body)}`);
  }
  return v.parse(Skill, confirmed.body);
}
