import {
  type HubView,
  type Job,
  LEDGER_PAGE_BYTES,
  LEDGER_PAGE_ROWS,
  LedgerPage,
  type LedgerRow,
  MAX_LEDGER_CURSOR_CHARS,
  MAX_TITLE_CHARS,
  MAX_VIEW_AGENTS,
  sessionName,
  SubmitResponse,
} from "@prq/protocol";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Hub } from "./hub.ts";
import { LedgerEntry, needsAttention, PRESENCE_MS, STALL_MS } from "./ledger.ts";
import type { PrSession } from "./pr-session/index.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, connect, hostToken, question } from "./test/chat.ts";
import {
  accepted,
  claimedAgo,
  claimOver,
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

// Waits in real time until Date.now() reaches `at` (alarms run at whole seconds).
async function reach(at: number): Promise<void> {
  while (Date.now() < at) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The next whole second's time plus `ms`: a time with a millisecond part, a moment ahead.
function nextSecondPlus(ms: number): number {
  return (Math.floor(Date.now() / 1000) + 1) * 1000 + ms;
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

async function lastSeenOf(agentId: string): Promise<number> {
  return runInDurableObject(
    await hub(),
    (_, state) =>
      state.storage.sql
        .exec<{ at: number }>("SELECT last_seen_at AS at FROM prq_agents WHERE agent_id = ?", agentId)
        .one().at,
  );
}

// Stores rows in the Hub's ledger as they are, with nothing that needs attention: many rows at once, as a long-lived
// ledger holds them.
async function storeRows(rows: { session: string; at: number | null; entry: LedgerEntry }[]): Promise<void> {
  await runInDurableObject(await hub(), (_, state) => {
    for (const { session, at, entry } of rows) {
      state.storage.sql.exec(
        `INSERT INTO prq_ledger (session, rev, latest_event_at, entry, attention_present, attention_absent)
         VALUES (?, 1, ?, ?, 0, 0)`,
        session,
        at,
        JSON.stringify({ ...entry, latestEvent: at === null ? null : { kind: "push", at } }),
      );
    }
  });
}

// Every page of the ledger, from the first.
async function ledgerPages(): Promise<LedgerPage[]> {
  const pages: LedgerPage[] = [];
  let cursor: string | undefined;
  do {
    const page = v.parse(LedgerPage, await (await hub()).ledgerPage(cursor));
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return pages;
}

// The list's order (docs/design.md, PR ledger) of every stored row: latest event first, rows without one last, then the
// session name.
async function listOrder(): Promise<string[]> {
  const rows = await runInDurableObject(await hub(), (_, state) =>
    state.storage.sql
      .exec<{ session: string; at: number | null }>("SELECT session, latest_event_at AS at FROM prq_ledger")
      .toArray(),
  );
  return rows
    .toSorted((a, b) => rank(b.at) - rank(a.at) || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0))
    .map((row) => row.session);
}

function rank(at: number | null): number {
  return at ?? Number.NEGATIVE_INFINITY;
}

// The rows needing attention as their problems say.
async function attentionRows(): Promise<number> {
  return (await ledgerRows()).filter((row) => needsAttention(row.problem)).length;
}

function sessionsOf(rows: readonly LedgerRow[]): string[] {
  return rows.map((row) => sessionName(row.pr));
}

const utf8 = new TextEncoder();

function bytesOf(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).length;
}

// Details at their largest in bytes: a title of MAX_TITLE_CHARS characters of 3 bytes each.
function largeDetails(name: string): LedgerEntry["details"] {
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
    const viewWith = (agentId: string, from: number) =>
      socket.next((frame) => frame["type"] === "cf_agent_state" && JSON.stringify(frame).includes(agentId), from);

    let from = socket.frames.length;
    await (await hub()).touch("desk");
    await viewWith("desk", from);
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
    await viewWith("shelf", from);
    expect(states()).toBe(changed + 2);

    const before = await published();
    from = socket.frames.length;
    socket.send({ type: "cf_agent_state", state: { ...before, localAgentPresent: false, agents: [] } });
    await socket.next((frame) => frame["type"] === "cf_agent_state_error", from);
    expect(await published()).toEqual(before);
    expect(logs.some((log) => log.entry["event"] === "prq.state.refused")).toBe(true);
  });
});

