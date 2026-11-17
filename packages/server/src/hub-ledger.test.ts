import {
  AGENT_PAGE_BYTES,
  AGENT_PAGE_ROWS,
  AgentPage,
  type AgentRow,
  type HubView,
  type Job,
  LEDGER_PAGE_BYTES,
  LEDGER_PAGE_ROWS,
  LedgerPage,
  type LedgerQuery,
  type LedgerRow,
  MAX_LEDGER_CURSOR_CHARS,
  MAX_ROW_CLAIMS,
  MAX_TITLE_CHARS,
  parseSessionName,
  type PrDetails,
  type PrRef,
  REPO_PAGE_BYTES,
  REPO_PAGE_ROWS,
  RepoPage,
  sessionName,
  SubmitResponse,
} from "@prq/protocol";
import { getAgentByName } from "agents";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Hub, type LedgerFilter, ledgerSelect } from "./hub.ts";
import { LedgerEntry, needsAttention, PRESENCE_MS, problemOf, STALL_MS } from "./ledger.ts";
import type { PrSession } from "./pr-session/index.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, connect, hostToken, question } from "./test/chat.ts";
import {
  accepted,
  claimedAgo,
  claimOver,
  controlWaitTimers,
  lastSeenAgo,
  localSession,
  submitOver,
  waitOver,
  waitStatus,
} from "./test/cli.ts";
import {
  cancelWakes,
  claimIn,
  clearQueue,
  gate,
  hub,
  hubSeams,
  ledgerRowOf,
  ledgerRows,
  newSession,
  prSessionSeams,
  quiet,
  retryIn,
  sessionSql,
  setPool,
  submission,
  tracked,
} from "./test/session.ts";
import { push, send, sha } from "./test/webhook.ts";

const sockets: AgentSocket[] = [];

