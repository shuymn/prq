import { type HubView, type Job, type LedgerRow, sessionName, SubmitResponse } from "@prq/protocol";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Hub } from "./hub.ts";
import { LedgerEntry, PRESENCE_MS, STALL_MS } from "./ledger.ts";
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

function rowOf(view: HubView | undefined, name: string): LedgerRow | undefined {
  return view?.prs.find((row) => sessionName(row.pr) === name);
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

describe("view broadcasts", () => {
  it("broadcasts the view only when it changed, and refuses a client's state update", async () => {
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

    // Neither call changes the view: a presence check with nothing ended, and a redelivery of the stored entry.
    await (await hub()).presenceEnded();
    await (await hub()).upsertLedger("octo~view~1", 1, quiet());
    const entry = await stored("octo~view~1");
    await (await hub()).upsertLedger("octo~view~1", 1, quiet());
    expect(await stored("octo~view~1")).toEqual(entry);
    // The ledger row above was a change: one broadcast. The next change's view is the very next frame after it.
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
    expect(rowOf(await published(), name)?.claims).toEqual([expect.objectContaining({ agentId: "laptop" })]);
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
    const names = (await published())?.prs.map((row) => sessionName(row.pr)).filter((name) => name.includes("order"));
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
    expect(rowOf(await published(), name)).toMatchObject({ problem: "answer_failed", jobs: { failed: 1 } });

    // The retry hands the job to the cloud agent: it runs, and its failure is not resolved.
    const started = await withCloudAgent(stub);
    await retryIn(stub, failed?.jobId ?? "");
    expect(started).toEqual([failed?.jobId]);
    expect(rowOf(await published(), name)).toMatchObject({
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
    expect(rowOf(await published(), name)).toMatchObject({ problem: null, latestEvent: { kind: "answer" } });
  });

  it("shows Summary failed for the current head's failed analysis only, until it completes", async () => {
    captureLogs();
    const { stub, name, ref } = await cloudSession();
    await push(ref, "A");
    expect(rowOf(await published(), name)?.problem).toBe("summary_failed");

    // A newer head's analysis runs: the failed one is an older head's, and the new head has no summary yet.
    await withCloudAgent(stub);
    await push(ref, "B");
    expect(rowOf(await published(), name)?.problem).toBe("new_push_not_summarized");

    // A's analysis, retried while its head is not current, is superseded; it fails no less until it completes, so a
    // push back to A shows it again (revived, waiting behind B's running analysis).
    const a = (await stub.view()).jobs.find((job) => job.target.kind === "analysis" && job.target.headSha === sha("A"));
    expect(await retryIn(stub, a?.jobId ?? "")).toEqual({ status: "superseded" });
    expect(rowOf(await published(), name)?.problem).toBe("new_push_not_summarized");
    await push(ref, "A");
    expect((await stub.view()).jobs.find((job) => job.jobId === a?.jobId)?.state).toBe("pending");
    expect(rowOf(await published(), name)?.problem).toBe("summary_failed");
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
    expect(rowOf(await published(), name)).toMatchObject({ problem: null, jobs: { waiting: 1 } });

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
    expect(rowOf(await published(), name)?.problem).toBeNull();

    await reach(Math.ceil(end / 1000) * 1000);
    await runDurableObjectAlarm(stub);
    const lapsed = await published();
    expect(lapsed?.localAgentPresent).toBe(false);
    expect(rowOf(lapsed, name)?.problem).toBe("waiting_for_local_agent");
    expect(lapsed?.needsAttention).toBeGreaterThanOrEqual(1);

    expect(await waitStatus(waitOver(token, "laptop"))).toBe("ready");
    const back = await published();
    expect(back?.localAgentPresent).toBe(true);
    expect(rowOf(back, name)?.problem).toBeNull();
  }, 10_000);
});

describe("presence from claims", () => {
  it("keeps an agent with a held claim present past its last contact, until STALL_MS + PRESENCE_MS after the claim", async () => {
    captureLogs();
    const { token } = await localSession("ledger", sockets, Q1);
    await claimOver(token, "laptop");

    await lastSeenAgo(PRESENCE_MS + 1);
    expect(await localPresent()).toBe(true);
    expect((await (await hub()).view()).agents).toEqual([
      expect.objectContaining({ agentId: "laptop", waiting: false, holdsJob: true }),
    ]);
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
    expect(rowOf(await published(), name)?.problem).toBe("possibly_stalled");
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

describe("failure paths", () => {
  it("refuses an entry for a name that is not a session's, or not in the entry's shape", async () => {
    const logs = captureLogs();
    const stub = await hub();
    await stub.upsertLedger("hub", 1, quiet());
    const malformed: unknown = { ...quiet(), claims: "none" };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the shape is what is tested
    await stub.upsertLedger("octo~refused~1", 1, malformed as LedgerEntry);
    expect(await stored("hub")).toBeUndefined();
    expect(await stored("octo~refused~1")).toBeUndefined();
    expect(logs.filter((log) => log.entry["event"] === "prq.hub.ledger_refused")).toHaveLength(2);
  });

  it("keeps a contact whose presence alarm cannot be scheduled, and arms it at the next change", async () => {
    const logs = captureLogs();
    await setPool([]);
    const stub = await hub();
    const alarms = () =>
      runInDurableObject(stub, async (instance) =>
        (await instance.listSchedules()).filter((schedule) => schedule.callback === "presenceEnded"),
      );
    await runInDurableObject(stub, async (instance) => {
      for (const schedule of await instance.listSchedules()) {
        await instance.cancelSchedule(schedule.id);
      }
      vi.spyOn(instance, "schedule").mockRejectedValueOnce(new Error("storage failed"));
    });
    await stub.touch("desk");
    expect(logs.some((log) => log.entry["event"] === "prq.hub.presence_alarm_failed")).toBe(true);
    expect(await stub.isLocalPresent()).toBe(true);
    expect(await alarms()).toEqual([]);

    await stub.touch("desk");
    expect(await alarms()).toHaveLength(1);
  });

  it("keeps a contact whose view cannot be set, and sets the view at the next change", async () => {
    const logs = captureLogs();
    await setPool([]);
    const stub = await hub();
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(instance, "setState").mockImplementationOnce(() => {
        throw new Error("storage failed");
      });
    });
    await stub.touch("lamp");
    expect(logs.some((log) => log.entry["event"] === "prq.hub.view_failed")).toBe(true);
    expect((await published())?.agents.map((agent) => agent.agentId)).not.toContain("lamp");
    await stub.presenceEnded();
    expect((await published())?.agents.map((agent) => agent.agentId)).toContain("lamp");
  });
});
