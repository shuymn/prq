// The skill routes as the settings call them, against the served GitHub (src/test/github.ts), with the App configured
// in the env each call gets; and the Hub's stored copy, read back.

import { ErrorResponse, type SkillRef } from "@prq/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";

import { createApp } from "../app.ts";
import type { CallBound } from "../http.ts";
import type { SkillVersion } from "../instructions/skills.ts";
import { withTimeout } from "../wait.ts";
import { request } from "./access.ts";
import { appEnv, type FakeFile, type GithubApi, type GithubRequest } from "./github.ts";
import { hub } from "./session.ts";

export const OWNER = "octo";
export const REPO = "skills";

export const POLISH_MD = [
  "---",
  "name: polish",
  "description: Polishes text.",
  "license: MIT",
  "allowed-tools: Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/check.py *) Read",
  "---",
  "# Polish",
  "",
].join("\n");

// The files of a commit holding the polish skill under dir (and a file outside it), with the given files added or
// replaced (paths under dir).
export function polishFiles(dir = "skills/polish", files: Record<string, FakeFile> = {}): Record<string, FakeFile> {
  const inside: Record<string, FakeFile> = {
    "SKILL.md": POLISH_MD,
    "references/style.md": "# Style\n",
    "scripts/check.py": { bytes: "print('ok')\n", mode: "100755" },
    ...files,
  };
  return {
    "README.md": "the repository\n",
    ...Object.fromEntries(Object.entries(inside).map(([path, file]) => [dir === "" ? path : `${dir}/${path}`, file])),
  };
}

// A call to /api with the host's token and the App configured; a JSON body when given.
export function send(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  { bound = withTimeout, app = true }: { bound?: CallBound; app?: boolean } = {},
): Promise<Response> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  return Promise.resolve(createApp(bound).fetch(request(path, token, init), app ? { ...env, ...appEnv() } : env));
}

// A refusal's status and body; an answer that is not one fails, naming its status.
export async function errorOf(response: Response): Promise<{ status: number; body: ErrorResponse }> {
  const body: unknown = response.status === 204 ? null : await response.json();
  if (!v.is(ErrorResponse, body)) {
    throw new Error(`expected a refusal, got ${response.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  return { status: response.status, body };
}

export function link(ref: string, path: string, repo = REPO): string {
  return `https://github.com/${OWNER}/${repo}/blob/${ref}/${path === "" ? "" : `${path}/`}SKILL.md`;
}

// A confirm's body.
export function confirmation(sha: string, options: { name?: string; path?: string; ref?: SkillRef } = {}) {
  return {
    name: options.name ?? "polish",
    source: { owner: OWNER, repo: REPO, path: options.path ?? "skills/polish" },
    ref: options.ref ?? { name: "main", kind: "branch" },
    sha,
  };
}

export function blobReads(api: GithubApi): GithubRequest[] {
  return api.requests.filter((served) => served.path.includes("/git/blobs/"));
}

export function refReads(api: GithubApi): GithubRequest[] {
  return api.requests.filter((served) => /\/matching-refs\/|\/commits\/refs\//.test(served.path));
}

// The rows the Hub stores for skills.
export async function storedRows(): Promise<{ skills: number; files: number }> {
  return runInDurableObject(await hub(), (_, state) => ({
    skills: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM prq_skills").one().n,
    files: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM prq_skill_files").one().n,
  }));
}

// The stored copy of a skill: its files by path, with each one's mode, size, blob SHA and bytes.
export async function storedFiles(name: string) {
  const bundle = await (await hub()).skillBundle(name);
  return bundle === null ? null : { skill: bundle.skill, files: bundle.files };
}

// A small skill stored through the Hub's own call, as a confirm stores one.
export function seedVersion(name: string): SkillVersion {
  const content = new TextEncoder().encode(`---\nname: ${name}\ndescription: d\n---\n`);
  return {
    name,
    description: "d",
    license: null,
    allowedTools: null,
    source: { owner: OWNER, repo: REPO, path: name },
    ref: { name: "main", kind: "branch" },
    sha: "1".repeat(40),
    files: [{ path: "SKILL.md", mode: "100644", size: content.byteLength, blob: "2".repeat(40), content }],
  };
}
