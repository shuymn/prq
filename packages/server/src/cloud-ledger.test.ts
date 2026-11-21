import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Hub } from "./hub.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import { cloudSession, untilState } from "./test/cloud.ts";
import { answerScript, finish, publish, ScriptedModel, text, useCloudModel, useWorkspace } from "./test/model.ts";
import { gate, hub, jobOf, ledgerRowOf, retryIn, revOf, tracked } from "./test/session.ts";
import { push, sha } from "./test/webhook.ts";

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q1 = question("q1");

describe("failure labels", () => {
  it("keeps Answer failed for a cloud turn that errored until its retried turn completes, at a newer revision", async () => {
    captureLogs();
    const { stub, name, client } = await cloudSession("ledger", sockets);
    const held = await gate(stub);
    useCloudModel(
      new ScriptedModel().add(
        [...text("partial"), { fail: new Error("lost") }],
        [publish("answer one"), { hold: held }, finish("tool-calls")],
      ),
    );

    await client.chat([Q1]);
    await untilState(stub, "q1", "failed");
    await vi.waitFor(async () =>
      expect(await ledgerRowOf(name)).toMatchObject({ problem: "answer_failed", jobs: { failed: 1 } }),
    );
    const job = await jobOf(stub, "q1");
    expect(await retryIn(stub, job.job_id)).toEqual({ status: "retried" });
    await held.reached();
    const running = await revOf(stub, job.job_id);
    expect(await ledgerRowOf(name)).toMatchObject({ problem: "answer_failed", jobs: { failed: 1, running: 1 } });

    await held.open();
    await untilState(stub, "q1", "done");
    await vi.waitFor(async () =>
      expect(await ledgerRowOf(name)).toMatchObject({
        problem: null,
        latestEvent: { kind: "answer" },
        jobs: { failed: 0, running: 0 },
      }),
    );
    expect(await jobOf(stub, "q1")).toMatchObject({ unresolved_failure: 0 });
    expect(await revOf(stub, job.job_id)).toBeGreaterThan(running);
  });
});

describe("held delivery", () => {
  it("ends with the commit's entry when the delivery of the turn's running entry lands after it", async () => {
    captureLogs();
    const { stub, name, ref } = await cloudSession("ledger", sockets);
    useCloudModel(new ScriptedModel().add(answerScript("the summary")));
    useWorkspace();
    // The Hub holds the session's first delivery of an entry with a running job, before it stores it.
    const held = await gate(await hub());
    let landed = false;
    await runInDurableObject(await hub(), (instance) => {
      const upsert = instance.upsertLedger.bind(instance);
      let holding = true;
      vi.spyOn(Hub.prototype, "upsertLedger").mockImplementation(async (session, rev, entry) => {
        if (session !== name || !holding || entry.jobs.running === 0) {
          return upsert(session, rev, entry);
        }
        holding = false;
        await held.wait();
        await upsert(session, rev, entry);
        landed = true;
      });
    });

    // The push's settle hands the analysis over and waits in its delivery; the turn runs and commits meanwhile.
    const pushed = tracked(push(ref, "a"));
    await held.reached();
    await untilState(stub, sha("a"), "done");
    await vi.waitFor(async () =>
      expect(await ledgerRowOf(name)).toMatchObject({ latestEvent: { kind: "summary" }, jobs: { running: 0 } }),
    );
    expect(pushed.settled()).toBe(false);
    await held.open();
    await pushed.promise;

    expect(landed).toBe(true);
    expect(await ledgerRowOf(name)).toMatchObject({ latestEvent: { kind: "summary" }, jobs: { running: 0 } });
  });
});
