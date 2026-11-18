// prq context with the host's skills, run with its real client against scripted answers on a clock that moves only
// when it sleeps: each skill's files are read from /cli/skill and checked before any is written, and a run that fails
// leaves the published set and context.json as the run before left them.

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContextSkill, Job, SkillFilesResponse } from "@prq/protocol";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client, VersionNotice } from "../client.ts";
import { CliError } from "../errors.ts";
import { type Clock, RETRY_WINDOW_MS } from "../retry.ts";
import { blobSha } from "../skills.ts";
import { State } from "../state.ts";
import { context } from "./context.ts";

const AGENT_ID = "laptop";
const job: Job = {
  jobId: randomUUID(),
  pr: { owner: "acme", repo: "widgets", number: 7 },
  run: 1,
  target: { kind: "analysis", headSha: "1".repeat(40) },
  workspaceSha: null,
};

// A route's answer, given takesMs after the request on the test's clock.
type Reply = { status: number; body: unknown; takesMs?: number };

const Saved = v.looseObject({ instructions: v.looseObject({ dir: v.string() }) });
const Printed = v.looseObject({ skills: v.array(v.looseObject({ path: v.string() })) });

let home: string;
let now: number;
let requests: { at: number; route: string; body: unknown }[];

const clock: Clock = {
  now: () => now,
  sleep: async (ms) => {
    now += ms;
  },
};

// Answers each route's requests with its replies in order.
function serve(replies: Record<string, Reply[]>): void {
  vi.stubGlobal("fetch", async (input: URL, init: RequestInit) => {
    const route = input.pathname;
    requests.push({ at: now, route, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    const reply = replies[route]?.shift();
    if (reply === undefined) {
      throw new Error(`no reply left for ${route}`);
    }
    now += reply.takesMs ?? 0;
    return Response.json(reply.body, { status: reply.status });
  });
}

function client(): Client {
  const config = {
    url: "http://127.0.0.1:1",
    clientId: "id",
    clientSecret: "secret",
    agentId: AGENT_ID,
    versionNotice: false,
    home,
  };
  return new Client(config, new VersionNotice("v0.0.0", false, () => {}), () => {}, clock);
}

function polish(rev: number): ContextSkill {
  return { name: "polish", description: "Polishes text.", rev, sha: String(rev).repeat(40) };
}

// The context's one page, listing the skills.
function contextPage(skills: ContextSkill[]): Reply {
  const instructions = {
    prompts: { analysis: { text: "Summarize.", savedAt: 1 }, answer: { text: "", savedAt: null } },
    skills,
  };
  return { status: 200, body: { pr: job.pr, details: null, job, instructions, messages: [], nextCursor: null } };
}

type Entry = SkillFilesResponse["files"][number];

function entry(path: string, text: string): Entry {
  const bytes = Buffer.from(text);
  return { path, mode: "100644", size: bytes.byteLength, blob: blobSha(bytes), content: bytes.toString("base64") };
}

function skillPage(files: Entry[], nextCursor: string | null = null): Reply {
  return { status: 200, body: { files, nextCursor } };
}

const UNAVAILABLE: Reply = { status: 503, body: { error: "unavailable" } };

async function run(): Promise<{ printed: object[]; error: unknown }> {
  const state = new State(home, AGENT_ID);
  const printed: object[] = [];
  const error: unknown = await context(client(), state, AGENT_ID, (result) => printed.push(result)).then(
    () => null,
    (failure: unknown) => failure,
  );
  return { printed, error };
}

// What a failed run must leave: context.json and the sets as the run before published them.
async function snapshot(dir: string) {
  return { context: await readFile(join(dir, "context.json"), "utf8"), sets: await readdir(join(dir, "instructions")) };
}

let dir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "prq-context-skills-"));
  now = 0;
  requests = [];
  const state = new State(home, AGENT_ID);
  await state.saveRecord({ job, claimId: randomUUID(), resumed: false });
  dir = state.jobDir(job);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(home, { recursive: true, force: true });
});

// A first run that publishes polish at revision 1, from two pages.
async function published() {
  serve({
    "/cli/context": [contextPage([polish(1)])],
    "/cli/skill": [skillPage([entry("SKILL.md", "v1")], "notes.md"), skillPage([entry("notes.md", "notes v1")])],
  });
  const { printed, error } = await run();
  expect(error).toBeNull();
  return { printed, before: await snapshot(dir) };
}

