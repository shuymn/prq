// A manual check of skill registration through the Worker (skills-check.ts): the real Worker in wrangler's local
// runtime with the GitHub App configured, registering a public skill from real GitHub through /api/skills, and the
// stored copy read back through the Hub's bundle read. The check reads GitHub itself with the App (its own JWT and an
// installation token) for its oracle: the refs' commits, the skill's tree and SKILL.md's frontmatter. Steps:
// 1. G9: a link whose branch holds `/` previews with that branch as the ref and the rest as the path.
// 2. G1: the link to main's SKILL.md previews and registers with the tuple GitHub gives (repository, path, ref, SHA,
//    name, description), the settings list it, the stored files equal the tree at that SHA (paths, sizes, modes, blob
//    SHA-1 of the stored bytes), and the confirm read with the App's first active installation.
// 3. G7: updates by a new link, by a ref and by a permalink each pin exactly the previewed SHA with a new revision, an
//    apply with an old revision gets 409, and a remove leaves no skill.
// It prints what each step saw (never a token or the key) and passes when every step held.

import { createHash } from "node:crypto";

import { Instructions, Skill, SkillPreview, SkillUpdatePreview } from "@prq/protocol";
import { importPKCS8, SignJWT } from "jose";
import * as v from "valibot";
import { parse } from "yaml";

import { type GithubAppSettings, startWorker, type Worker } from "./worker.ts";

const API = "https://api.github.com";
const OWNER = "nanaism";
const REPO = "yomiyasu";
const DIR = "skills/yomiyasu";
const NAME = "yomiyasu";
// A branch whose name holds `/`, and two tags.
const BRANCH = "pr/oga/v3.2.0";
const TAG = "v3.1.0";
const PERMALINK_TAG = "v3.2.0";

const Installations = v.array(v.object({ id: v.number(), suspended_at: v.nullish(v.string()) }));
const Token = v.object({ token: v.string() });
const Tree = v.object({
  truncated: v.boolean(),
  tree: v.array(
    v.object({ path: v.string(), mode: v.string(), type: v.string(), sha: v.string(), size: v.optional(v.number()) }),
  ),
});
const Bundle = v.object({
  skill: Skill,
  files: v.array(
    v.object({
      path: v.string(),
      mode: v.string(),
      size: v.number(),
      blob: v.string(),
      content: v.instance(Uint8Array),
    }),
  ),
});
const Frontmatter = v.object({ name: v.string(), description: v.string() });

type ManifestFile = { path: string; mode: string; size: number; blob: string };
type Manifest = { sha: string; name: string; description: string; files: ManifestFile[] };

