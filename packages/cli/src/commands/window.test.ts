// One retry window per command (docs/design.md, Local CLI): the commands that make several requests, run with their
// real client against scripted answers on a clock that moves only when they sleep.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Job } from "@prq/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client, VersionNotice } from "../client.ts";
import { CliError } from "../errors.ts";
import { type Clock, RETRY_WINDOW_MS } from "../retry.ts";
import { State } from "../state.ts";
import { context } from "./context.ts";
import { submit } from "./submit.ts";

const AGENT_ID = "laptop";
const job: Job = {
  jobId: randomUUID(),
  pr: { owner: "acme", repo: "widgets", number: 7 },
  run: 1,
  target: { kind: "analysis", headSha: "1".repeat(40) },
  workspaceSha: "1".repeat(40),
};

// Six 503s, each answered at once: a request that gets them takes 45 s of backoff before its next attempt.
const UNAVAILABLE = Array.from({ length: 6 }, () => ({ status: 503, body: { error: "unavailable" } }));

// A reply, and how long the request takes before it (none by default).
type Reply = { status: number; body: unknown; takesMs?: number };

let home: string;
let now: number;
// The start time and route of every request the command made.
let requests: { at: number; route: string }[];

const clock: Clock = {
  now: () => now,
  sleep: async (ms) => {
    now += ms;
  },
};

// Answers each route's requests with its replies in order.
function serve(replies: Record<string, Reply[]>): void {
  vi.stubGlobal("fetch", async (input: URL) => {
    const route = input.pathname;
    requests.push({ at: now, route });
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

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "prq-window-"));
  now = 0;
  requests = [];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(home, { recursive: true, force: true });
});

describe("one retry window per command", () => {
  it("submit: the claim and the resubmit after a stale claim start inside the submit's window", async () => {
    const state = new State(home, AGENT_ID);
    const record = { job, claimId: randomUUID(), resumed: false };
    await state.saveRecord(record);
    const recordText = await readFile(state.recordPath, "utf8");
    const answer = join(state.jobDir(job), "answer.md");
    await mkdir(state.jobDir(job), { recursive: true });
    await writeFile(answer, "the summary\n");
    serve({
      "/cli/submit": [
        ...UNAVAILABLE,
        { status: 409, body: { error: "stale_claim" } },
        ...UNAVAILABLE,
        { status: 200, body: { status: "accepted", messageId: `analysis-${job.jobId}` } },
      ],
      "/cli/claim": [...UNAVAILABLE, { status: 200, body: { job, claimId: randomUUID(), resumed: true } }],
    });

    const printed: object[] = [];
    await expect(
      submit(
        client(),
        state,
        AGENT_ID,
        (result) => printed.push(result),
        () => {},
      ),
    ).rejects.toEqual(new CliError(1, "the server is unavailable (HTTP 503); try again"));
    expect(printed).toEqual([]);
    expect(Math.max(...requests.map((request) => request.at))).toBeLessThanOrEqual(RETRY_WINDOW_MS);
    expect(requests.filter((request) => request.route === "/cli/submit")).toHaveLength(7);
    // The recoverable state: the record and the answer as they were, for a rerun.
    expect(await readFile(state.recordPath, "utf8")).toBe(recordText);
    expect(await readFile(answer, "utf8")).toBe("the summary\n");
  });

  it("context: every page starts inside the context's window", async () => {
    const state = new State(home, AGENT_ID);
    await state.saveRecord({ job, claimId: randomUUID(), resumed: false });
    serve({ "/cli/context": [...UNAVAILABLE, page("c1"), ...UNAVAILABLE, page("c2"), ...UNAVAILABLE, page(null)] });

    const printed: object[] = [];
    await expect(context(client(), state, AGENT_ID, (result) => printed.push(result))).rejects.toEqual(
      new CliError(1, "the server is unavailable (HTTP 503); try again"),
    );
    expect(printed).toEqual([]);
    expect(Math.max(...requests.map((request) => request.at))).toBeLessThanOrEqual(RETRY_WINDOW_MS);
    expect(await exists(join(state.jobDir(job), "context.json"))).toBe(false);
  });

  it("context: a page whose first attempt would start after the window closed is not requested", async () => {
    const state = new State(home, AGENT_ID);
    await state.saveRecord({ job, claimId: randomUUID(), resumed: false });
    // Seven 503s put the first page's last attempt at the window's end; it answers 5 s later.
    serve({
      "/cli/context": [
        ...UNAVAILABLE,
        { status: 503, body: { error: "unavailable" } },
        { ...page("c1"), takesMs: 5_000 },
        page(null),
      ],
    });

    await expect(context(client(), state, AGENT_ID, () => {})).rejects.toEqual(
      new CliError(1, "the server is unavailable (HTTP 503); try again"),
    );
    expect(requests.map((request) => request.at)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 30_000, 45_000, 60_000]);
  });
});

function page(nextCursor: string | null): Reply {
  return { status: 200, body: { pr: job.pr, details: null, job, messages: [], nextCursor } };
}