describe("prq context with skills", () => {
  it("reads each skill page by page at the listed revision and prints where its files are", async () => {
    const { printed } = await published();

    expect(requests.filter((request) => request.route === "/cli/skill").map((request) => request.body)).toEqual([
      { name: "polish", rev: 1 },
      { name: "polish", rev: 1, cursor: "notes.md" },
    ]);
    const saved = v.parse(Saved, JSON.parse(await readFile(join(dir, "context.json"), "utf8")));
    const path = join(saved.instructions.dir, "skills", "polish");
    expect(printed).toEqual([
      expect.objectContaining({ skills: [{ name: "polish", description: "Polishes text.", path }] }),
    ]);
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("v1");
    expect(await readFile(join(path, "notes.md"), "utf8")).toBe("notes v1");
  });

  it("a wrong byte: exit 1, and context.json and the sets as the run before left them", async () => {
    const { before } = await published();
    const wrong = { ...entry("SKILL.md", "v2"), content: Buffer.from("v3").toString("base64") };
    serve({ "/cli/context": [contextPage([polish(2)])], "/cli/skill": [skillPage([wrong])] });

    const { printed, error } = await run();

    expect(error).toEqual(
      new CliError(1, `the skill polish is refused: the bytes of "SKILL.md" are not its blob ${wrong.blob}`),
    );
    expect(printed).toEqual([]);
    expect(await snapshot(dir)).toEqual(before);
  });

  it("paths differing only in case: exit 1 naming them, nothing of the skill written", async () => {
    const { before } = await published();
    serve({
      "/cli/context": [contextPage([polish(2)])],
      "/cli/skill": [skillPage([entry("README.md", "a"), entry("Readme.md", "b")])],
    });

    const { error } = await run();

    expect(error).toEqual(
      new CliError(
        1,
        'the skill polish is refused: the paths "README.md" and "Readme.md" differ only in the case of "Readme.md"',
      ),
    );
    expect(await snapshot(dir)).toEqual(before);
  });

  it("a skill updated between its pages: exit 1, the published set kept; a rerun publishes the new revision", async () => {
    const { before } = await published();
    serve({
      "/cli/context": [contextPage([polish(2)]), contextPage([polish(3)])],
      "/cli/skill": [
        skillPage([entry("SKILL.md", "v2")], "notes.md"),
        { status: 409, body: { error: "skill_changed", detail: "the skill polish was updated or removed" } },
        skillPage([entry("SKILL.md", "v3")]),
      ],
    });

    const failed = await run();
    expect(failed.error).toEqual(
      new CliError(1, "the skill polish was updated or removed while prq context read it; run prq context again"),
    );
    expect(await snapshot(dir)).toEqual(before);

    const rerun = await run();
    expect(rerun.error).toBeNull();
    const [skill] = v.parse(Printed, rerun.printed[0]).skills;
    expect(await readFile(join(skill?.path ?? "", "SKILL.md"), "utf8")).toBe("v3");
    expect(await stat(join(skill?.path ?? "", "notes.md")).catch(() => null)).toBeNull();
  });

  it("a later skill page unavailable past the command's retry window: exit 1, no set left", async () => {
    const { before } = await published();
    // The calls before the unavailable page take 40 s, so a window of that page's own would outlast the command's.
    serve({
      "/cli/context": [{ ...contextPage([polish(2)]), takesMs: 20_000 }],
      "/cli/skill": [
        { ...skillPage([entry("SKILL.md", "v2")], "notes.md"), takesMs: 20_000 },
        ...Array.from({ length: 16 }, () => UNAVAILABLE),
      ],
    });
    requests = [];

    const { error } = await run();

    expect(error).toEqual(new CliError(1, "the server is unavailable (HTTP 503); try again"));
    // Every attempt, the context's and each page's, started within the one window the command opened.
    expect(Math.max(...requests.map((request) => request.at))).toBeLessThanOrEqual(RETRY_WINDOW_MS);
    expect(requests.filter((request) => request.route === "/cli/skill").length).toBeGreaterThan(2);
    expect(await snapshot(dir)).toEqual(before);
  });
});
