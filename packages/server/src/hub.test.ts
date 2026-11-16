import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PRESENCE_MS } from "./hub.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import { hub, newSession, queued, sessionSql, setPool } from "./test/session.ts";

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q1 = question("q1");

describe("presence", () => {
  it("counts an agent present until PRESENCE_MS after its last contact", async () => {
    captureLogs();
    await setPool([]);
    const stub = await hub();
    expect(await stub.isLocalPresent()).toBe(false);
    await stub.touch("laptop");
    expect(await stub.isLocalPresent()).toBe(true);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("UPDATE prq_agents SET last_seen_at = ?", Date.now() - PRESENCE_MS + 1000);
    });
    expect(await stub.isLocalPresent()).toBe(true);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("UPDATE prq_agents SET last_seen_at = ?", Date.now() - PRESENCE_MS);
    });
    expect(await stub.isLocalPresent()).toBe(false);
  });
});

describe("notification queue", () => {
  it("queues a canonical session name only", async () => {
    const logs = captureLogs();
    const stub = await hub();
    await stub.notify("octo~queue~1");
    expect(await queued()).toContain("octo~queue~1");
    await stub.notify("Octo~queue~1");
    expect(await queued()).not.toContain("Octo~queue~1");
    expect(logs.some((log) => log.entry["event"] === "prq.hub.notify_refused")).toBe(true);
  });
});

describe("cloud sessions", () => {
  it("exposes nothing to peek or claim", async () => {
    captureLogs();
    await setPool([]);
    const { stub, open } = await newSession("hub", sockets);
    const client = await open();
    await client.chat([Q1]);
    expect((await stub.view()).owner).toBe("cloud");
    // Even a waiting job (as #5's cloud agent leaves one) is not offered to a local agent.
    await sessionSql(stub, "UPDATE prq_jobs SET state = 'pending'");

    expect(await stub.peek("laptop")).toEqual({ resume: false, fresh: false, open: false });
    expect(await stub.claim("laptop", "fresh")).toEqual({ job: null });
  });
});
