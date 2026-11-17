import type { PrRef } from "@prq/protocol";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrSession } from "./pr-session/index.ts";
import { captureLogs, events, type LogEntry } from "./test/access.ts";
import type { AgentSocket } from "./test/chat.ts";
import { failure, type GithubReply, pull, serveGithub, useGithubApp } from "./test/github.ts";
import {
  cancelWakes,
  type Gate,
  gate,
  jobRows,
  laterWakes,
  newSession,
  setPool,
  tracked,
  within,
} from "./test/session.ts";
import { deliver, pullRequestEvent, push, sha, takeIn } from "./test/webhook.ts";

// Head reconciliation's fixed examples (docs/design.md, Intake): the marks pushes set and clear, and what a read of
// GitHub's head adopts, discards or counts as a failed try. GitHub is served by a fetch spy (src/test/github.ts).

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

// GitHub's seconds, as the events and the answers carry them.
function second(n: number): number {
  return Date.UTC(2026, 10, 2) + n * 1000;
}

type Reconcile = {
  head_sha: string | null;
  head_at: number | null;
  reconcile_at: number | null;
  push_gen: number;
  reconcile_tries: number;
};

async function reconcileRow(stub: DurableObjectStub<PrSession>): Promise<Reconcile> {
  return runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<Reconcile>(
        "SELECT head_sha, head_at, reconcile_at, push_gen, reconcile_tries FROM prq_session WHERE id = 1",
      )
      .one(),
  );
}

// A local session (no model is called), with the GitHub App when `app`, and the served API.
async function session({ app = true } = {}) {
  const logs = captureLogs();
  await setPool(["laptop"]);
  const created = await newSession("reconcile", sockets);
  if (app) {
    await useGithubApp(created.stub);
  }
  return { ...created, api: serveGithub(), logs };
}

// A push stored in the inbox and not yet taken in (the wake it arms is what takes it in).
async function store(ref: PrRef, label: string, at: number, before?: string): Promise<void> {
  const event = pullRequestEvent(ref, {
    head: sha(label),
    at,
    ...(before === undefined ? {} : { before: sha(before) }),
  });
  const res = await deliver({ body: JSON.stringify(event) });
  expect(res.status).toBe(200);
}

// A read reply held until the gate opens.
function held(hold: Gate, reply: GithubReply): GithubReply {
  return async (signal) => {
    await hold.wait();
    return reply(signal);
  };
}

async function analyses(stub: DurableObjectStub<PrSession>) {
  return (await jobRows(stub)).filter((row) => row.kind === "analysis").map((row) => [row.target, row.state]);
}

// A session's log events, without the event name and the session.
function logged(logs: LogEntry[], event: string) {
  return events(logs, event).map((entry) => {
    const fields = { ...entry };
    delete fields["event"];
    delete fields["pr"];
    return fields;
  });
}

describe("marks", () => {
  it("marks a same-second push kept out or moving the head, and clears the mark at a later second", async () => {
    const { ref, stub } = await session({ app: false });
    await push(ref, "A", { at: second(100) });
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("A"), reconcile_at: null, push_gen: 1 });

    // Kept out: nothing links X to A.
    await push(ref, "X", { at: second(100) });
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("A"), reconcile_at: second(100), push_gen: 2 });
    // Moving the head through `before` is a tie too.
    await push(ref, "B", { at: second(100), before: sha("A") });
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("B"), reconcile_at: second(100), push_gen: 3 });

    await push(ref, "C", { at: second(101), before: sha("B") });
    expect(await reconcileRow(stub)).toEqual({
      head_sha: sha("C"),
      head_at: second(101),
      reconcile_at: null,
      push_gen: 4,
      reconcile_tries: 0,
    });
    // An older second marks nothing: it is no tie with the head.
    await push(ref, "D", { at: second(100) });
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("C"), reconcile_at: null, push_gen: 5 });
  });

  it("leaves no mark for a same-second push of the current head", async () => {
    const { ref, stub } = await session({ app: false });
    await push(ref, "A", { at: second(100) });
    await push(ref, "A", { at: second(100) });
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("A"), reconcile_at: null, push_gen: 2 });
  });

  it("reads nothing without the App or an installation; the mark waits for the next push", async () => {
    const without = await session({ app: false });
    await push(without.ref, "A", { at: second(100) });
    await push(without.ref, "X", { at: second(100) });
    await takeIn(without.ref);
    expect(without.api.requests).toEqual([]);

    const noInstallation = await session();
    for (const [label, at] of [
      ["A", 100],
      ["X", 100],
    ] as const) {
      const event = pullRequestEvent(noInstallation.ref, { head: sha(label), at: second(at), installation: null });
      await deliver({ body: JSON.stringify(event) });
      await takeIn(noInstallation.ref);
    }
    expect(await reconcileRow(noInstallation.stub)).toMatchObject({ reconcile_at: second(100) });
    expect(noInstallation.api.requests).toEqual([]);
  });
});