beforeEach(async () => {
  await clearQueue();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q1 = question("q1");
const Q2 = question("q2");

// The Hub's Agent state as the UI receives it (not a view computed on demand).
async function published(): Promise<HubView | undefined> {
  return runInDurableObject(await hub(), (instance) => instance.state);
}

// The entry the Hub stores for a session, with its revision.
async function stored(name: string): Promise<{ rev: number; entry: LedgerEntry } | undefined> {
  const row = await runInDurableObject(
    await hub(),
    (_, state) =>
      state.storage.sql
        .exec<{ rev: number; entry: string }>("SELECT rev, entry FROM prq_ledger WHERE session = ?", name)
        .toArray()[0],
  );
  return row === undefined ? undefined : { rev: row.rev, entry: v.parse(LedgerEntry, JSON.parse(row.entry)) };
}

// The generation of the session's ledger row, while it has one.
async function ledgerGen(stub: DurableObjectStub): Promise<number | undefined> {
  return runInDurableObject(
    stub,
    (_, state) =>
      state.storage.sql.exec<{ gen: number }>("SELECT gen FROM prq_outbox WHERE kind = 'ledger'").toArray()[0]?.gen,
  );
}

// Calls the Hub's first upsertLedger for one session through `replace` (the original for every other call). RPC calls a
// method from the class, so the spy is on the prototype.
async function onLedger(name: string, replace: (upsert: () => Promise<void>) => Promise<void>) {
  await runInDurableObject(await hub(), (instance) => {
    const original = instance.upsertLedger.bind(instance);
    let calls = 0;
    vi.spyOn(Hub.prototype, "upsertLedger").mockImplementation(async (...args) => {
      const upsert = () => original(...args);
      if (args[0] !== name) {
        return upsert();
      }
      calls += 1;
      return calls === 1 ? replace(upsert) : upsert();
    });
  });
}

// Holds the session's first ledger delivery in the Hub, before the Hub stores it.
async function holdLedger(name: string) {
  const held = await gate(await hub());
  await onLedger(name, async (upsert) => {
    await held.wait();
    await upsert();
  });
  return held;
}

async function localPresent(): Promise<boolean> {
  return (await hub()).isLocalPresent();
}

async function setLastSeen(agentId: string, at: number): Promise<void> {
  await runInDurableObject(await hub(), (_, state) => {
    state.storage.sql.exec("UPDATE prq_agents SET last_seen_at = ? WHERE agent_id = ?", at, agentId);
  });
}

// Sets the Hub's clock, its starts included, to an hour ahead of the real one at a time with a millisecond part, and
// returns a way to move it. The scheduler runs a row only once the real clock reaches it, so no row the Hub schedules
// in the test runs by itself: the test runs presenceEnded at the time its row names.
function hubClock() {
  let now = (Math.floor(Date.now() / 1000) + 3600) * 1000 + 600;
  vi.spyOn(hubSeams(Hub.prototype), "clock").mockImplementation(() => now);
  return {
    now: () => now,
    set: (at: number) => {
      now = at;
    },
  };
}

// Runs the one presenceEnded row as the scheduler does when it falls due, with the Hub's clock at the row's second: the
// row goes, then its callback runs.
async function runPresenceEnded(clock: { set(at: number): void }): Promise<void> {
  await runInDurableObject(await hub(), async (instance) => {
    const rows = (await instance.listSchedules()).filter((schedule) => schedule.callback === "presenceEnded");
    expect(rows).toHaveLength(1);
    const [row] = rows;
    clock.set((row?.time ?? 0) * 1000);
    await instance.cancelSchedule(row?.id ?? "");
    await instance.presenceEnded();
  });
}

async function cancelHubSchedules(): Promise<void> {
  await runInDurableObject(await hub(), async (instance) => {
    for (const schedule of await instance.listSchedules()) {
      await instance.cancelSchedule(schedule.id);
    }
  });
}

// The seconds the Hub's presenceEnded rows are due at.
async function presenceAlarms(): Promise<number[]> {
  return runInDurableObject(await hub(), async (instance) =>
    (await instance.listSchedules())
      .filter((schedule) => schedule.callback === "presenceEnded")
      .map((schedule) => schedule.time),
  );
}

// Stores rows of open pull requests of the owner octo in the Hub's ledger as they are, with no job and nothing that
// needs attention: many rows at once, as a long-lived ledger holds them. The Hub has stored an entry of octo's first, so
// the owner is counted.
async function storeRows(rows: { session: string; at: number | null; entry: LedgerEntry }[]): Promise<void> {
  const stub = await hub();
  await stub.upsertLedger("octo~seed~1", 1, quiet());
  await runInDurableObject(stub, (_, state) => {
    for (const { session, at, entry } of rows) {
      const [owner, repo] = session.split("~");
      expect(owner).toBe("octo");
      state.storage.sql.exec(
        `INSERT INTO prq_ledger (session, rev, entry, sort_at, repo, open, attention_present, attention_absent,
           jobs_waiting, jobs_running, jobs_failed)
         VALUES (?, 1, ?, ?, ?, 1, 0, 0, 0, 0, 0)`,
        session,
        JSON.stringify({ ...entry, latestEvent: at === null ? null : { kind: "push", at } }),
        at ?? -1,
        `octo/${repo}`,
      );
      state.storage.sql.exec(
        "INSERT INTO prq_repos (repo, owner, full_name) VALUES (?, 'octo', ?) ON CONFLICT (repo) DO NOTHING",
        `octo/${repo}`,
        `octo/${repo}`,
      );
    }
  });
}

// Every page of the ledger, from the first.
async function ledgerPages(): Promise<LedgerPage[]> {
  const pages: LedgerPage[] = [];
  let cursor: string | undefined;
  do {
    const page = v.parse(LedgerPage, await (await hub()).ledgerPage({ cursor, state: "all" }));
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return pages;
}

// A stored row as the test reads it: its pull request and its entry.
type Stored = { pr: PrRef; entry: LedgerEntry };

// The list's order (docs/design.md, PR ledger) of the stored rows `keep` keeps, read from their entries: latest event
// first, rows without one last, then the session name descending.
async function listOrder(keep: (row: Stored) => boolean = () => true): Promise<string[]> {
  const rows = await runInDurableObject(await hub(), (_, state) =>
    state.storage.sql.exec<{ session: string; entry: string }>("SELECT session, entry FROM prq_ledger").toArray(),
  );
  return rows
    .map((row) => ({ session: row.session, pr: parseSessionName(row.session), entry: JSON.parse(row.entry) }))
    .flatMap(({ session, pr, entry }) => (pr === null ? [] : [{ session, pr, entry: v.parse(LedgerEntry, entry) }]))
    .filter(keep)
    .map(({ session, entry }) => ({ session, at: entry.latestEvent?.at ?? -1 }))
    .toSorted((a, b) => b.at - a.at || (a.session < b.session ? 1 : a.session > b.session ? -1 : 0))
    .map((row) => row.session);
}

// Every page of the present agents, from the first.
async function agentPages(): Promise<AgentPage[]> {
  const pages: AgentPage[] = [];
  let cursor: string | undefined;
  do {
    const page = v.parse(AgentPage, await (await hub()).agentPage(cursor));
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return pages;
}

// Every page of the repositories, from the first.
async function repoPages(): Promise<RepoPage[]> {
  const pages: RepoPage[] = [];
  let cursor: string | undefined;
  do {
    const page = v.parse(RepoPage, await (await hub()).repoPage(cursor));
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return pages;
}

// An agent's row in the first page of the pool.
async function agentRow(agentId: string): Promise<AgentRow | undefined> {
  return v.parse(AgentPage, await (await hub()).agentPage()).rows.find((row) => row.agentId === agentId);
}

function sessionsOf(rows: readonly LedgerRow[]): string[] {
  return rows.map((row) => sessionName(row.pr));
}

const utf8 = new TextEncoder();

function bytesOf(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).length;
}

// Details at their largest in bytes: a title of MAX_TITLE_CHARS characters of 3 bytes each.
function largeDetails(name: string): PrDetails {
  return {
    fullName: name,
    title: "あ".repeat(MAX_TITLE_CHARS),
    state: "open",
    url: `https://github.com/${name}/pull/1`,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
  };
}

describe("view broadcasts", () => {
  it("broadcasts the view only when presence or the ledger changed, and refuses a client's state update", async () => {
    const logs = captureLogs();
    await setPool([]);
    const socket = await connect("/agents/hub/hub", await hostToken());
    sockets.push(socket);
    const states = () => socket.frames.filter((frame) => frame["type"] === "cf_agent_state").length;
    const viewWith = (agents: number, from: number) =>
      socket.next(
        (frame) => frame["type"] === "cf_agent_state" && JSON.stringify(frame).includes(`"presentAgents":${agents},`),
        from,
      );

    let from = socket.frames.length;
    await (await hub()).touch("desk");
    await viewWith(1, from);
    const changed = states();
    const version = (await published())?.ledgerVersion ?? Number.NaN;

    // None of these changes the view: another contact of a present agent, a presence check with nothing ended, and a
    // redelivery of the stored entry.
    await (await hub()).touch("desk");
    await (await hub()).presenceEnded();
    await (await hub()).upsertLedger("octo~view~1", 1, quiet());
    const entry = await stored("octo~view~1");
    await (await hub()).upsertLedger("octo~view~1", 1, quiet());
    expect(await stored("octo~view~1")).toEqual(entry);
    // The ledger row above was a change: one broadcast, with the next version. The next change's view is the very next
    // frame after it.
    expect((await published())?.ledgerVersion).toBe(version + 1);
    from = socket.frames.length;
    await (await hub()).touch("shelf");
    await viewWith(2, from);
    expect(states()).toBe(changed + 2);

    const before = await published();
    from = socket.frames.length;
    socket.send({ type: "cf_agent_state", state: { ...before, localAgentPresent: false, presentAgents: 0 } });
    await socket.next((frame) => frame["type"] === "cf_agent_state_error", from);
    expect(await published()).toEqual(before);
    expect(logs.some((log) => log.entry["event"] === "prq.state.refused")).toBe(true);
  });
});

describe("out-of-order push", () => {
  it("keeps the newer entry when an older delivery lands after it, and logs the stale one", async () => {
    const logs = captureLogs();
    const { stub, name, client } = await localSession("ledger", sockets);
    const held = await holdLedger(name);
    const asked = tracked(client.chat([Q1]));
    await held.reached();
    const older = await ledgerGen(stub);
    // The hold is real: the Hub and the session serve while Q1's delivery waits in the Hub.
    expect(await (await hub()).isLocalPresent()).toBe(true);
    expect((await stub.view()).jobs).toHaveLength(1);
    expect(asked.settled()).toBe(false);

    // A claim changes the entry and delivers it: it lands first.
    await claimIn(stub, "laptop", "fresh");
    const newer = await stored(name);
    expect(newer?.rev).toBeGreaterThan(older ?? Infinity);
    expect(newer?.entry.claims).toEqual([expect.objectContaining({ agentId: "laptop" })]);

    await held.open();
    await asked.promise;
    expect(await stored(name)).toEqual(newer);
    expect((await ledgerRowOf(name))?.claims).toEqual([expect.objectContaining({ agentId: "laptop" })]);
    expect(
      logs.some(
        ({ entry }) =>
          entry["event"] === "prq.ledger.stale_rev" && entry["rev"] === older && entry["stored"] === newer?.rev,
      ),
    ).toBe(true);
  });

  it("orders the rows by latest event, newest first, rows without one last", async () => {
    captureLogs();
    const stub = await hub();
    await stub.upsertLedger("octo~order~1", 1, quiet({ latestEvent: { kind: "question", at: 1000 } }));
    await stub.upsertLedger("octo~order~2", 1, quiet());
    await stub.upsertLedger("octo~order~3", 1, quiet({ latestEvent: { kind: "question", at: 3000 } }));
    const names = (await ledgerRows()).map((row) => sessionName(row.pr)).filter((name) => name.includes("order"));
    expect(names).toEqual(["octo~order~3", "octo~order~1", "octo~order~2"]);
  });
});

describe("ledger redelivery", () => {
  it("keeps the ledger row of a failed delivery, and the next settle delivers the newest entry", async () => {
    const logs = captureLogs();
    const { stub, name, client } = await localSession("ledger", sockets);
    await onLedger(name, () => Promise.reject(new Error("Hub unreachable")));
    await client.chat([Q1]);
    expect(logs.some((log) => log.entry["event"] === "prq.outbox.failed")).toBe(true);
    expect(await stored(name)).toBeUndefined();
    const gen = await ledgerGen(stub);
    expect(gen).toEqual(expect.any(Number));

    await stub.settle();
    expect(await stored(name)).toMatchObject({
      rev: gen,
      entry: { owner: "local", waitingWork: true, jobs: { waiting: 1 }, latestEvent: { kind: "question" } },
    });
    expect(await ledgerGen(stub)).toBeUndefined();
  });

  it("does not let an older delivery delete the ledger row written again after it read", async () => {
    captureLogs();
    const { stub, name, client } = await localSession("ledger", sockets);
    const held = await holdLedger(name);
    const asked = tracked(client.chat([Q1]));
    await held.reached();
    const read = await ledgerGen(stub);
    expect((await stub.view()).jobs).toHaveLength(1);
    expect(asked.settled()).toBe(false);
    // A claim writes the row again; its own delivery is skipped, so only the row carries it.
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "deliver").mockResolvedValueOnce(undefined);
    });
    await claimIn(stub, "laptop", "fresh");
    const written = await ledgerGen(stub);
    expect(written).toBeGreaterThan(read ?? Infinity);

    await held.open();
    await asked.promise;
    // The older delivery landed (the Hub had nothing newer) and left the newer row.
    expect((await stored(name))?.rev).toBe(read);
    expect(await ledgerGen(stub)).toBe(written);
    await stub.settle();
    expect(await stored(name)).toMatchObject({ rev: written, entry: { claims: [{ agentId: "laptop" }] } });
    expect(await ledgerGen(stub)).toBeUndefined();
  });

  it.for(["claim", "submit"] as const)(
    "brings the entry to the Hub through the wake when the session stopped after the %s's change",
    { timeout: 20_000 },
    async (step) => {
      captureLogs();
      const { stub, name, client } = await localSession("ledger", sockets);
      await client.chat([Q1]);
      const claim = step === "submit" ? await claimIn(stub, "laptop", "fresh") : undefined;
      await cancelWakes(stub);
      const held = await gate(stub);
      await runInDurableObject(stub, (instance) => {
        vi.spyOn(prSessionSeams(instance), "deliver").mockImplementationOnce(() => held.wait());
      });
      const call = tracked(
        claim === undefined ? claimIn(stub, "laptop", "fresh") : stub.submit(submission(claim, "laptop")),
      );
      await held.reached();
      // The hold is real: the session serves while the call waits in its delivery.
      expect((await stub.view()).jobs).toHaveLength(1);
      expect(call.settled()).toBe(false);
      const before = (await stored(name))?.rev;

      await abortAllDurableObjects();
      await call.promise.catch(() => undefined);
      // Only the Hub is asked from here on: the session delivers when its wake runs.
      const delivered = step === "claim" ? { claims: [{ agentId: "laptop" }] } : { latestEvent: { kind: "answer" } };
      await vi.waitFor(
        async () => {
          const entry = await stored(name);
          expect(entry?.rev).toBeGreaterThan(before ?? 0);
          expect(entry?.entry).toMatchObject(delivered);
        },
        { timeout: 12_000, interval: 200 },
      );
    },
  );
});

// A cloud session with no cloud agent: its jobs fail as they are made.
async function cloudSession() {
  await setPool([]);
  return newSession("ledger", sockets);
}

// From now on the session has a cloud agent, which only records the jobs it is handed.
async function withCloudAgent(stub: DurableObjectStub<PrSession>): Promise<string[]> {
  const started: string[] = [];
  const agent = { start: (job: Job) => void started.push(job.jobId) };
  await runInDurableObject(stub, (instance) => {
    vi.spyOn(prSessionSeams(instance), "cloudAgent").mockReturnValue(agent);
  });
  return started;
}

describe("failure labels", () => {
  it("keeps Answer failed through a retry until the retried job completes", async () => {
    captureLogs();
    const { stub, name, open } = await cloudSession();
    await (await open()).chat([Q1]);
    const [failed] = (await stub.view()).jobs;
    expect(failed).toMatchObject({ state: "failed" });
    expect(await ledgerRowOf(name)).toMatchObject({ problem: "answer_failed", jobs: { failed: 1 } });

    // The retry hands the job to the cloud agent: it runs, and its failure is not resolved.
    const started = await withCloudAgent(stub);
    await retryIn(stub, failed?.jobId ?? "");
    expect(started).toEqual([failed?.jobId]);
    // The failure counts until the retried job completes.
    expect(await ledgerRowOf(name)).toMatchObject({
      problem: "answer_failed",
      jobs: { failed: 1, running: 1 },
    });

    // It completes through the statement that marks a job done (a finalizing job whose message is stored, as a
    // settle sweep finds it); #5's cloud completion stands in for it here.
    const jobId = failed?.jobId ?? "";
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'finalizing', claim_id = 'cloud' WHERE job_id = ?", jobId);
    await runInDurableObject(stub, (instance) =>
      instance.sessions
        .session()
        .appendMessage({ id: `answer-${jobId}`, role: "assistant", parts: [{ type: "text", text: "the answer" }] }),
    );
    await stub.settle();
    expect((await stub.view()).jobs[0]).toMatchObject({ state: "done" });
    expect(await ledgerRowOf(name)).toMatchObject({
      problem: null,
      latestEvent: { kind: "answer" },
      jobs: { failed: 0, running: 0 },
    });
  });

  it("shows Summary failed for the current head's failed analysis only, until it completes", async () => {
    captureLogs();
    const { stub, name, ref } = await cloudSession();
    await push(ref, "A");
    expect(await ledgerRowOf(name)).toMatchObject({ problem: "summary_failed", jobs: { failed: 1 } });

    // A newer head's analysis runs: the failed one is an older head's, and the new head has no summary yet.
    await withCloudAgent(stub);
    await push(ref, "B");
    expect(await ledgerRowOf(name)).toMatchObject({ problem: "new_push_not_summarized", jobs: { failed: 0 } });

    // A's analysis, retried while its head is not current, is superseded; it fails no less until it completes, so a
    // push back to A shows it again (revived, waiting behind B's running analysis).
    const a = (await stub.view()).jobs.find((job) => job.target.kind === "analysis" && job.target.headSha === sha("A"));
    expect(await retryIn(stub, a?.jobId ?? "")).toEqual({ status: "superseded" });
    expect((await ledgerRowOf(name))?.problem).toBe("new_push_not_summarized");
    await push(ref, "A");
    expect((await stub.view()).jobs.find((job) => job.jobId === a?.jobId)?.state).toBe("pending");
    expect(await ledgerRowOf(name)).toMatchObject({ problem: "summary_failed", jobs: { failed: 1 } });
  });
});

describe("latest event", () => {
  it("moves a row only for a head change, a question and a completed summary or answer", async () => {
    captureLogs();
    const { stub, name, ref, token, client } = await localSession("ledger", sockets);
    const event = async () => (await stored(name))?.entry.latestEvent;
    const rev = async () => (await stored(name))?.rev ?? 0;
    // The session's event is set back, so any later write of it shows.
    const setBack = () => sessionSql(stub, "UPDATE prq_session SET latest_event_at = 1");
    const unchanged = async <T>(kind: string, step: () => Promise<T>): Promise<T> => {
      await setBack();
      const before = await rev();
      const result = await step();
      expect(await rev()).toBeGreaterThan(before);
      expect(await event()).toEqual({ kind, at: 1 });
      return result;
    };
    const moved = async (kind: string, step: () => Promise<unknown>) => {
      await setBack();
      await step();
      expect(await event()).toEqual({ kind, at: expect.any(Number) });
      expect((await event())?.at).toBeGreaterThan(1);
    };

    await moved("push", () => push(ref, "A"));
    // A push of the current head, and an edit.
    await unchanged("push", () => send(ref, { action: "reopened", head: sha("A") }));
    await unchanged("push", () => send(ref, { action: "edited", head: sha("A"), title: "Renamed" }));
    expect((await stored(name))?.entry.details?.title).toBe("Renamed");
    await moved("question", () => client.chat([Q1]));
    // Claims are not events; completing the answer, then the summary, is.
    const answer = await unchanged("question", () => claimOver(token, "laptop"));
    expect(answer.job?.target.kind).toBe("answer");
    await moved("answer", () => accepted(submitOver(token, ref, answer, "laptop")));
    const analysis = await unchanged("answer", () => claimOver(token, "laptop"));
    expect(analysis.job?.target.kind).toBe("analysis");
    await moved("summary", () => accepted(submitOver(token, ref, analysis, "laptop")));
    await moved("push", () => push(ref, "B"));
  });
});

describe("waiting label", () => {
  it("shows Waiting for a local agent when presence lapses with no other event, and clears it when a wait starts", async () => {
    captureLogs();
    const { name, token } = await localSession("ledger", sockets, Q1);
    expect(await ledgerRowOf(name)).toMatchObject({ problem: null, jobs: { waiting: 1 } });

    // laptop's presence now ends a second ahead on the Hub's clock, at a time with a millisecond part.
    const clock = hubClock();
    const end = clock.now() + 1000;
    await setLastSeen("laptop", end - PRESENCE_MS);
    await cancelHubSchedules();
    await (await hub()).presenceEnded();
    expect(await presenceAlarms()).toEqual([Math.ceil(end / 1000)]);
    expect((await ledgerRowOf(name))?.problem).toBeNull();

    await runPresenceEnded(clock);
    // No agent is present: nothing is left to end.
    expect(await presenceAlarms()).toEqual([]);
    const lapsed = await published();
    expect(lapsed?.localAgentPresent).toBe(false);
    expect((await ledgerRowOf(name))?.problem).toBe("waiting_for_local_agent");
    expect(lapsed?.needsAttention).toBeGreaterThanOrEqual(1);

    expect(await waitStatus(waitOver(token, "laptop"))).toBe("ready");
    const back = await published();
    expect(back?.localAgentPresent).toBe(true);
    expect((await ledgerRowOf(name))?.problem).toBeNull();
  });
});

describe("presence from claims", () => {
  it("keeps an agent with a held claim present past its last contact, until STALL_MS + PRESENCE_MS after the claim", async () => {
    captureLogs();
    const { token } = await localSession("ledger", sockets, Q1);
    await claimOver(token, "laptop");

    await lastSeenAgo(PRESENCE_MS + 1);
    expect(await localPresent()).toBe(true);
    expect(v.parse(AgentPage, await (await hub()).agentPage()).rows).toEqual([
      { agentId: "laptop", lastSeenAt: expect.any(Number), waiting: false, holdsJob: true },
    ]);
    await claimedAgo(STALL_MS + PRESENCE_MS - 1000);
    expect(await localPresent()).toBe(true);
    await claimedAgo(STALL_MS + PRESENCE_MS);
    expect(await localPresent()).toBe(false);
  });

  it("ends an agent's presence by its latest claim, whichever order its claims come in", async () => {
    captureLogs();
    const clock = hubClock();
    const old = STALL_MS + PRESENCE_MS + 60_000;
    for (const [n, ages] of [
      [old, 0],
      [0, old],
    ].entries()) {
      // A Hub of its own, where laptop is present only by the newer of its two claims.
      const stub = await getAgentByName(env.Hub, `claim-latest-${n}`);
      await stub.upsertLedger(
        "octo~latest~1",
        1,
        quiet({ claims: ages.map((ageMs, job) => ({ agentId: "laptop", jobId: `j${job}`, since: 0, ageMs })) }),
      );
      const { alarms, page } = await runInDurableObject(stub, async (instance) => ({
        alarms: (await instance.listSchedules())
          .filter((schedule) => schedule.callback === "presenceEnded")
          .map((schedule) => schedule.time),
        page: instance.agentPage(),
      }));
      expect(alarms).toEqual([Math.ceil((clock.now() + STALL_MS + PRESENCE_MS) / 1000)]);
      expect(page).toEqual({
        rows: [{ agentId: "laptop", lastSeenAt: null, waiting: false, holdsJob: true }],
        nextCursor: null,
      });
    }
  });

  it("places a claim on the Hub's clock by its age when the session sends it", async () => {
    captureLogs();
    const { stub, name, client } = await localSession("ledger", sockets, Q1);
    await claimIn(stub, "laptop", "fresh");
    // The claim was made 65 minutes ago by the session's clock; the next entry carries that age.
    await sessionSql(stub, "UPDATE prq_jobs SET claimed_at = ?", Date.now() - 65 * 60_000);
    await client.chat([Q1, Q2]);
    const claimedAt = await runInDurableObject(
      await hub(),
      (_, state) =>
        state.storage.sql
          .exec<{ claimed_at: number }>("SELECT claimed_at FROM prq_claims WHERE session = ?", name)
          .one().claimed_at,
    );
    expect(Date.now() - claimedAt).toBeGreaterThanOrEqual(65 * 60_000);
    expect(Date.now() - claimedAt).toBeLessThan(66 * 60_000);
    expect((await ledgerRowOf(name))?.problem).toBe("possibly_stalled");
  });

  it("keeps the agent present PRESENCE_MS after a submit ends its claim, and not again after a late retry", async () => {
    captureLogs();
    const { stub, client } = await localSession("ledger", sockets, Q1);
    const claim = await claimIn(stub, "laptop", "fresh");

    // The claim applies (30 minutes old), the last contact does not. A submit made on the session directly is no
    // contact of its own: the claim's end counts as one.
    await claimedAgo(30 * 60_000);
    await lastSeenAgo(PRESENCE_MS + 1);
    v.parse(SubmitResponse, await stub.submit(submission(claim, "laptop")));
    expect(await localPresent()).toBe(true);
    await lastSeenAgo(PRESENCE_MS);
    expect(await localPresent()).toBe(false);

    // A claim retried 75 minutes after it was made stopped applying at 60: presence ended at 70 and stays ended.
    await client.chat([Q1, Q2]);
    const second = await claimIn(stub, "laptop", "fresh");
    await claimedAgo(75 * 60_000);
    await lastSeenAgo(PRESENCE_MS + 1);
    expect(await localPresent()).toBe(false);
    await retryIn(stub, second.job?.jobId ?? "");
    expect(await localPresent()).toBe(false);
  });
});

// Rows of two owners' three repositories in every state, some needing attention whatever the presence and some only
// without a local agent, with shared and missing event times.
async function storeFilterRows(): Promise<void> {
  const stub = await hub();
  const repos = [
    ["filo", "one"],
    ["filo", "two"],
    ["acme", "one"],
  ] as const;
  const states = ["open", "closed", "merged", null] as const;
  for (let n = 1; n <= 24; n += 1) {
    const [owner, repo] = repos[n % 3] ?? repos[0];
    const state = states[n % 4] ?? null;
    const details = state === null ? null : { ...largeDetails(`${owner}/${repo}`), title: `pr ${n}`, state };
    await stub.upsertLedger(
      `${owner}~${repo}~${n}`,
      1,
      quiet({
        details,
        answerFailed: n % 5 === 0,
        waitingWork: n % 5 === 1,
        latestEvent: n % 6 === 0 ? null : { kind: "question", at: 1000 + (n % 7) },
      }),
    );
  }
}

// Every row a filtered walk of the ledger lists, page by page.
async function filteredWalk(query: LedgerQuery): Promise<string[]> {
  return filteredWalkFrom(query, undefined);
}

// The rows a filtered walk lists from a cursor on.
async function filteredWalkFrom(query: LedgerQuery, from: string | null | undefined): Promise<string[]> {
  if (from === null) {
    return [];
  }
  const sessions: string[] = [];
  let cursor = from;
  do {
    const page = v.parse(LedgerPage, await (await hub()).ledgerPage({ ...query, cursor }));
    sessions.push(...sessionsOf(page.rows));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return sessions;
}

function isOpen({ entry }: Stored): boolean {
  return entry.details === null || entry.details.state === "open";
}

function inRepo(repo: string): (row: Stored) => boolean {
  return ({ pr }) => `${pr.owner}/${pr.repo}` === repo;
}

function needingAttention(present: boolean): (row: Stored) => boolean {
  return ({ entry }) => needsAttention(problemOf(entry, present));
}

// Each filter a page reads its rows under, as the Hub applies it.
const FILTERS: { name: string; filter: LedgerFilter }[] = [
  { name: "all", filter: { open: false, repo: null } },
  { name: "open", filter: { open: true, repo: null } },
  { name: "repo", filter: { open: false, repo: "octo/bulk" } },
  { name: "open repo", filter: { open: true, repo: "octo/bulk" } },
  { name: "attention present", filter: { attention: "attention_present" } },
  { name: "attention absent", filter: { attention: "attention_absent" } },
];

// Rows of octo/bulk's list that a filter leaves out, each passing the filter's other conditions: closed, in another
// repository, with nothing that needs attention, and with work that waits, which needs attention only without a local
// agent.
const CLOSED = {
  repo: "bulk",
  entry: quiet({ details: { ...largeDetails("octo/bulk"), title: "t", state: "closed" } }),
};
const ELSEWHERE = { repo: "other", entry: quiet() };
const QUIET = { repo: "bulk", entry: quiet() };
const WAITING = { repo: "bulk", entry: quiet({ waitingWork: true }) };
const SKIPPED_BLOCK = 1500;

// Agents seen long ago, each with a claim made as long ago, that a contact and a pool page read none of.
const STALE_AGENTS = 10_000;

// Each query a page takes, with the presence it is read with and the rows its filter leaves out (none for the whole
// list).
const BOUNDED_SCANS: { query: LedgerQuery; present: boolean; skipped: { repo: string; entry: LedgerEntry }[] }[] = [
  { query: { state: "all" }, present: false, skipped: [] },
  { query: { state: "open" }, present: false, skipped: [CLOSED] },
  { query: { state: "all", repo: "octo/bulk" }, present: false, skipped: [ELSEWHERE] },
  { query: { state: "open", repo: "octo/bulk" }, present: false, skipped: [CLOSED, ELSEWHERE] },
  { query: { attention: "1" }, present: true, skipped: [QUIET, WAITING] },
  { query: { attention: "1" }, present: false, skipped: [QUIET] },
];

// A filter's plans from the first page and after a cursor: one range of its index, under the equality it starts with,
// walked backwards with no sort.
function rangePlans(index: string, equality: string): string[] {
  const first =
    equality === "" ? `SCAN prq_ledger USING INDEX ${index}` : `SEARCH prq_ledger USING INDEX ${index} (${equality})`;
  const after = [equality, "(sort_at,session)<(?,?)"].filter((term) => term !== "").join(" AND ");
  return [first, `SEARCH prq_ledger USING INDEX ${index} (${after})`];
}

// An open pull request of octo/bulk whose failed answer needs attention, which every filter keeps.
function keptEverywhere(at: number): LedgerEntry {
  return quiet({ answerFailed: true, latestEvent: { kind: "question", at } });
}

// What a call gives, the rows all the queries it makes read, and those queries with their bindings.
async function reading<T>(
  sql: SqlStorage,
  call: () => T,
): Promise<{ value: Awaited<T>; read: number; queries: Parameters<SqlStorage["exec"]>[] }> {
  const exec = vi.spyOn(sql, "exec");
  try {
    const value = await call();
    return {
      value,
      read: exec.mock.results.reduce((sum, result) => sum + (result.type === "return" ? result.value.rowsRead : 0), 0),
      queries: [...exec.mock.calls],
    };
  } finally {
    exec.mockRestore();
  }
}

// What a page of the ledger lists, and the rows all its queries read.
async function pageReads(
  instance: Hub,
  sql: SqlStorage,
  query: LedgerQuery,
): Promise<{ listed: string[]; read: number }> {
  const { value, read } = await reading(sql, () => instance.ledgerPage(query));
  return { listed: sessionsOf(v.parse(LedgerPage, value).rows), read };
}

describe("ledger filters", () => {
  it("lists under each filter exactly the rows it keeps, in the list's order, across pages", async () => {
    captureLogs();
    await storeFilterRows();
    // Pages of two rows or so, so each walk goes through the cursor.
    const largest = Math.max(...(await ledgerRows()).map(bytesOf));
    const envelope = bytesOf({ rows: [], nextCursor: "x".repeat(MAX_LEDGER_CURSOR_CHARS) });
    await runInDurableObject(await hub(), (instance) => {
      vi.spyOn(hubSeams(instance), "ledgerPageBytes").mockReturnValue(envelope + 2 * largest + 1);
    });
    for (const present of [false, true]) {
      await setPool(present ? ["desk"] : []);
      const attention = needingAttention(present);
      const cases: { query: LedgerQuery; keep: (row: Stored) => boolean }[] = [
        { query: { state: "all" }, keep: () => true },
        { query: { state: "open" }, keep: isOpen },
        { query: { state: "all", repo: "FILO/One" }, keep: inRepo("filo/one") },
        { query: { state: "open", repo: "acme/one" }, keep: (row) => isOpen(row) && inRepo("acme/one")(row) },
        // Needs attention, in every state and repository.
        { query: { attention: "1" }, keep: attention },
      ];
      for (const { query, keep } of cases) {
        const expected = await listOrder(keep);
        expect({ present, query, rows: await filteredWalk(query) }).toEqual({ present, query, rows: expected });
      }
    }
    // Rows that need attention only without a local agent are kept only then.
    await setPool(["desk"]);
    const withAgent = await filteredWalk({ attention: "1" });
    await setPool([]);
    const without = await filteredWalk({ attention: "1" });
    expect(without.filter((session) => !withAgent.includes(session))).not.toEqual([]);
  });

  it("goes on after the cursor's row under a filter while rows move in and out of it", async () => {
    captureLogs();
    const stub = await hub();
    const query = { state: "open", repo: "keyf/one" } as const;
    await runInDurableObject(stub, async (instance) => {
      for (let n = 1; n <= LEDGER_PAGE_ROWS + 20; n += 1) {
        await instance.upsertLedger(`keyf~one~${n}`, 1, quiet({ latestEvent: { kind: "question", at: 10_000 + n } }));
      }
    });
    const before = await listOrder((row) => isOpen(row) && inRepo("keyf/one")(row));
    const first = v.parse(LedgerPage, await stub.ledgerPage(query));
    // A row of the first page leaves the filter (closed), a row after it moves to the top, and a new one comes first.
    const closed = { ...largeDetails("keyf/one"), title: "t", state: "closed" } as const;
    await stub.upsertLedger("keyf~one~520", 2, quiet({ details: closed, latestEvent: { kind: "push", at: 20_000 } }));
    await stub.upsertLedger("keyf~one~5", 2, quiet({ latestEvent: { kind: "question", at: 30_000 } }));
    await stub.upsertLedger("keyf~one~999", 1, quiet({ latestEvent: { kind: "question", at: 30_001 } }));
    const rest = await filteredWalkFrom(query, first.nextCursor);
    const listed = [...sessionsOf(first.rows), ...rest];
    expect(new Set(listed).size).toBe(listed.length);
    const moved = new Set(["keyf~one~520", "keyf~one~5", "keyf~one~999"]);
    expect(listed.filter((name) => !moved.has(name))).toEqual(before.filter((name) => !moved.has(name)));
    expect((await filteredWalk(query)).slice(0, 2)).toEqual(["keyf~one~999", "keyf~one~5"]);
  });

  it("reads each filter's page as one range of the index made for it, where another index could serve it", async () => {
    const plans = await runInDurableObject(await hub(), (_, state) => {
      const { sql } = state.storage;
      // Indexes on the filters' conditions alone, which a planner (of another version, or with other statistics) could
      // prefer to the filter's own and then sort what they give.
      const decoys = ["open", "repo, open", "attention_present", "attention_absent"];
      for (const [n, columns] of decoys.entries()) {
        sql.exec(`CREATE INDEX decoy_${n} ON prq_ledger (${columns})`);
      }
      const plan = (filter: LedgerFilter, after?: { at: number; session: string }) => {
        const { query, bindings } = ledgerSelect(filter, after, 10);
        return sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...bindings)
          .toArray()
          .map((row) => row.detail)
          .join("; ");
      };
      try {
        return Object.fromEntries(
          FILTERS.map(({ name, filter }) => [name, [plan(filter), plan(filter, { at: 1000, session: "octo~a~1" })]]),
        );
      } finally {
        for (const n of decoys.keys()) {
          sql.exec(`DROP INDEX decoy_${n}`);
        }
      }
    });
    expect(plans).toEqual({
      all: rangePlans("prq_ledger_order", ""),
      open: rangePlans("prq_ledger_open", ""),
      repo: rangePlans("prq_ledger_repo", "repo=?"),
      "open repo": rangePlans("prq_ledger_repo_open", "repo=?"),
      "attention present": rangePlans("prq_ledger_attention_present", ""),
      "attention absent": rangePlans("prq_ledger_attention_absent", ""),
    });
  });

  it("reads only the rows a page lists under each filter, with thousands it leaves out between and after them", async () => {
    captureLogs();
    const top = "octo~bulk~9001";
    const middle = "octo~bulk~9002";
    for (const [scan, { query, present, skipped }] of BOUNDED_SCANS.entries()) {
      // A Hub of its own, whose ledger holds only the rows below.
      const stub = await getAgentByName(env.Hub, `ledger-scan-${scan}`);
      if (present) {
        await stub.touch("desk");
      }
      const pages = await runInDurableObject(stub, async (instance, state) => {
        const { sql } = state.storage;
        // What the page's other queries (presence) read, with no row to list.
        const others = (await pageReads(instance, sql, query)).read;
        // Two rows every filter keeps, then blocks of rows it leaves out: between them and after the second.
        await instance.upsertLedger(top, 1, keptEverywhere(3_000_000));
        await instance.upsertLedger(middle, 1, keptEverywhere(2_000_000));
        for (const [n, kind] of skipped.entries()) {
          await instance.upsertLedger(`octo~${kind.repo}~${n + 1}`, 1, kind.entry);
        }
        for (let n = 0; n < 2 * SKIPPED_BLOCK && skipped.length > 0; n += 1) {
          const template = n % skipped.length;
          sql.exec(
            `INSERT INTO prq_ledger (session, rev, entry, sort_at, repo, open, attention_present, attention_absent,
               jobs_waiting, jobs_running, jobs_failed)
             SELECT ?, rev, entry, ?, repo, open, attention_present, attention_absent, jobs_waiting, jobs_running,
               jobs_failed FROM prq_ledger WHERE session = ?`,
            `octo~${skipped[template]?.repo}~${n + 100}`,
            (n < SKIPPED_BLOCK ? 2_500_000 : 1_000_000) + n,
            `octo~${skipped[template]?.repo}~${template + 1}`,
          );
        }
        const read: { listed: string[]; read: number }[] = [];
        for (const cursor of [undefined, `3000000.${top}`, `2000000.${middle}`]) {
          const page = await pageReads(instance, sql, { ...query, cursor });
          read.push({ listed: page.listed, read: page.read - others });
        }
        return read;
      });
      expect({ query, present, listed: pages.map((page) => page.listed) }).toEqual({
        query,
        present,
        listed: [[top, middle], [middle], []],
      });
      // A page reads the rows it lists, and at most the one its cursor names.
      const over = pages.filter((page) => page.read > page.listed.length + 1);
      expect({ query, present, over }).toEqual({ query, present, over: [] });
    }
  });
});

describe("bounded view and ledger pages", () => {
  it("keeps the view small with thousands of rows, and leaves it as it is on a present agent's contact", async () => {
    captureLogs();
    await storeRows(
      Array.from({ length: 2200 }, (_, n) => ({
        session: `octo~scale~${n + 1}`,
        at: 1000 + n,
        entry: quiet({ details: largeDetails("octo/scale") }),
      })),
    );
    await setPool(["scale"]);
    const stub = await hub();
    const view = await published();
    expect(bytesOf(view)).toBeLessThan(512);
    let sets = 0;
    await runInDurableObject(stub, (instance) => {
      const setState = instance.setState.bind(instance);
      vi.spyOn(instance, "setState").mockImplementation((state) => {
        sets += 1;
        setState(state);
      });
    });
    await stub.touch("scale");
    expect(sets).toBe(0);
    expect(await published()).toEqual(view);
  });

  it("pages every row once, in the list's order, each page within its bytes and rows", async () => {
    captureLogs();
    // Large rows end pages by bytes and small ones by count; some rows share an event time, some have none.
    await storeRows([
      ...Array.from({ length: 300 }, (_, n) => ({
        session: `octo~pages~${n + 1}`,
        at: 5000 + Math.floor(n / 3),
        entry: quiet({ details: largeDetails("octo/pages") }),
      })),
      // Below every large row of the file, so more than a page of small rows follow each other.
      ...Array.from({ length: 1100 }, (_, n) => ({
        session: `octo~pages~${n + 301}`,
        at: n % 5 === 0 ? null : 10 + Math.floor(n / 4),
        entry: quiet(),
      })),
    ]);
    const pages = await ledgerPages();
    for (const page of pages) {
      expect(page.rows.length).toBeLessThanOrEqual(LEDGER_PAGE_ROWS);
      expect(bytesOf(page)).toBeLessThanOrEqual(LEDGER_PAGE_BYTES);
    }
    expect(pages.some((page) => page.rows.length === LEDGER_PAGE_ROWS)).toBe(true);
    expect(pages.some((page) => page.nextCursor !== null && page.rows.length < LEDGER_PAGE_ROWS)).toBe(true);
    expect(pages.flatMap((page) => sessionsOf(page.rows))).toEqual(await listOrder());
  });

  it("goes on after the cursor's row while rows move, listing every unchanged row once", async () => {
    captureLogs();
    const stub = await hub();
    // The newest rows of the ledger: a first page of them and more after it.
    const top = Number.MAX_SAFE_INTEGER - 1_000_000;
    await storeRows(
      Array.from({ length: LEDGER_PAGE_ROWS + 100 }, (_, n) => ({
        session: `octo~keyset~${n + 1}`,
        at: top + n,
        entry: quiet(),
      })),
    );
    const before = await listOrder();
    const first = v.parse(LedgerPage, await stub.ledgerPage({ state: "all" }));
    const version = (await stub.view()).ledgerVersion;

    // A row after the page moves to the top, and a new row comes before every other.
    await stub.upsertLedger("octo~keyset~50", 2, quiet({ latestEvent: { kind: "question", at: top + 10_000 } }));
    await stub.upsertLedger("octo~keyset~9999", 1, quiet({ latestEvent: { kind: "question", at: top + 10_001 } }));
    expect((await stub.view()).ledgerVersion).toBe(version + 2);
    const rest: LedgerRow[] = [];
    let cursor = first.nextCursor ?? undefined;
    while (cursor !== undefined) {
      const page = v.parse(LedgerPage, await stub.ledgerPage({ cursor, state: "all" }));
      rest.push(...page.rows);
      cursor = page.nextCursor ?? undefined;
    }
    const listed = [...sessionsOf(first.rows), ...sessionsOf(rest)];
    expect(new Set(listed).size).toBe(listed.length);
    const moved = new Set(["octo~keyset~50", "octo~keyset~9999"]);
    expect(listed.filter((name) => !moved.has(name))).toEqual(before.filter((name) => !moved.has(name)));
    // The next pass, which the new version asks for, lists both moved rows first.
    expect(sessionsOf((await ledgerPages())[0]?.rows ?? []).slice(0, 2)).toEqual([
      "octo~keyset~9999",
      "octo~keyset~50",
    ]);
  });

  it("refuses a cursor that names no place in the list", async () => {
    captureLogs();
    const stub = await hub();
    for (const cursor of [
      "x",
      "1",
      "01.octo~a~1",
      "1.hub",
      "-2.octo~a~1",
      "-.octo~a~1",
      "1.octo~a~0",
      "99999999999999999999.octo~a~1",
    ]) {
      expect({ cursor, page: await stub.ledgerPage({ cursor, state: "all" }) }).toEqual({
        cursor,
        page: expect.objectContaining({ error: "bad_request" }),
      });
    }
  });

  it("refuses a page whose first row does not fit, and ends a page before a row that does not", async () => {
    const logs = captureLogs();
    const stub = await hub();
    await storeRows([{ session: "octo~fit~1", at: Number.MAX_SAFE_INTEGER, entry: quiet() }]);
    const [row] = (await ledgerPages())[0]?.rows ?? [];
    const envelope = bytesOf({ rows: [], nextCursor: "x".repeat(MAX_LEDGER_CURSOR_CHARS) });
    const pageBytes = vi.fn<() => number>(() => envelope + bytesOf(row));
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(hubSeams(instance), "ledgerPageBytes").mockImplementation(pageBytes);
    });
    const page = v.parse(LedgerPage, await stub.ledgerPage({ state: "all" }));
    expect(sessionsOf(page.rows)).toEqual(["octo~fit~1"]);
    expect(page.nextCursor).toEqual(expect.any(String));

    pageBytes.mockReturnValue(envelope + bytesOf(row) - 1);
    expect(await stub.ledgerPage({ state: "all" })).toEqual({
      error: "internal",
      detail: "a row does not fit in a page",
    });
    expect(logs.some(({ entry }) => entry["event"] === "prq.page.overflow" && entry["first"] === "octo~fit~1")).toBe(
      true,
    );
  });

  it("lists the first MAX_ROW_CLAIMS of a row's claims", async () => {
    captureLogs();
    const claims = Array.from({ length: MAX_ROW_CLAIMS + 2 }, (_, n) => ({
      agentId: `holder-${n}`,
      jobId: `job-${n}`,
      since: n,
      ageMs: 0,
    }));
    await (await hub()).upsertLedger("octo~claims~1", 1, quiet({ claims }));
    expect((await ledgerRowOf("octo~claims~1"))?.claims).toEqual(
      claims.slice(0, MAX_ROW_CLAIMS).map(({ agentId, jobId, since }) => ({ agentId, jobId, since })),
    );
  });

  it("pages every present agent once by ID, with its last contact and whether it holds a claim", async () => {
    captureLogs();
    const ids = Array.from({ length: AGENT_PAGE_ROWS + 20 }, (_, n) => `agent-${String(n).padStart(3, "0")}`);
    await setPool(ids.toReversed());
    const stub = await hub();
    // An agent present only by its claim, one whose claim no longer makes it present, the agent at the first page's end
    // holding a claim too, and one whose presence has ended.
    const claims = [
      { agentId: "zz-holder", jobId: "job-1", since: 0, ageMs: 60_000 },
      { agentId: "zz-old", jobId: "job-2", since: 0, ageMs: STALL_MS + PRESENCE_MS },
      { agentId: "agent-100", jobId: "job-3", since: 0, ageMs: 60_000 },
    ];
    await stub.upsertLedger("octo~agents~1", 1, quiet({ claims }));
    await setLastSeen("agent-000", Date.now() - PRESENCE_MS);
    const pages = await agentPages();
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page.rows.length).toBeLessThanOrEqual(AGENT_PAGE_ROWS);
      expect(bytesOf(page)).toBeLessThanOrEqual(AGENT_PAGE_BYTES);
    }
    const rows = pages.flatMap((page) => page.rows);
    expect(rows.map((row) => row.agentId)).toEqual([...ids.slice(1), "zz-holder"]);
    expect(rows[0]).toEqual({ agentId: "agent-001", lastSeenAt: expect.any(Number), waiting: false, holdsJob: false });
    expect(rows.at(-1)).toEqual({ agentId: "zz-holder", lastSeenAt: null, waiting: false, holdsJob: true });
    expect(pages[0]?.rows.at(-1)).toMatchObject({ agentId: "agent-100", holdsJob: true });
    expect((await stub.view()).presentAgents).toBe(rows.length);
  });

  it("shows an agent as waiting while its wait lasts", async () => {
    captureLogs();
    await setPool([]);
    const timers = await controlWaitTimers();
    const wait = tracked(waitOver(await hostToken(), "sleeper", 20_000));
    await timers.started();
    // The page is read while the wait is held in the Hub. The wait alone keeps the agent present, whatever its last
    // contact, and a page after it does not list it again.
    expect(await agentRow("sleeper")).toMatchObject({ waiting: true });
    await setLastSeen("sleeper", Date.now() - PRESENCE_MS);
    expect(await agentRow("sleeper")).toMatchObject({ waiting: true });
    expect(v.parse(AgentPage, await (await hub()).agentPage("sleeper")).rows).toEqual([]);
    expect(wait.settled()).toBe(false);
    await timers.expire();
    expect(await waitStatus(wait.promise)).toBe("timeout");
    expect(await agentRow("sleeper")).toMatchObject({ waiting: false });
  });

  it("reads no agent whose presence ended, nor a past claim of a present agent or another, on a contact or a pool page", async () => {
    captureLogs();
    // A Hub of its own, with one agent present by its contact and one by its claim.
    const stub = await getAgentByName(env.Hub, "pool-scan");
    await stub.touch("desk");
    await stub.upsertLedger(
      "octo~pool~1",
      1,
      quiet({ claims: [{ agentId: "laptop", jobId: "j1", since: 0, ageMs: 0 }] }),
    );
    const { before, after, plans } = await runInDurableObject(stub, async (instance, state) => {
      const { sql } = state.storage;
      const contactAndPage = async () => {
        const contact = await reading(sql, () => instance.touch("desk"));
        const page = await reading(sql, () => instance.agentPage());
        // The rows as they stay from one contact to the next (a contact moves desk's last one).
        const listed = v
          .parse(AgentPage, page.value)
          .rows.map(({ lastSeenAt, ...row }) => ({ ...row, seen: lastSeenAt !== null }));
        return {
          reads: { contact: contact.read, page: page.read },
          listed,
          queries: [...contact.queries, ...page.queries],
        };
      };
      // Claims made long ago, never retried, each in a session of its own: of an agent last seen as long ago, and of
      // each present agent. One of each, then STALE_AGENTS. The presence alarm is armed by the contacts above, so each
      // contact below does the same.
      const stale = (from: number, to: number) => {
        for (let n = from; n < to; n += 1) {
          sql.exec("INSERT INTO prq_agents (agent_id, last_seen_at) VALUES (?, ?)", `stale-${n}`, n);
          for (const agentId of [`stale-${n}`, "desk", "laptop"]) {
            sql.exec(
              "INSERT INTO prq_claims (session, job_id, agent_id, claimed_at) VALUES (?, 'j', ?, ?)",
              `octo~old-${agentId}~${n + 1}`,
              agentId,
              n,
            );
          }
        }
      };
      stale(0, 1);
      const ready = await contactAndPage();
      stale(1, STALE_AGENTS);
      const loaded = await contactAndPage();
      const details = loaded.queries
        .filter(([query]) => /\bprq_(?:agents|claims)\b/.test(query))
        .flatMap(([query, ...bindings]) =>
          sql
            .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...bindings)
            .toArray()
            .map((row) => row.detail),
        );
      return { before: ready, after: loaded, plans: [...new Set(details)].toSorted() };
    });
    // Both hold a claim (desk only one from long ago); only desk has a contact.
    const rows = [
      { agentId: "desk", waiting: false, holdsJob: true, seen: true },
      { agentId: "laptop", waiting: false, holdsJob: true, seen: false },
    ];
    expect(before.listed).toEqual(rows);
    expect(after.listed).toEqual(rows);
    expect(before.reads.contact).toBeGreaterThan(0);
    expect(after.reads).toEqual(before.reads);
    // Each read of the pool's tables is a range of an index: the present agents' contacts and claims by their time, then
    // each present agent's contact by its ID and its latest claim.
    expect(plans).toEqual([
      "SEARCH prq_agents USING INDEX prq_agents_seen (last_seen_at>?)",
      "SEARCH prq_agents USING INDEX sqlite_autoindex_prq_agents_1 (agent_id=?)",
      "SEARCH prq_claims USING COVERING INDEX prq_claims_agent_claimed (agent_id=?)",
      "SEARCH prq_claims USING INDEX prq_claims_claimed (claimed_at>?)",
    ]);
  });

  it("lists every repository once by owner/name for the menu, in its display case, and counts the owners", async () => {
    captureLogs();
    const stub = await hub();
    const owners = (await stub.view()).owners;
    // More repositories than a page holds, of an owner the ledger has no row of yet.
    await runInDurableObject(stub, async (instance) => {
      for (let n = 0; n < REPO_PAGE_ROWS + 5; n += 1) {
        await instance.upsertLedger(`menu~r${String(n).padStart(3, "0")}~1`, 1, quiet());
      }
    });
    expect((await stub.view()).owners).toBe(owners + 1);
    // GitHub's display case once an entry gives it for the repository, and not a name of another repository.
    await stub.upsertLedger("menu~r000~1", 2, quiet({ details: { ...largeDetails("Menu/R000"), title: "t" } }));
    await stub.upsertLedger("menu~r001~1", 2, quiet({ details: { ...largeDetails("Menu/Renamed"), title: "t" } }));

    const pages = await repoPages();
    for (const page of pages) {
      expect(page.rows.length).toBeLessThanOrEqual(REPO_PAGE_ROWS);
      expect(bytesOf(page)).toBeLessThanOrEqual(REPO_PAGE_BYTES);
    }
    const listed = pages.flatMap((page) => page.rows.map((row) => row.fullName));
    const sessions = await runInDurableObject(stub, (_, state) =>
      state.storage.sql.exec<{ session: string }>("SELECT session FROM prq_ledger").toArray(),
    );
    const repos = [...new Set(sessions.map(({ session }) => session.split("~").slice(0, 2).join("/")))].toSorted();
    expect(listed.map((name) => name.toLowerCase())).toEqual(repos);
    expect(listed).toContain("Menu/R000");
    expect(listed).toContain("menu/r001");
    expect((await stub.view()).owners).toBe(new Set(repos.map((repo) => repo.split("/")[0])).size);
  });
});