// An entry with nothing to show.
function quiet(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    details: null,
    owner: "local",
    latestEvent: null,
    summaryFailed: false,
    answerFailed: false,
    stalled: false,
    waitingWork: false,
    unsummarized: false,
    jobs: { waiting: 0, running: 0, failed: 0 },
    claims: [],
    ...overrides,
  };
}

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
    expect(await ledgerRowOf(name)).toMatchObject({
      problem: "answer_failed",
      jobs: { failed: 0, running: 1 },
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
    expect(await ledgerRowOf(name)).toMatchObject({ problem: null, latestEvent: { kind: "answer" } });
  });

  it("shows Summary failed for the current head's failed analysis only, until it completes", async () => {
    captureLogs();
    const { stub, name, ref } = await cloudSession();
    await push(ref, "A");
    expect((await ledgerRowOf(name))?.problem).toBe("summary_failed");

    // A newer head's analysis runs: the failed one is an older head's, and the new head has no summary yet.
    await withCloudAgent(stub);
    await push(ref, "B");
    expect((await ledgerRowOf(name))?.problem).toBe("new_push_not_summarized");

    // A's analysis, retried while its head is not current, is superseded; it fails no less until it completes, so a
    // push back to A shows it again (revived, waiting behind B's running analysis).
    const a = (await stub.view()).jobs.find((job) => job.target.kind === "analysis" && job.target.headSha === sha("A"));
    expect(await retryIn(stub, a?.jobId ?? "")).toEqual({ status: "superseded" });
    expect((await ledgerRowOf(name))?.problem).toBe("new_push_not_summarized");
    await push(ref, "A");
    expect((await stub.view()).jobs.find((job) => job.jobId === a?.jobId)?.state).toBe("pending");
    expect((await ledgerRowOf(name))?.problem).toBe("summary_failed");
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

    // laptop's presence now ends a moment ahead, at a time with a millisecond part.
    const end = nextSecondPlus(600);
    await setLastSeen("laptop", end - PRESENCE_MS);
    const stub = await hub();
    await stub.presenceEnded();
    const armed = await runInDurableObject(stub, async (instance) =>
      (await instance.listSchedules()).filter(
        (schedule) => schedule.callback === "presenceEnded" && schedule.time * 1000 <= end + 1000,
      ),
    );
    expect(armed.map((schedule) => schedule.time)).toEqual([Math.ceil(end / 1000)]);
    expect((await ledgerRowOf(name))?.problem).toBeNull();

    await reach(Math.ceil(end / 1000) * 1000);
    await runDurableObjectAlarm(stub);
    const lapsed = await published();
    expect(lapsed?.localAgentPresent).toBe(false);
    expect((await ledgerRowOf(name))?.problem).toBe("waiting_for_local_agent");
    expect(lapsed?.needsAttention).toBeGreaterThanOrEqual(1);

    expect(await waitStatus(waitOver(token, "laptop"))).toBe("ready");
    const back = await published();
    expect(back?.localAgentPresent).toBe(true);
    expect((await ledgerRowOf(name))?.problem).toBeNull();
  }, 10_000);
});

