import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PRESENCE_MS } from "./ledger.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import { gate, hub, newSession, prSessionSeams, setPool, tracked } from "./test/session.ts";

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

describe("owner", () => {
  it("first decision wins when two first intakes race", async () => {
    captureLogs();
    await setPool(["laptop"]);
    const { stub, open } = await newSession("owner", sockets);
    const client = await open();
    // Intake A (the chat request) reads "present" and is held before it stores its decision.
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const read = seams.readPool.bind(instance);
      vi.spyOn(seams, "readPool").mockImplementationOnce(async () => {
        const present = await read();
        await held.wait();
        return present;
      });
    });
    const intakeA = tracked(client.chat([question("q1")]));
    await held.reached();
    expect(intakeA.settled()).toBe(false);

    // Meanwhile the agent leaves and intake B (settle) reads "absent" and stores cloud.
    await setPool([]);
    await stub.settle();
    expect((await stub.view()).owner).toBe("cloud");

    await held.open();
    await intakeA.promise;
    expect((await stub.view()).owner).toBe("cloud");
    expect((await stub.view()).jobs.map((job) => job.state)).toEqual(["failed"]);
  });

  it("opening the PR decides nothing, and presence changes nothing after the decision", async () => {
    captureLogs();
    await setPool([]);
    const { stub, open } = await newSession("owner", sockets);
    const asked = vi.fn<() => void>();
    await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const read = seams.readPool.bind(instance);
      vi.spyOn(seams, "readPool").mockImplementation(async () => {
        asked();
        return read();
      });
    });

    const client = await open();
    const state = await client.next((frame) => frame["type"] === "cf_agent_state");
    expect(state["state"]).toMatchObject({ owner: null, jobs: [] });
    expect((await stub.view()).owner).toBeNull();
    await stub.settle();
    expect(asked).not.toHaveBeenCalled();

    await setPool(["laptop"]);
    await client.chat([question("q1")]);
    expect(asked).toHaveBeenCalledTimes(1);
    expect((await stub.view()).owner).toBe("local");

    // The agent's last contact falls out of presence; the next question keeps the owner and asks the Hub nothing.
    await runInDurableObject(await hub(), (_, hubState) => {
      hubState.storage.sql.exec("UPDATE prq_agents SET last_seen_at = ?", Date.now() - PRESENCE_MS - 1);
    });
    expect(await (await hub()).isLocalPresent()).toBe(false);
    await client.chat([question("q1"), question("q2")]);
    expect(asked).toHaveBeenCalledTimes(1);
    const view = await stub.view();
    expect(view.owner).toBe("local");
    expect(view.jobs.map((job) => job.state)).toEqual(["pending", "pending"]);
  });

  it("leaves the question without a job when the pool cannot be read, and the next settle makes it", async () => {
    const logs = captureLogs();
    await setPool([]);
    const { stub, open } = await newSession("owner", sockets);
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "readPool").mockRejectedValueOnce(new Error("Hub unreachable"));
    });
    const client = await open();

    await client.chat([question("q1")]);
    expect(await stub.view()).toMatchObject({ owner: null, jobs: [] });
    expect(logs.find((log) => log.entry["event"] === "prq.settle.failed")?.entry).toMatchObject({
      step: "create_jobs",
    });

    await stub.settle();
    expect(await stub.view()).toMatchObject({ owner: "cloud", jobs: [{ state: "failed" }] });
  });
});
