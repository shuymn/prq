import { Skill } from "@prq/protocol";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GITHUB_CALL_MS } from "./github.ts";
import { SKILL_FETCH_MS, SKILL_PREVIEW_MS } from "./instructions/fetch.ts";
import { captureLogs } from "./test/access.ts";
import { hostToken } from "./test/chat.ts";
import { type FakeRepository, type GithubApi, type GithubRequest, type Intercept, serveGithub } from "./test/github.ts";
import { latch } from "./test/latch.ts";
import { until } from "./test/provider.ts";
import { clearSkills, tracked } from "./test/session.ts";
import {
  blobReads,
  confirmation,
  errorOf,
  link,
  OWNER,
  POLISH_MD,
  polishFiles,
  REPO,
  send,
  storedFiles,
  storedRows,
} from "./test/skills.ts";

// The bounds and races of registering a skill (docs/design.md, Instructions and skills): each GitHub call, a preview
// and a confirm end within their bounds with every request in flight aborted, a body longer than its tree is cut at
// once, the first failed blob read stops the others, and the Hub's transaction decides between racing confirms.

let api: GithubApi;
let repo: FakeRepository;
let token: string;

beforeEach(async () => {
  captureLogs();
  token = await hostToken();
  api = serveGithub();
  api.install(OWNER, REPO, 5);
  repo = api.repository(OWNER, REPO);
  await clearSkills();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// A reply that never comes: the request fails only when its signal aborts it.
const hang: Intercept = (request) =>
  new Promise((_, reject) => {
    request.signal?.addEventListener("abort", () => reject(request.signal?.reason));
  });

// GitHub's answer after ms on the (fake) clock, or the abort of the request before it.
function slow(ms: number): Intercept {
  return async (request, serve) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      request.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(request.signal?.reason);
      });
    });
    return serve();
  };
}

// Advances the fake clock to `to` ms after the call started, in steps, letting the call's own work run between them.
async function advanceTo(to: number): Promise<void> {
  for (let at = 0; at < to;) {
    const step = Math.min(1000, to - at);
    await vi.advanceTimersByTimeAsync(step);
    at += step;
    await scheduler.wait(1);
  }
}

function isBlobOf(sha: string, path: string): (request: GithubRequest) => boolean {
  const blob = repo.blobOf(sha, path);
  return (request) => request.path.endsWith(`/git/blobs/${blob}`);
}