describe("adopting GitHub's head", () => {
  it("ends a same-second A, B, A, B whose middle A is taken in last at GitHub's head", async () => {
    const { ref, stub, api } = await session();
    // GitHub's order is A, B, A, B, all within second 100; every read answers its current state.
    api.reply(pull(sha("B"), second(100)), pull(sha("B"), second(100)));
    await push(ref, "A", { at: second(100) });
    await push(ref, "B", { at: second(100), before: sha("A") });
    await push(ref, "B", { at: second(100), before: sha("A") });
    await push(ref, "A", { at: second(100), before: sha("B") });

    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("B"), head_at: second(100), reconcile_at: null });
    expect(api.reads()).toHaveLength(2);
    expect(await analyses(stub)).toEqual([
      [sha("A"), "superseded"],
      [sha("B"), "pending"],
    ]);
  });

  it("ends a same-second A, B, C whose B is lost at GitHub's head, with C's analysis", async () => {
    const { ref, stub, api } = await session();
    api.reply(pull(sha("C"), second(100)));
    await push(ref, "A", { at: second(100) });
    await push(ref, "C", { at: second(100), before: sha("B") });

    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("C"), reconcile_at: null });
    expect(await analyses(stub)).toEqual([
      [sha("A"), "superseded"],
      [sha("C"), "pending"],
    ]);
    expect((await stub.view()).details?.headSha).toBe(sha("C"));
  });

  it("dates an adopted head by GitHub's time, so a late push of that second is a tie, not a newer push", async () => {
    const { ref, stub, api, logs } = await session();
    api.reply(pull(sha("C"), second(101)), pull(sha("C"), second(101)));
    await push(ref, "A", { at: second(100) });
    await push(ref, "X", { at: second(100) });
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("C"), head_at: second(101), reconcile_at: null });

    // An older push stamped in the answer's second arrives late: it ties, and the next read keeps C.
    await cancelWakes(stub);
    await store(ref, "D", second(101));
    await runInDurableObject(stub, async (instance) => {
      await instance.settle();
    });
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("C"), head_at: second(101), reconcile_at: null });
    expect(api.reads()).toHaveLength(2);
    expect(logged(logs, "prq.head.reconciled")).toEqual([
      { headSha: sha("C"), updatedAt: second(101), headMoved: true },
      { headSha: sha("C"), updatedAt: second(101), headMoved: false },
    ]);
  });
});