describe("failure paths", () => {
  it("refuses an entry for a name that is not a session's, or not in the entry's shape", async () => {
    const logs = captureLogs();
    const stub = await hub();
    await stub.upsertLedger("hub", 1, quiet());
    const malformed: unknown = { ...quiet(), claims: "none" };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the shape is what is tested
    await stub.upsertLedger("octo~refused~1", 1, malformed as LedgerEntry);
    // An event time a page's cursor could not carry.
    await stub.upsertLedger("octo~refused~2", 1, quiet({ latestEvent: { kind: "question", at: 1.5 } }));
    // A job count the totals could not add up.
    await stub.upsertLedger("octo~refused~3", 1, quiet({ jobs: { waiting: -1, running: 0, failed: 0 } }));
    expect(await stored("hub")).toBeUndefined();
    expect(await stored("octo~refused~1")).toBeUndefined();
    expect(await stored("octo~refused~2")).toBeUndefined();
    expect(await stored("octo~refused~3")).toBeUndefined();
    expect(logs.filter((log) => log.entry["event"] === "prq.hub.ledger_refused")).toHaveLength(4);
  });

  it("does not show a contact whose presence alarm cannot be scheduled; a retry or the Hub's start arms it, on time", async () => {
    captureLogs();
    const clock = hubClock();
    await (await hub()).upsertLedger("octo~alarm~1", 1, quiet({ waitingWork: true }));
    await setPool([]);
    let stub = await hub();
    await stub.presenceEnded();
    await cancelHubSchedules();
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(instance, "schedule").mockRejectedValueOnce(new Error("storage failed"));
    });
    // An RPC call's promise, wrapped: reading a property of it would make a pipelined call that fails unhandled.
    await expect(Promise.resolve(stub.touch("desk"))).rejects.toThrow("storage failed");
    // Not acknowledged, and not shown: nothing is armed to end the presence.
    expect(await presenceAlarms()).toEqual([]);
    expect((await published())?.localAgentPresent).toBe(false);

    // The agent's retry arms the alarm at desk's presence end, and the view shows desk.
    await stub.touch("desk");
    expect(await presenceAlarms()).toEqual([Math.ceil((clock.now() + PRESENCE_MS) / 1000)]);
    expect((await published())?.presentAgents).toBe(1);

    // The alarm is lost and desk's presence now ends a second ahead, at a time with a millisecond part. The Hub's
    // start arms it again, and when it runs the row needs a local agent.
    await cancelHubSchedules();
    const end = clock.now() + 1000;
    await setLastSeen("desk", end - PRESENCE_MS);
    await abortAllDurableObjects();
    stub = await hub();
    expect(await stub.isLocalPresent()).toBe(true);
    expect(await presenceAlarms()).toEqual([Math.ceil(end / 1000)]);
    expect((await ledgerRowOf("octo~alarm~1"))?.problem).toBeNull();
    await runPresenceEnded(clock);
    expect(await presenceAlarms()).toEqual([]);
    expect((await published())?.localAgentPresent).toBe(false);
    expect((await ledgerRowOf("octo~alarm~1"))?.problem).toBe("waiting_for_local_agent");
  });

  it("does not acknowledge a contact whose view cannot be set, and the retry sets it", async () => {
    captureLogs();
    await setPool([]);
    const stub = await hub();
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(instance, "setState").mockImplementationOnce(() => {
        throw new Error("storage failed");
      });
    });
    await expect(Promise.resolve(stub.touch("lamp"))).rejects.toThrow("storage failed");
    expect((await published())?.presentAgents).toBe(0);
    await stub.touch("lamp");
    expect((await published())?.presentAgents).toBe(1);
  });
});
