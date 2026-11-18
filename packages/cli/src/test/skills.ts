// A manual check of skills through the Worker (skills-check.ts): the real Worker in wrangler's local runtime with the
// GitHub App configured, registering public skills from real GitHub through /api/skills, the stored copy read back
// through the Hub's bundle read, and cloud turns with them. The check reads GitHub itself with the App (its own JWT and
// an installation token; skill-github.ts) for its oracle: the refs' commits, the skills' trees, SKILL.md's frontmatter
// and body, and a file. Steps:
// 1. G9: a link whose branch holds `/` previews with that branch as the ref and the rest as the path.
// 2. G1: the link to main's SKILL.md previews and registers with the tuple GitHub gives (repository, path, ref, SHA,
//    name, description), the settings list it, the stored files equal the tree at that SHA (paths, sizes, modes, blob
//    SHA-1 of the stored bytes), and the confirm read with the App's first active installation.
// 3. G2: cloud turns with yomiyasu and a second skill registered, the Worker's model scripted (skill-context.ts).
// 4. G7: updates by a new link, by a ref and by a permalink each pin exactly the previewed SHA with a new revision, an
//    apply with an old revision gets 409, a remove leaves no skill, and the next turn lists none and offers no tool.
// 5. G3, with a pull request argument: the smoke with the model of packages/server/.dev.vars (skill-smoke.ts).
// It prints what each step saw (never a token or the key) and passes when every step held.

import { Instructions, type PrRef, Skill, SkillPreview, SkillUpdatePreview } from "@prq/protocol";
import * as v from "valibot";

import type { GithubApp } from "./reconcile.ts";
import { SCRIPTED_MODEL, serveScripted } from "./scripted.ts";
import { checkAfterRemoval, checkContext, type Verdict } from "./skill-context.ts";
import { api, appGithub, type Github, type Manifest, sha1Blob, skillLink, YOMIYASU } from "./skill-github.ts";
import { checkSmoke } from "./skill-smoke.ts";
import { type GithubAppSettings, type ModelSettings, startWorker, type Worker } from "./worker.ts";

const API = "https://api.github.com";
const NAME = "yomiyasu";
const DIR = YOMIYASU.path;
const OWNER = YOMIYASU.owner;
const REPO = YOMIYASU.repo;
// A branch whose name holds `/`, and two tags.
const BRANCH = "pr/oga/v3.2.0";
const TAG = "v3.1.0";
const PERMALINK_TAG = "v3.2.0";

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

function link(ref: string): string {
  return skillLink(YOMIYASU, ref);
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
  const sha = await github.commitOf(YOMIYASU, `heads/${BRANCH}`);
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
    const before = await github.commitOf(YOMIYASU, "heads/main");
    const res = await api(worker, "POST", "/api/skills/preview", { url: link("main") });
    const after = await github.commitOf(YOMIYASU, "heads/main");
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
  const manifest = await github.manifestAt(YOMIYASU, preview.sha);
  const { sha, name, description } = manifest;
  const expected = {
    source: { owner: OWNER, repo: REPO, path: DIR },
    ref: { name: "main", kind: "branch" },
    sha,
    name,
    description,
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
  await checkStored(worker, await github.manifestAt(YOMIYASU, skill.sha), verdict);
  return skill;
}

// The model check of a run with a pull request argument (G3): the App's installation and the model it runs with.
export type SmokeSettings = { app: GithubApp; model: ModelSettings; pr: PrRef };

export async function checkSkills(
  app: GithubAppSettings,
  print: (line: string) => void,
  smoke: SmokeSettings | null,
): Promise<boolean> {
  let ok = true;
  const verdict: Verdict = (held, line) => {
    ok &&= held;
    print(`${held ? "ok  " : "FAIL"} ${line}`);
  };
  const direct = globalThis.fetch;
  const github = await appGithub(app, direct);
  print(`skills check: App ${app.GITHUB_APP_ID}, ${OWNER}/${REPO} ${DIR}`);
  const scripted = serveScripted();
  let worker: Worker;
  try {
    worker = await startWorker({ githubApp: app, model: SCRIPTED_MODEL });
  } catch (error) {
    scripted.stop();
    throw error;
  }
  const requests = countGithub();
  try {
    await previewSlashedBranch(worker, github, verdict);
    const registered = await register(worker, github, verdict);
    if (registered === null) {
      return false;
    }
    const context = await checkContext(worker, github, scripted, registered, print, verdict);
    if (context === null) {
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
        sha: await github.commitOf(YOMIYASU, `heads/${BRANCH}`),
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
        sha: await github.commitOf(YOMIYASU, `tags/${TAG}`),
      },
    );
    const pinned = await github.commitOf(YOMIYASU, `tags/${PERMALINK_TAG}`);
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
    await checkAfterRemoval(worker, scripted, context, print, verdict);
    print(`the Worker made ${requests.count()} requests to GitHub's API`);
  } finally {
    requests.stop();
    await worker.close();
    scripted.stop();
  }
  if (smoke !== null) {
    await checkSmoke(smoke, smoke.pr, print, verdict);
  }
  return ok;
}