describe("the bounds", () => {
  it("ends a GitHub call at GITHUB_CALL_MS, not a tick before, aborting it: the preview answers 503", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    repo.heads.set("main", await repo.commit(polishFiles()));
    api.intercept((request) => request.path.includes("/matching-refs/heads/"), hang);

    const res = tracked(send(token, "POST", "/api/skills/preview", { url: link("main", "skills/polish") }));
    await until(() => api.requests.some((request) => request.path.includes("/matching-refs/heads/")), "the ref read");
    await vi.advanceTimersByTimeAsync(GITHUB_CALL_MS - 1);
    expect(res.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => res.settled(), "the preview's answer");
    expect(await errorOf(await res.promise)).toEqual({
      status: 503,
      body: { error: "unavailable", detail: "GitHub could not answer the branches (no answer); try again" },
    });
    expect(api.requests.find((request) => request.path.includes("/matching-refs/heads/"))?.signal?.aborted).toBe(true);
  });

  it("ends a preview at SKILL_PREVIEW_MS though each call answers within its bound, aborting the one in flight", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    repo.heads.set("main", await repo.commit(polishFiles()));
    api.intercept(() => true, slow(GITHUB_CALL_MS - 100));

    const res = tracked(send(token, "POST", "/api/skills/preview", { url: link("main", "skills/polish") }));
    await until(() => api.requests.length > 0, "the first request");
    await advanceTo(SKILL_PREVIEW_MS - 1);
    expect(res.settled()).toBe(false);
    const inFlight = api.requests.at(-1);
    expect(inFlight?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => res.settled(), "the preview's answer");
    expect(await errorOf(await res.promise)).toEqual({
      status: 503,
      body: { error: "unavailable", detail: "GitHub did not answer within 30 s; try again" },
    });
    expect(inFlight?.signal?.aborted).toBe(true);
  });

  it("ends a confirm at SKILL_FETCH_MS, aborting the reads in flight; a queued read never starts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const extra = Object.fromEntries(
      Array.from({ length: 41 }, (_, index) => [`references/${index}.md`, `${index}\n`]),
    );
    const sha = await repo.commit(polishFiles("skills/polish", extra));
    const skillMd = isBlobOf(sha, "skills/polish/SKILL.md");
    api.intercept((request) => request.path.includes("/git/blobs/") && !skillMd(request), slow(GITHUB_CALL_MS - 100));

    const res = tracked(send(token, "POST", "/api/skills", confirmation(sha)));
    await until(() => api.requests.length > 0, "the first request");
    await advanceTo(SKILL_FETCH_MS - 1);
    expect(res.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => res.settled(), "the confirm's answer");
    expect(await errorOf(await res.promise)).toEqual({
      status: 503,
      body: { error: "unavailable", detail: "GitHub did not answer within 60 s; try again" },
    });
    const requested = blobReads(api).length;
    await scheduler.wait(50);
    expect(blobReads(api)).toHaveLength(requested);
    // SKILL.md and 43 more: at six at a time and 9.9 s each, some were still queued at the bound.
    expect(requested).toBeLessThan(44);
    expect(blobReads(api).every((request) => request.signal?.aborted === true)).toBe(true);
    expect(await storedRows()).toEqual({ skills: 0, files: 0 });
  });

  it("stops at the first failed blob read: the reads in flight are aborted and a queued one never starts", async () => {
    const extra = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`references/${index}.md`, `${index}\n`]));
    const sha = await repo.commit(polishFiles("skills/polish", extra));
    // Six read at once: references/0.md to 4.md and references/style.md; scripts/check.py waits for a slot.
    const failing = isBlobOf(sha, "skills/polish/references/0.md");
    const queued = isBlobOf(sha, "skills/polish/scripts/check.py");
    const skillMd = isBlobOf(sha, "skills/polish/SKILL.md");
    const allInFlight = latch();
    api.intercept(failing, async () => {
      await allInFlight.promise;
      return Response.json({ message: "Server Error" }, { status: 500 });
    });
    api.intercept((request) => request.path.includes("/git/blobs/") && !skillMd(request), hang);

    const res = tracked(send(token, "POST", "/api/skills", confirmation(sha)));
    await until(() => blobReads(api).length === 7, "SKILL.md and six reads in flight");
    allInFlight.open();
    await until(() => res.settled(), "the confirm's answer");
    expect(await errorOf(await res.promise)).toEqual({
      status: 503,
      body: { error: "unavailable", detail: "GitHub could not answer the blob of references/0.md (500); try again" },
    });
    await scheduler.wait(50);
    expect(blobReads(api).filter(queued)).toEqual([]);
    expect(blobReads(api).every((request) => request.signal?.aborted === true)).toBe(true);
    expect(await storedRows()).toEqual({ skills: 0, files: 0 });
  });

  it("leaves a token mint to its own bound: the preview's end does not abort it, GITHUB_CALL_MS after it began does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // The App is not installed on this repository: its lookup and the App's list each answer after 9.6 s, and each
    // signing of the App's JWT takes 1 s, so the token request starts after 20 s and never answers.
    const unlisted = api.repository(OWNER, "unlisted");
    unlisted.heads.set("main", await unlisted.commit(polishFiles()));
    api.installations([{ id: 7 }]);
    api.intercept(
      (request) => request.path.endsWith("/installation") || request.path === "/app/installations",
      slow(9600),
    );
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    let signings = 0;
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      signings += 1;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return sign(...args);
    });
    // The token request: when it began and when its signal was aborted, on the fake clock.
    const mint: { signal?: AbortSignal; at?: number; abortedAt?: number } = {};
    api.tokenReply(
      (signal) =>
        new Promise((_, reject) => {
          Object.assign(mint, { signal, at: Date.now() });
          signal?.addEventListener("abort", () => {
            mint.abortedAt = Date.now();
            reject(signal.reason);
          });
        }),
    );

    const start = Date.now();
    const res = tracked(send(token, "POST", "/api/skills/preview", { url: link("main", "skills/polish", "unlisted") }));
    await until(() => signings > 0, "the App's first JWT");
    await advanceTo(SKILL_PREVIEW_MS - 1);
    expect(res.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => res.settled(), "the preview's answer");
    expect(await errorOf(await res.promise)).toEqual({
      status: 503,
      body: { error: "unavailable", detail: "GitHub did not answer within 30 s; try again" },
    });
    // The mint began after 20 s and outlives the preview, which does not abort it; its own bound ends it.
    expect((mint.at ?? 0) - start).toBeGreaterThan(20_000);
    expect(mint.signal?.aborted).toBe(false);
    await advanceTo(GITHUB_CALL_MS);
    expect(mint.signal?.aborted).toBe(true);
    expect((mint.abortedAt ?? 0) - (mint.at ?? 0)).toBe(GITHUB_CALL_MS);
  });

  it("cuts a blob that streams past its tree's size at once, without waiting for the bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sha = await repo.commit(polishFiles());
    let read: GithubRequest | undefined;
    // references/style.md is 8 bytes: its body sends 9 and stays open.
    api.intercept(isBlobOf(sha, "skills/polish/references/style.md"), async (request) => {
      read = request;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("# Style\n!"));
          request.signal?.addEventListener("abort", () => controller.error(request.signal?.reason));
        },
      });
      return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
    });

    const res = tracked(send(token, "POST", "/api/skills", confirmation(sha)));
    await until(() => res.settled(), "the confirm's answer");
    expect(await errorOf(await res.promise)).toEqual({
      status: 422,
      body: {
        error: "invalid_skill",
        detail: "the blob of references/style.md is longer than its tree says (8 bytes)",
      },
    });
    expect(read?.signal?.aborted).toBe(true);
    expect(await storedRows()).toEqual({ skills: 0, files: 0 });
  });
});