describe("pushes during a read", () => {
  it("discards the answer when a later-second push is taken in while the read is in flight", async () => {
    const { ref, stub, api } = await session();
    const hold = await gate(stub);
    api.reply(held(hold, pull(sha("B"), second(100))));
    await push(ref, "A", { at: second(100) });
    await store(ref, "B", second(100));
    const reading = tracked(takeIn(ref));
    await hold.reached();

    await push(ref, "E", { at: second(101), before: sha("A") });
    await hold.open();
    await within(reading.promise, 3000);

    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("E"), head_at: second(101), reconcile_at: null });
    expect(api.reads()).toHaveLength(1);
  });

  it("discards the answer when a same-second push is taken in while the read is in flight; the next wake reads", async () => {
    const { ref, stub, api, logs } = await session();
    const hold = await gate(stub);
    // GitHub answers B (kept out against A), as it was when the read was sent; C then moves the head from A.
    api.reply(held(hold, pull(sha("B"), second(100))));
    await push(ref, "A", { at: second(100) });
    await store(ref, "B", second(100));
    const reading = tracked(takeIn(ref));
    await hold.reached();

    await push(ref, "C", { at: second(100), before: sha("A") });
    await cancelWakes(stub);
    await hold.open();
    await within(reading.promise, 3000);

    expect(await reconcileRow(stub)).toMatchObject({
      head_sha: sha("C"),
      reconcile_at: second(100),
      reconcile_tries: 0,
    });
    expect(api.reads()).toHaveLength(1);
    expect(logged(logs, "prq.head.reconcile_discarded")).toEqual([{ marked: true }]);
    // The discard leaves the mark to settle's retry wake.
    expect(await laterWakes(stub)).toBe(1);

    api.reply(pull(sha("C"), second(100)));
    await takeIn(ref);
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("C"), reconcile_at: null, reconcile_tries: 0 });
    expect(api.reads()).toHaveLength(2);
  });

  it("reads no more while an answer waits for the wake it arms before it is judged", async () => {
    const { ref, stub, api } = await session();
    const answered = await gate(stub);
    api.reply(held(answered, pull(sha("B"), second(100))), pull(sha("B"), second(100)));
    await push(ref, "A", { at: second(100) });
    await store(ref, "B", second(100));
    const first = tracked(takeIn(ref));
    await answered.reached();

    // The answer moves the head, so the read arms the wake first; that wake's scheduling is held.
    const arming = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const schedule = instance.schedule.bind(instance);
      vi.spyOn(instance, "schedule").mockImplementationOnce(async (...args) => {
        await arming.wait();
        return schedule(...args);
      });
    });
    await answered.open();
    await arming.reached();

    // Another settle meanwhile: the answer is not judged yet, so it reads nothing.
    await within(takeIn(ref), 3000);
    expect(api.reads()).toHaveLength(1);

    await arming.open();
    await within(first.promise, 3000);
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("B"), reconcile_at: null, reconcile_tries: 0 });
    expect(api.reads()).toHaveLength(1);
  });

  it("makes one read per settle while same-second pushes keep discarding the answers", async () => {
    const { ref, stub, api } = await session();
    await push(ref, "A", { at: second(100) });
    await store(ref, "X0", second(100));
    for (let round = 1; round <= 3; round += 1) {
      const hold = await gate(stub);
      api.reply(held(hold, pull(sha("A"), second(100))));
      const reading = tracked(takeIn(ref));
      await hold.reached();
      await push(ref, `X${round}`, { at: second(100) });
      await hold.open();
      await within(reading.promise, 3000);
      expect({ round, reads: api.reads().length }).toEqual({ round, reads: round });
    }
    expect(await reconcileRow(stub)).toMatchObject({
      head_sha: sha("A"),
      reconcile_at: second(100),
      reconcile_tries: 0,
    });
  });
});