function sha1Blob(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// GitHub read as the App: the first active installation of its list, and reads with that installation's token, through
// the fetch from before the Worker's harness wrapped it.
async function appGithub(app: GithubAppSettings, direct: typeof fetch) {
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
  return {
    installation: installation.id,
    installations: listed.length,
    // The commit a branch (heads/<name>) or tag (tags/<name>) names now, a tag peeled.
    commitOf: async (ref: string) =>
      (
        await (
          await read(`/repos/${OWNER}/${REPO}/commits/refs/${encodedPath(ref)}`, "application/vnd.github.sha")
        ).text()
      ).trim(),
    // The skill's regular files at the commit, and SKILL.md's name and description, read and parsed here.
    manifestAt: async (sha: string): Promise<Manifest> => {
      const tree = v.parse(
        Tree,
        await (
          await read(
            `/repos/${OWNER}/${REPO}/git/trees/${sha}:${encodedPath(DIR)}?recursive=1`,
            "application/vnd.github+json",
          )
        ).json(),
      );
      if (tree.truncated) {
        throw new Error(`GitHub cut the tree at ${sha} short`);
      }
      const files = tree.tree
        .filter((entry) => entry.type === "blob")
        .map(({ path, mode, sha: blob, size }) => ({ path, mode, size: size ?? -1, blob }))
        .toSorted((a, b) => (a.path < b.path ? -1 : 1));
      const skillMd = files.find((file) => file.path === "SKILL.md");
      if (skillMd === undefined) {
        throw new Error(`no SKILL.md in ${DIR} at ${sha}`);
      }
      const bytes = new Uint8Array(
        await (
          await read(`/repos/${OWNER}/${REPO}/git/blobs/${skillMd.blob}`, "application/vnd.github.raw")
        ).arrayBuffer(),
      );
      if (sha1Blob(bytes) !== skillMd.blob) {
        throw new Error("SKILL.md's bytes do not match its blob");
      }
      const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
      const end = lines.indexOf("---", 1);
      const { name, description } = v.parse(Frontmatter, parse(lines.slice(1, end).join("\n")));
      return { sha, name, description, files };
    },
  };
}

type Github = Awaited<ReturnType<typeof appGithub>>;

// A call to the Worker's /api with the host's Access token: its status and JSON body (null for none).
async function api(worker: Worker, method: string, path: string, body?: unknown) {
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

function link(ref: string): string {
  return `https://github.com/${OWNER}/${REPO}/blob/${ref}/${DIR}/SKILL.md`;
}

// The Worker's requests to GitHub's API, counted where the harness hands them to this process's fetch.
function countGithub(): { count: () => number; stop: () => void } {
  let count = 0;
  const passThrough = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin === API) {
      count += 1;
    }
    return passThrough(input, init);
  };
  return {
    count: () => count,
    stop: () => {
      globalThis.fetch = passThrough;
    },
  };
}

type Verdict = (ok: boolean, line: string) => void;

// The stored copy against the manifest: the same paths, modes and sizes, and each stored file's bytes hashing to its
// tree blob.
async function checkStored(worker: Worker, manifest: Manifest, verdict: Verdict): Promise<void> {
  const hub = await worker.durableObject("Hub", "hub");
  const bundle = v.parse(Bundle, await hub["skillBundle"]?.(NAME));
  const stored = bundle.files.map(({ path, mode, size }) => ({ path, mode, size }));
  const expected = manifest.files.map(({ path, mode, size }) => ({ path, mode, size }));
  const mismatched = bundle.files.filter((file) => {
    const tree = manifest.files.find((entry) => entry.path === file.path);
    return tree === undefined || sha1Blob(file.content) !== tree.blob || file.blob !== tree.blob;
  });
  const bytes = bundle.files.reduce((sum, file) => sum + file.content.byteLength, 0);
  verdict(
    bundle.skill.sha === manifest.sha && JSON.stringify(stored) === JSON.stringify(expected) && mismatched.length === 0,
    `stored at ${manifest.sha.slice(0, 7)}: ${bundle.files.length} files, ${bytes} bytes; GitHub's tree: ${manifest.files.length} files; ` +
      `paths, modes and sizes ${JSON.stringify(stored) === JSON.stringify(expected) ? "equal" : "differ"}; ` +
      `blob SHA-1 of the stored bytes ${mismatched.length === 0 ? "equal to the tree's" : `differ for ${mismatched.map((f) => f.path).join(", ")}`}`,
  );
}

function tuple(skill: { source: unknown; ref: unknown; sha: string; name: string; description: string }) {
  return JSON.stringify([skill.source, skill.ref, skill.sha, skill.name, skill.description]);
}

// G9: the branch holding `/` is the ref, the rest the path.
async function previewSlashedBranch(worker: Worker, github: Github, verdict: Verdict): Promise<void> {
  const sha = await github.commitOf(`heads/${BRANCH}`);
  const res = await api(worker, "POST", "/api/skills/preview", { url: link(BRANCH) });
  if (res.status !== 200) {
    verdict(false, `G9: the preview answered ${res.status} ${JSON.stringify(res.body)}`);
    return;
  }
  const preview = v.parse(SkillPreview, res.body);
  verdict(
    preview.ref.name === BRANCH && preview.ref.kind === "branch" && preview.source.path === DIR && preview.sha === sha,
    `G9: ${link(BRANCH)} → ref ${JSON.stringify(preview.ref)}, path ${preview.source.path}, ${preview.sha.slice(0, 7)} ` +
      `(GitHub's ${BRANCH}: ${sha.slice(0, 7)})`,
  );
}