describe("presence from claims", () => {
  it("keeps an agent with a held claim present past its last contact, until STALL_MS + PRESENCE_MS after the claim", async () => {
    captureLogs();
    const { token } = await localSession("ledger", sockets, Q1);
    await claimOver(token, "laptop");

    await lastSeenAgo(PRESENCE_MS + 1);
    expect(await localPresent()).toBe(true);
    expect((await (await hub()).view()).agents).toEqual([{ agentId: "laptop", holdsJob: true }]);
    await claimedAgo(STALL_MS + PRESENCE_MS - 1000);
    expect(await localPresent()).toBe(true);
    await claimedAgo(STALL_MS + PRESENCE_MS);
    expect(await localPresent()).toBe(false);
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
    const first = v.parse(LedgerPage, await stub.ledgerPage());
    const version = (await stub.view()).ledgerVersion;

    // A row after the page moves to the top, and a new row comes before every other.
    await stub.upsertLedger("octo~keyset~50", 2, quiet({ latestEvent: { kind: "question", at: top + 10_000 } }));
    await stub.upsertLedger("octo~keyset~9999", 1, quiet({ latestEvent: { kind: "question", at: top + 10_001 } }));
    expect((await stub.view()).ledgerVersion).toBe(version + 2);
    const rest: LedgerRow[] = [];
    let cursor = first.nextCursor ?? undefined;
    while (cursor !== undefined) {
      const page = v.parse(LedgerPage, await stub.ledgerPage(cursor));
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
      "-1.octo~a~1",
      "1.octo~a~0",
      "99999999999999999999.octo~a~1",
    ]) {
      expect({ cursor, page: await stub.ledgerPage(cursor) }).toEqual({
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
    const page = v.parse(LedgerPage, await stub.ledgerPage());
    expect(sessionsOf(page.rows)).toEqual(["octo~fit~1"]);
    expect(page.nextCursor).toEqual(expect.any(String));

    pageBytes.mockReturnValue(envelope + bytesOf(row) - 1);
    expect(await stub.ledgerPage()).toEqual({ error: "internal", detail: "a ledger row does not fit in a page" });
    expect(logs.some((log) => log.entry["event"] === "prq.ledger.overflow" && log.entry["pr"] === "octo~fit~1")).toBe(
      true,
    );
  });

  it("counts the rows that need attention as entries change, with a local agent present and without one", async () => {
    captureLogs();
    const stub = await hub();
    const check = async () => {
      await setPool([]);
      expect((await stub.view()).needsAttention).toBe(await attentionRows());
      await setPool(["desk"]);
      expect((await stub.view()).needsAttention).toBe(await attentionRows());
    };
    await stub.upsertLedger("octo~count~1", 1, quiet({ answerFailed: true }));
    await stub.upsertLedger("octo~count~2", 1, quiet({ waitingWork: true }));
    await stub.upsertLedger("octo~count~3", 1, quiet({ unsummarized: true }));
    await stub.upsertLedger("octo~count~4", 1, quiet({ stalled: true, waitingWork: true }));
    await check();
    // A row resolved, a row that fails, and a redelivery that changes nothing.
    await stub.upsertLedger("octo~count~1", 2, quiet());
    await stub.upsertLedger("octo~count~3", 2, quiet({ summaryFailed: true }));
    await stub.upsertLedger("octo~count~4", 1, quiet());
    await check();
  });

  it("lists the first MAX_VIEW_AGENTS present agents by ID, and counts every one", async () => {
    captureLogs();
    const ids = Array.from({ length: MAX_VIEW_AGENTS + 8 }, (_, n) => `agent-${String(n).padStart(2, "0")}`);
    await setPool(ids.toReversed());
    const view = await published();
    expect(view).toMatchObject({ localAgentPresent: true, presentAgents: ids.length });
    expect(view?.agents).toEqual(ids.slice(0, MAX_VIEW_AGENTS).map((agentId) => ({ agentId, holdsJob: false })));
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
    expect(await stored("hub")).toBeUndefined();
    expect(await stored("octo~refused~1")).toBeUndefined();
    expect(await stored("octo~refused~2")).toBeUndefined();
    expect(logs.filter((log) => log.entry["event"] === "prq.hub.ledger_refused")).toHaveLength(3);
  });

  it("does not show a contact whose presence alarm cannot be scheduled; a retry or the Hub's start arms it, on time", async () => {
    captureLogs();
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
    const seen = await lastSeenOf("desk");
    expect(await presenceAlarms()).toEqual([Math.ceil((seen + PRESENCE_MS) / 1000)]);
    expect((await published())?.agents).toEqual([{ agentId: "desk", holdsJob: false }]);

    // The alarm is lost and desk's presence now ends a moment ahead, at a time with a millisecond part. The Hub's start
    // arms it again, and at that second the row needs a local agent.
    await cancelHubSchedules();
    const end = nextSecondPlus(600);
    await setLastSeen("desk", end - PRESENCE_MS);
    await abortAllDurableObjects();
    stub = await hub();
    expect(await stub.isLocalPresent()).toBe(true);
    expect(await presenceAlarms()).toEqual([Math.ceil(end / 1000)]);
    expect((await ledgerRowOf("octo~alarm~1"))?.problem).toBeNull();
    await reach(Math.ceil(end / 1000) * 1000);
    await runDurableObjectAlarm(stub);
    expect((await published())?.localAgentPresent).toBe(false);
    expect((await ledgerRowOf("octo~alarm~1"))?.problem).toBe("waiting_for_local_agent");
  }, 10_000);

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
    expect((await published())?.agents.map((agent) => agent.agentId)).not.toContain("lamp");
    await stub.touch("lamp");
    expect((await published())?.agents.map((agent) => agent.agentId)).toContain("lamp");
  });
});
