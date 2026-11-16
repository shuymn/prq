import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Hub } from "./hub.ts";
import { prSessionStub } from "./names.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import {
  cancelWakes,
  gate,
  hub,
  laterWakes,
  newSession,
  prSessionSeams,
  queued,
  setPool,
  tracked,
  wakes,
} from "./test/session.ts";

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q1 = question("q1");
const Q2 = question("q2");

// Polls only the Hub, never the session, until its queue lists the session.
async function hubLists(name: string, timeout = 10_000): Promise<void> {
  await vi.waitFor(async () => expect(await queued()).toContain(name), { timeout, interval: 200 });
}

// The session's notify row (its ledger row is the ledger tests').
async function outbox(stub: DurableObjectStub) {
  return runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("SELECT kind, gen FROM prq_outbox WHERE kind = 'notify'").toArray(),
  );
}

async function forgetSession(name: string): Promise<void> {
  await runInDurableObject(await hub(), (_, state) => {
    state.storage.sql.exec("DELETE FROM prq_notifications WHERE session = ?", name);
  });
}

describe("wake after stop", () => {
  it("brings a job to the Hub when the session stopped after writing the job and its outbox row", async () => {
    captureLogs();
    await setPool(["laptop"]);
    const { stub, name, open } = await newSession("settle", sockets);
    const client = await open();
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "deliver").mockImplementationOnce(() => held.wait());
    });
    const asked = client.chat([Q1]).catch(() => undefined);
    await held.reached();
    expect(await outbox(stub)).toHaveLength(1);

    await abortAllDurableObjects();
    await asked;
    await hubLists(name);
  }, 20_000);

  it("brings a job to the Hub when the session stopped after storing the question, before its job", async () => {
    captureLogs();
    await setPool(["laptop"]);
    const { stub, name, open } = await newSession("settle", sockets);
    const client = await open();
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "createJobs").mockImplementationOnce(() => held.wait());
    });
    const asked = client.chat([Q1]).catch(() => undefined);
    await held.reached();
    expect((await stub.view()).jobs).toEqual([]);

    await abortAllDurableObjects();
    await asked;
    await hubLists(name);
  }, 20_000);

  it("brings a question to the Hub that arrived while an earlier wake's settle ran, after that settle ended", async () => {
    captureLogs();
    await setPool(["laptop"]);
    const { stub, name, open } = await newSession("settle", sockets);
    const client = await open();
    await client.chat([Q1]);
    await hubLists(name);
    await forgetSession(name);
    // Q1's wake is held after its settle has returned, while its schedule row is still running.
    const settled = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const settle = instance.settle.bind(instance);
      vi.spyOn(instance, "settle").mockImplementationOnce(async () => {
        await settle();
        await settled.wait();
      });
    });
    await vi.waitFor(() => expect(settled.isReached()).toBe(true), { timeout: 10_000, interval: 200 });
    // Q2 is stored and its job written; its inline delivery is held.
    const delivered = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "deliver").mockImplementationOnce(() => delivered.wait());
    });
    const asked = client.chat([Q1, Q2]).catch(() => undefined);
    await delivered.reached();
    await settled.open();
    // The scheduler ends Q1's run: no settle row is due any more.
    await vi.waitFor(
      async () => {
        const due = await runInDurableObject(stub, (instance) =>
          instance.listSchedules({ timeRange: { end: new Date() } }),
        );
        expect(due.filter((schedule) => schedule.callback === "settle")).toEqual([]);
      },
      { timeout: 5000, interval: 100 },
    );

    await abortAllDurableObjects();
    await asked;
    await hubLists(name);
  }, 30_000);
});