describe("the races", () => {
  it("stores one of two confirms of one name, held across their reads, and answers the other 409", async () => {
    const sha = await repo.commit(polishFiles());
    const release = latch();
    let held = 0;
    api.intercept(
      isBlobOf(sha, "skills/polish/SKILL.md"),
      async (_, serve) => {
        held += 1;
        await release.promise;
        return serve();
      },
      2,
    );

    const first = send(token, "POST", "/api/skills", confirmation(sha));
    const second = send(token, "POST", "/api/skills", confirmation(sha));
    await until(() => held === 2, "both confirms' reads");
    release.open();
    const answers = await Promise.all([first, second]);
    expect(answers.map((res) => res.status).toSorted((a, b) => a - b)).toEqual([201, 409]);
    const refused = answers.find((res) => res.status === 409);
    expect(refused && (await errorOf(refused)).body).toEqual({
      error: "skill_exists",
      detail: "a skill named polish is registered already",
    });
    expect(await storedRows()).toEqual({ skills: 1, files: 3 });
  });

  it("refuses an update held across a remove and a register again of the name, leaving the new registration", async () => {
    const a = await repo.commit({ ...polishFiles(), ...polishFiles("other/polish", { "references/other.md": "o\n" }) });
    const b = await repo.commit(polishFiles("skills/polish", { "SKILL.md": POLISH_MD.replace("Polishes", "Shines") }));
    const registered = v.parse(Skill, await (await send(token, "POST", "/api/skills", confirmation(a))).json());
    const release = latch();
    let held = false;
    api.intercept(isBlobOf(b, "skills/polish/SKILL.md"), async (_, serve) => {
      held = true;
      await release.promise;
      return serve();
    });

    const update = send(token, "PUT", "/api/skills/polish", {
      ...confirmation(b, { ref: { name: b, kind: "commit" } }),
      expectedRev: registered.rev,
    });
    await until(() => held, "the update's read");
    expect((await send(token, "DELETE", "/api/skills/polish")).status).toBe(204);
    const again = await send(token, "POST", "/api/skills", confirmation(a, { path: "other/polish" }));
    expect(again.status).toBe(201);
    const reregistered = v.parse(Skill, await again.json());
    release.open();

    expect(await errorOf(await update)).toEqual({
      status: 409,
      body: {
        error: "skill_changed",
        detail: "the skill polish was updated or removed since the preview; preview it again",
      },
    });
    const stored = await storedFiles("polish");
    expect(stored?.skill).toEqual(reregistered);
    expect(stored?.skill.source.path).toBe("other/polish");
    expect(stored?.files.map((file) => file.path)).toContain("references/other.md");
    expect(stored?.files.every((file) => file.blob === repo.blobOf(a, `other/polish/${file.path}`))).toBe(true);
  });

  it("answers skill_changed to an update whose read fails after a remove and a register again of the name", async () => {
    const a = await repo.commit({ ...polishFiles(), ...polishFiles("other/polish", { "references/other.md": "o\n" }) });
    const b = await repo.commit(polishFiles("skills/polish", { "SKILL.md": POLISH_MD.replace("Polishes", "Shines") }));
    const registered = v.parse(Skill, await (await send(token, "POST", "/api/skills", confirmation(a))).json());
    const release = latch();
    let held = false;
    api.intercept(isBlobOf(b, "skills/polish/SKILL.md"), async () => {
      held = true;
      await release.promise;
      return Response.json({ message: "Service Unavailable" }, { status: 503 });
    });

    const update = send(token, "PUT", "/api/skills/polish", {
      ...confirmation(b, { ref: { name: b, kind: "commit" } }),
      expectedRev: registered.rev,
    });
    await until(() => held, "the update's read");
    expect((await send(token, "DELETE", "/api/skills/polish")).status).toBe(204);
    const again = await send(token, "POST", "/api/skills", confirmation(a, { path: "other/polish" }));
    const reregistered = v.parse(Skill, await again.json());
    release.open();

    expect(await errorOf(await update)).toEqual({
      status: 409,
      body: {
        error: "skill_changed",
        detail: "the skill polish was updated or removed since the preview; preview it again",
      },
    });
    expect((await storedFiles("polish"))?.skill).toEqual(reregistered);
  });
});
