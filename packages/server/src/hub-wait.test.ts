import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRESENCE_MS } from "./hub.ts";
import { captureLogs, request } from "./test/access.ts";
import { type AgentSocket, hostToken, question } from "./test/chat.ts";
import { lastSeenAgo, localSession, waitOver, waitStatus, watchChecks } from "./test/cli.ts";
import { clearQueue, gate, hub, hubSeams, queued, setPool, tracked, within } from "./test/session.ts";

const sockets: AgentSocket[] = [];

// Each test starts from an empty queue: the sessions of earlier tests may still have work.
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
// Long enough that a wait that answers has not timed out; the tests' own 5 s limit is shorter.
const LONG_MS = 20_000;

async function isPresent(): Promise<boolean> {
  return (await hub()).isLocalPresent();
}

describe("wakes on notify", () => {
  it("answers ready, before its timeout, when work is created while it sleeps", async () => {
    captureLogs();
    const token = await hostToken();
    const { client } = await localSession("wait", sockets);
    const checks = await watchChecks();
    const wait = tracked(waitStatus(waitOver(token, "laptop", LONG_MS)));
    // The first check found nothing: the wait sleeps.
    await checks.answered();
    expect(wait.settled()).toBe(false);

    await client.chat([Q1]);
    expect(await wait.promise).toBe("ready");
  });
});

describe("notify during check", () => {
  it("checks again when a notify landed between its check and its sleep", async () => {
    captureLogs();
    const token = await hostToken();
    const { client, name } = await localSession("wait", sockets);
    // The first check is held after it found nothing.
    const checks = await watchChecks(1);
    const wait = tracked(waitStatus(waitOver(token, "laptop", 3000)));
    await checks.held.reached();

    // The question's job is created and the Hub notified while the check is held.
    await client.chat([Q1]);
    expect(await queued()).toContain(name);
    expect(wait.settled()).toBe(false);

    await checks.held.open();
    expect(await wait.promise).toBe("ready");
  });
});

describe("present while waiting", () => {
  it("counts an agent in a wait as present past PRESENCE_MS since its last contact", async () => {
    captureLogs();
    await setPool([]);
    const token = await hostToken();
    const checks = await watchChecks();
    const wait = tracked(waitStatus(waitOver(token, "laptop", LONG_MS)));
    await checks.answered();

    // The wait set the agent's last contact at its start; it is now older than PRESENCE_MS.
    await lastSeenAgo(PRESENCE_MS + 60_000);
    expect(await isPresent()).toBe(true);

    // A question decides the owner from the pool: the waiting agent makes it local, and its job ends the wait.
    const { client, stub } = await localSession("wait", sockets);
    await setPool([]);
    await client.chat([Q1]);
    expect((await stub.view()).owner).toBe("local");
    expect(await wait.promise).toBe("ready");

    // The wait's end is a contact; presence then lapses PRESENCE_MS after it.
    expect(await isPresent()).toBe(true);
    await lastSeenAgo(PRESENCE_MS);
    expect(await isPresent()).toBe(false);
  });
});

describe("an aborted wait", () => {
  it("ends in the Hub when its request goes away, and the agent stops counting as waiting", async () => {
    const logs = captureLogs();
    await setPool([]);
    const token = await hostToken();
    const checks = await watchChecks();
    const abort = new AbortController();
    const wait = tracked(waitOver(token, "laptop", LONG_MS, abort.signal).catch((error: unknown) => error));
    await checks.answered();
    await lastSeenAgo(PRESENCE_MS);
    expect(await isPresent()).toBe(true);

    abort.abort();
    expect(await wait.promise).toBeInstanceOf(Error);
    // The Hub ends the wait (its end is a contact, so the contact is made old again until the wait is gone).
    await vi.waitFor(
      async () => {
        await lastSeenAgo(PRESENCE_MS);
        expect(await isPresent()).toBe(false);
      },
      { timeout: 3000 },
    );
    expect(logs.filter((log) => log.level === "error")).toEqual([]);
  });

  it("ends while a check is held, without waiting for it", async () => {
    captureLogs();
    await setPool([]);
    const token = await hostToken();
    const checks = await watchChecks(1);
    const abort = new AbortController();
    const wait = tracked(waitOver(token, "laptop", LONG_MS, abort.signal).catch((error: unknown) => error));
    await checks.held.reached();

    abort.abort();
    await wait.promise;
    await vi.waitFor(
      async () => {
        await lastSeenAgo(PRESENCE_MS);
        expect(await isPresent()).toBe(false);
      },
      { timeout: 3000 },
    );
    await checks.held.open();
  });
});

describe("the wait's bound", () => {
  it("answers timeout once its bound passes, even while a session does not answer its check", async () => {
    captureLogs();
    const { name } = await localSession("wait", sockets, Q1);
    // The check's peek of the session is held.
    const held = await gate(await hub());
    await runInDurableObject(await hub(), (instance) => {
      const seams = hubSeams(instance);
      vi.spyOn(seams, "peekSession").mockImplementation(async () => {
        await held.wait();
        throw new Error("never answered");
      });
    });
    const token = await hostToken();

    expect(await within(waitStatus(waitOver(token, "laptop", 100)), 3000)).toBe("timeout");
    expect(held.isReached()).toBe(true);
    expect(await queued()).toContain(name);
    await held.open();
  });
});

describe("the Hub's HTTP handler", () => {
  it("answers the Worker's wait only", async () => {
    captureLogs();
    const stub = await hub();
    for (const [path, method] of [
      ["/cli/claim", "POST"],
      ["/cli/wait", "GET"],
      ["/agents/hub/hub", "POST"],
    ] as const) {
      const res = await stub.fetch(request(path, undefined, { method }));
      expect({ path, method, status: res.status }).toEqual({ path, method, status: 404 });
    }
    const invalid = await stub.fetch(request("/cli/wait", undefined, { method: "POST", body: "{}" }));
    expect(invalid.status).toBe(500);
  });
});