// G1: register main's skill and compare it with GitHub's tuple and tree.
async function register(worker: Worker, github: Github, verdict: Verdict): Promise<Skill | null> {
  let preview: SkillPreview | null = null;
  for (let attempt = 1; attempt <= 3 && preview === null; attempt += 1) {
    const before = await github.commitOf("heads/main");
    const res = await api(worker, "POST", "/api/skills/preview", { url: link("main") });
    const after = await github.commitOf("heads/main");
    if (res.status !== 200) {
      verdict(false, `G1: the preview answered ${res.status} ${JSON.stringify(res.body)}`);
      return null;
    }
    const shown = v.parse(SkillPreview, res.body);
    if (before === after && shown.sha === before) {
      preview = shown;
    } else {
      verdict(true, `G1: main moved during the check (${before.slice(0, 7)} → ${after.slice(0, 7)}); again`);
    }
  }
  if (preview === null) {
    return null;
  }
  const manifest = await github.manifestAt(preview.sha);
  const expected = {
    source: { owner: OWNER, repo: REPO, path: DIR },
    ref: { name: "main", kind: "branch" },
    ...manifest,
  };
  verdict(
    tuple(preview) === tuple(expected),
    `G1 preview: ${OWNER}/${REPO} ${preview.source.path} ${JSON.stringify(preview.ref)} ${preview.sha.slice(0, 7)} ` +
      `name ${preview.name}, description of ${preview.description.length} characters, ${preview.files.length} files, ` +
      `${preview.allowedTools?.length ?? 0} allowed-tools entries; GitHub's tuple ${tuple(preview) === tuple(expected) ? "equal" : "differs"}`,
  );
  const from = worker.logs().length;
  const res = await api(worker, "POST", "/api/skills", {
    name: preview.name,
    source: preview.source,
    ref: preview.ref,
    sha: preview.sha,
  });
  if (res.status !== 201) {
    verdict(false, `G1: the confirm answered ${res.status} ${JSON.stringify(res.body)}`);
    return null;
  }
  const skill = v.parse(Skill, res.body);
  const listed = v.parse(Instructions, (await api(worker, "GET", "/api/instructions")).body).skills;
  verdict(
    listed.length === 1 &&
      listed[0] !== undefined &&
      tuple(listed[0]) === tuple(expected) &&
      listed[0].rev === skill.rev,
    `G1 confirm: 201, rev ${skill.rev}; GET /api/instructions lists ${listed.map((entry) => `${entry.name}@${entry.sha.slice(0, 7)}`).join(", ")}, ` +
      `tuple ${listed[0] !== undefined && tuple(listed[0]) === tuple(expected) ? "equal" : "differs"}`,
  );
  await checkStored(worker, manifest, verdict);
  const fetched = worker
    .logs()
    .slice(from)
    .find((line) => line.includes("prq.skill.fetched") && line.includes("confirm"));
  const installation = /installationId: (\d+)/.exec(fetched ?? "")?.[1];
  verdict(
    installation === String(github.installation),
    `G1 installation: the confirm read with installation ${installation ?? "(no prq.skill.fetched line)"}; ` +
      `the App's first active installation of ${github.installations} is ${github.installation}`,
  );
  return skill;
}