describe("failed delivery", () => {
  it("keeps the outbox row of a failed delivery, and the wake delivers it", async () => {
    const logs = captureLogs();
    await setPool(["laptop"]);
    const { stub, name, open } = await newSession("settle", sockets);
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "deliver").mockRejectedValueOnce(new Error("Hub unreachable"));
    });
    const client = await open();
    await client.chat([Q1]);
    expect(logs.some((log) => log.entry["event"] === "prq.outbox.failed")).toBe(true);
    expect(await outbox(stub)).toHaveLength(1);
    expect(await queued()).not.toContain(name);

    await hubLists(name);
    await vi.waitFor(async () => expect(await outbox(stub)).toEqual([]), { timeout: 2000 });
  }, 20_000);

  it("keeps one scheduled settle while the Hub keeps failing across restarts, and none once it recovers", async () => {
    captureLogs();
    await setPool(["laptop"]);
    const { ref, name, open } = await newSession("settle", sockets);
    // The Hub fails every notify. RPC calls a method from the class, so the spy is on the prototype, which outlives
    // the instance resets.
    const notify = vi.spyOn(Hub.prototype, "notify").mockImplementation(() => {
      throw new Error("Hub down");
    });
    const client = await open();
    await client.chat([Q1]);
    const session = () => prSessionStub(env, ref);
    expect(await wakes(await session())).toBe(1);

    for (let round = 0; round < 4; round += 1) {
      await abortAllDurableObjects();
      // A view read restarts the session: its start settles, and the delivery fails again.
      await (await session()).view();
      expect(await wakes(await session())).toBe(1);
    }
    // The wake fires and fails: it is replaced by one retry.
    const first = await runInDurableObject(
      await session(),
      async (instance) => (await instance.listSchedules())[0]?.id,
    );
    await vi.waitFor(
      async () => {
        const ids = (await runInDurableObject(await session(), (instance) => instance.listSchedules())).map(
          (s) => s.id,
        );
        expect(ids).toHaveLength(1);
        expect(ids).not.toContain(first);
      },
      { timeout: 10_000, interval: 200 },
    );
    expect(await queued()).not.toContain(name);

    notify.mockRestore();
    await hubLists(name, 15_000);
    await vi.waitFor(async () => expect(await wakes(await session())).toBe(0), { timeout: 5000, interval: 200 });
  }, 40_000);

  it("arms one retry when two failed deliveries overlap", async () => {
    captureLogs();
    await setPool(["laptop"]);
    const { stub, open } = await newSession("settle", sockets);
    const client = await open();
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "deliver").mockResolvedValueOnce(undefined);
    });
    await client.chat([Q1]);
    await cancelWakes(stub);
    expect(await outbox(stub)).toHaveLength(1);
    // Both deliveries fail; the first is held between its check for a later wake and its schedule.
    const held = await gate(stub);
    const checks: number[] = [];
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "deliver").mockRejectedValue(new Error("Hub unreachable"));
      const list = instance.listSchedules.bind(instance);
      vi.spyOn(instance, "listSchedules").mockImplementation(async (criteria) => {
        checks.push(Date.now());
        return list(criteria);
      });
      const schedule = instance.schedule.bind(instance);
      vi.spyOn(instance, "schedule").mockImplementationOnce(async (...args) => {
        await held.wait();
        return schedule(...args);
      });
    });
    const first = tracked(stub.settle());
    await held.reached();
    const second = tracked(stub.settle());
    // The session keeps serving while the first failure is held between its check and its schedule.
    expect((await stub.view()).jobs).toHaveLength(1);
    expect(first.settled()).toBe(false);
    await held.open();
    await Promise.all([first.promise, second.promise]);

    // Both failures checked for a later wake; only one armed it.
    expect(checks).toHaveLength(2);
    expect(await laterWakes(stub)).toBe(1);
  });
});

describe("failed retry", () => {
  it("logs a retry that cannot be scheduled and keeps the outbox row for the next start", async () => {
    const logs = captureLogs();
    await setPool(["laptop"]);
    const { stub, open } = await newSession("settle", sockets);
    const client = await open();
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "deliver").mockResolvedValueOnce(undefined);
    });
    await client.chat([Q1]);
    await cancelWakes(stub);
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "deliver").mockRejectedValueOnce(new Error("Hub unreachable"));
      vi.spyOn(instance, "schedule").mockRejectedValueOnce(new Error("storage failed"));
    });

    await stub.settle();
    expect(logs.some((log) => log.entry["event"] === "prq.outbox.retry_failed")).toBe(true);
    expect(await outbox(stub)).toHaveLength(1);
    expect(await wakes(stub)).toBe(0);
  });
});

describe("generations survive re-creation", () => {
  it("does not let an older delivery delete the outbox row written again after it read", async () => {
    captureLogs();
    await setPool(["laptop"]);
    const { stub, open } = await newSession("settle", sockets);
    // Delivery 1 (Q1's, inline) is held in the Hub, after it read its row.
    const inHub = await gate(await hub());
    await runInDurableObject(await hub(), (instance) => {
      const notify = instance.notify.bind(instance);
      vi.spyOn(Hub.prototype, "notify").mockImplementationOnce(async (session) => {
        await inHub.wait();
        notify(session);
      });
    });
    const client = await open();
    const asked = tracked(client.chat([Q1]));
    await inHub.reached();
    const [read] = await outbox(stub);
    // Delivery 2 delivers that row and deletes it.
    await stub.settle();
    expect(await outbox(stub)).toEqual([]);
    // Q2 is stored meanwhile (its turn waits behind Q1's); settle makes its job and writes the row again, while the
    // session's own deliveries are skipped.
    const other = await open();
    const second = other.chat([Q1, Q2]).catch(() => undefined);
    await other.received(Q2.id);
    let skipped: { mockRestore(): void } | null = null;
    await runInDurableObject(stub, (instance) => {
      skipped = vi.spyOn(prSessionSeams(instance), "deliver").mockResolvedValue(undefined);
    });
    await stub.settle();
    const [written] = await outbox(stub);
    expect(Number(written?.["gen"])).toBeGreaterThan(Number(read?.["gen"]));

    await inHub.open();
    await asked.promise;
    expect(await outbox(stub)).toEqual([written]);
    await runInDurableObject(stub, () => skipped?.mockRestore());
    await second;
    await stub.settle();
    expect(await outbox(stub)).toEqual([]);
  });
});