describe("lagging answers and failures", () => {
  it("reads nothing for a tie a later-second push has cleared, and never adopts an answer older than the head", async () => {
    const { ref, stub, api } = await session();
    await push(ref, "A", { at: second(100) });
    // B ties with A and C comes a second later, both taken in by one settle before any read.
    await store(ref, "B", second(100));
    await store(ref, "C", second(101), "A");
    await takeIn(ref);
    expect(api.reads()).toEqual([]);
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("C"), head_at: second(101), reconcile_at: null });

    // A tie at 101 is read, and a lagging replica answers B as of second 100.
    api.reply(pull(sha("B"), second(100)));
    await push(ref, "D", { at: second(101) });
    expect(await reconcileRow(stub)).toMatchObject({
      head_sha: sha("C"),
      head_at: second(101),
      reconcile_at: second(101),
      reconcile_tries: 1,
    });
  });

  it("keeps the mark for the retry wake after a lagging answer or a transient failure, and clears it after 5 tries", async () => {
    const { ref, stub, api, logs } = await session();
    api.reply(
      pull(sha("A"), second(99)),
      failure(503),
      failure(429),
      async () => {
        throw new TypeError("Network connection lost.");
      },
      pull(sha("A"), second(99)),
    );
    await push(ref, "A", { at: second(100) });
    await store(ref, "X", second(100));
    for (let tries = 1; tries <= 4; tries += 1) {
      await cancelWakes(stub);
      await takeIn(ref);
      expect({ tries, row: await reconcileRow(stub) }).toMatchObject({
        tries,
        row: { reconcile_at: second(100), reconcile_tries: tries },
      });
      expect({ tries, wakes: await laterWakes(stub) }).toEqual({ tries, wakes: 1 });
    }
    await cancelWakes(stub);
    await takeIn(ref);
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("A"), reconcile_at: null, reconcile_tries: 0 });
    expect(await laterWakes(stub)).toBe(0);
    expect(logged(logs, "prq.head.reconcile_retry").map((entry) => [entry["reason"], entry["status"]])).toEqual([
      ["lagging", null],
      ["unavailable", 503],
      ["unavailable", 429],
      ["unavailable", 500],
      ["lagging", null],
    ]);
    expect(logged(logs, "prq.head.reconcile_failed")).toEqual([{ reason: "tries", tries: 5 }]);
  });

  it("clears the mark when GitHub refuses the read, and the next push heals the head as before", async () => {
    const { ref, stub, api, logs } = await session();
    api.reply(failure(404, "Not Found"));
    await push(ref, "A", { at: second(100) });
    await push(ref, "X", { at: second(100) });
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("A"), reconcile_at: null, reconcile_tries: 0 });
    expect(logged(logs, "prq.head.reconcile_failed")).toEqual([{ reason: "refused", status: 404 }]);

    await push(ref, "Y", { at: second(101) });
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("Y"), reconcile_at: null });
  });

  it("does not adopt an answer of the head's second showing a head a push of that second left", async () => {
    const { ref, stub, api } = await session();
    api.reply(pull(sha("B"), second(100)), pull(sha("C"), second(100)));
    await push(ref, "B", { at: second(99) });
    await push(ref, "C", { at: second(100), before: sha("B") });
    await push(ref, "D", { at: second(100) });
    expect(await reconcileRow(stub)).toMatchObject({
      head_sha: sha("C"),
      reconcile_at: second(100),
      reconcile_tries: 1,
    });

    await takeIn(ref);
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("C"), reconcile_at: null, reconcile_tries: 0 });
    expect(await analyses(stub)).toEqual([
      [sha("B"), "superseded"],
      [sha("C"), "pending"],
    ]);
  });

  it("known limit: a lost return within the second reads as lagging until a redelivery completes it", async () => {
    const { ref, stub, api } = await session();
    // GitHub's order within second 100 is A, B, A; the delivery of the return to A is lost, and GitHub answers A.
    api.reply(...Array.from({ length: 5 }, () => pull(sha("A"), second(100))));
    await push(ref, "A", { at: second(100) });
    await push(ref, "B", { at: second(100), before: sha("A") });
    for (let tries = 2; tries <= 5; tries += 1) {
      await takeIn(ref);
    }
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("B"), reconcile_at: null, reconcile_tries: 0 });
    expect(api.reads()).toHaveLength(5);

    // The return is redelivered from the App's recent deliveries: the head moves back and the next read is adopted.
    api.reply(pull(sha("A"), second(100)));
    await push(ref, "A", { at: second(100), before: sha("B") });
    expect(await reconcileRow(stub)).toMatchObject({ head_sha: sha("A"), reconcile_at: null });
    expect(api.reads()).toHaveLength(6);
  });
});