// G7: one update by its preview's target, applied with the previewed revision.
async function update(
  worker: Worker,
  github: Github,
  verdict: Verdict,
  label: string,
  target: { url: string } | { ref: string },
  expected: { ref: { name: string; kind: string }; sha: string },
): Promise<Skill | null> {
  const res = await api(worker, "POST", `/api/skills/${NAME}/preview`, target);
  if (res.status !== 200) {
    verdict(false, `G7 ${label}: the preview answered ${res.status} ${JSON.stringify(res.body)}`);
    return null;
  }
  const preview = v.parse(SkillUpdatePreview, res.body);
  verdict(
    preview.sha === expected.sha &&
      JSON.stringify(preview.ref) === JSON.stringify(expected.ref) &&
      preview.source.path === DIR,
    `G7 ${label} preview: current ${JSON.stringify(preview.current.ref)} ${preview.current.sha.slice(0, 7)} rev ${preview.current.rev} → ` +
      `new ${JSON.stringify(preview.ref)} ${preview.sha.slice(0, 7)} (GitHub's: ${expected.sha.slice(0, 7)})`,
  );
  const applied = await api(worker, "PUT", `/api/skills/${NAME}`, {
    name: preview.name,
    source: preview.source,
    ref: preview.ref,
    sha: preview.sha,
    expectedRev: preview.current.rev,
  });
  if (applied.status !== 200) {
    verdict(false, `G7 ${label}: the apply answered ${applied.status} ${JSON.stringify(applied.body)}`);
    return null;
  }
  const skill = v.parse(Skill, applied.body);
  verdict(
    skill.sha === preview.sha && skill.rev > preview.current.rev,
    `G7 ${label} apply: 200, ${skill.sha.slice(0, 7)} rev ${preview.current.rev} → ${skill.rev}`,
  );
  await checkStored(worker, await github.manifestAt(skill.sha), verdict);
  return skill;
}

export async function checkSkills(app: GithubAppSettings, print: (line: string) => void): Promise<boolean> {
  let ok = true;
  const verdict: Verdict = (held, line) => {
    ok &&= held;
    print(`${held ? "ok  " : "FAIL"} ${line}`);
  };
  const direct = globalThis.fetch;
  const github = await appGithub(app, direct);
  print(`skills check: App ${app.GITHUB_APP_ID}, ${OWNER}/${REPO} ${DIR}`);
  const worker = await startWorker({ githubApp: app });
  const requests = countGithub();
  try {
    await previewSlashedBranch(worker, github, verdict);
    const registered = await register(worker, github, verdict);
    if (registered === null) {
      return false;
    }
    const byLink = await update(
      worker,
      github,
      verdict,
      "by link",
      { url: link(BRANCH) },
      {
        ref: { name: BRANCH, kind: "branch" },
        sha: await github.commitOf(`heads/${BRANCH}`),
      },
    );
    const stale = await api(worker, "PUT", `/api/skills/${NAME}`, {
      name: NAME,
      source: registered.source,
      ref: registered.ref,
      sha: registered.sha,
      expectedRev: registered.rev,
    });
    verdict(
      v.is(v.object({ error: v.literal("skill_changed") }), stale.body) && stale.status === 409,
      `G7 an apply with the old rev ${registered.rev}: ${stale.status} ${JSON.stringify(stale.body)}`,
    );
    const byRef = await update(
      worker,
      github,
      verdict,
      "by ref",
      { ref: TAG },
      {
        ref: { name: TAG, kind: "tag" },
        sha: await github.commitOf(`tags/${TAG}`),
      },
    );
    const pinned = await github.commitOf(`tags/${PERMALINK_TAG}`);
    const byPermalink = await update(
      worker,
      github,
      verdict,
      "by permalink",
      { url: link(pinned) },
      {
        ref: { name: pinned, kind: "commit" },
        sha: pinned,
      },
    );
    if (byLink === null || byRef === null || byPermalink === null) {
      return false;
    }
    const removed = await api(worker, "DELETE", `/api/skills/${NAME}`);
    const listed = v.parse(Instructions, (await api(worker, "GET", "/api/instructions")).body).skills;
    const hub = await worker.durableObject("Hub", "hub");
    const bundle = await hub["skillBundle"]?.(NAME);
    verdict(
      removed.status === 204 && listed.length === 0 && bundle === null,
      `G7 remove: ${removed.status}; GET /api/instructions lists ${listed.length} skills; the Hub holds ${bundle === null ? "no copy" : "a copy"}`,
    );
    print(`the Worker made ${requests.count()} requests to GitHub's API`);
    return ok;
  } finally {
    requests.stop();
    await worker.close();
  }
}
