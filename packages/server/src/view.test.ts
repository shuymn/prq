import { PrSessionView, SubmitResponse } from "@prq/protocol";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import { claimIn, newSession, setPool, submission } from "./test/session.ts";

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

// The next view a connection receives after `from` frames that matches.
async function nextView(socket: AgentSocket, from: number, matches: (view: PrSessionView) => boolean) {
  const frame = await socket.next(
    (received) => received["type"] === "cf_agent_state" && matches(v.parse(PrSessionView, received["state"])),
    from,
  );
  return v.parse(PrSessionView, frame["state"]);
}

describe("job view", () => {
  it("follows each job transition with its state, agent ID, claim time and failure", async () => {
    captureLogs();
    await setPool(["laptop"]);
    const { stub, ref, open } = await newSession("view", sockets);
    const client = await open();
    const watcher = await open();
    expect(await nextView(watcher, 0, () => true)).toEqual({ pr: ref, details: null, owner: null, jobs: [] });

    await client.chat([question("q1")]);
    let from = 0;
    const pending = await nextView(watcher, from, (view) => view.jobs[0]?.state === "pending");
    expect(pending).toMatchObject({ owner: "local", jobs: [{ target: { kind: "answer", messageId: "q1" } }] });

    from = watcher.frames.length;
    const claim = await claimIn(stub, "laptop", "fresh");
    const claimed = await nextView(watcher, from, (view) => view.jobs[0]?.state === "claimed");
    expect(claimed.jobs[0]).toMatchObject({ agentId: "laptop", failure: null, resultMessageId: null });
    expect(claimed.jobs[0]?.since).toEqual(expect.any(Number));

    from = watcher.frames.length;
    const { messageId } = v.parse(SubmitResponse, await stub.submit(submission(claim, "laptop")));
    const running = await nextView(watcher, from, (view) => view.jobs[0]?.state === "running");
    expect(running.jobs[0]).toMatchObject({ agentId: "laptop" });
    const done = await nextView(watcher, from, (view) => view.jobs[0]?.state === "done");
    expect(done.jobs[0]).toMatchObject({ resultMessageId: messageId, since: null });
  });

  it("refuses a client's state update and keeps the server's view", async () => {
    const logs = captureLogs();
    await setPool(["laptop"]);
    const { stub, open } = await newSession("view", sockets);
    const client = await open();
    await client.chat([question("q1")]);
    const before = await stub.view();

    const from = client.frames.length;
    client.send({ type: "cf_agent_state", state: { ...before, owner: "cloud", jobs: [] } });
    await client.next((frame) => frame["type"] === "cf_agent_state_error", from);

    expect(await stub.view()).toEqual(before);
    const other = await open();
    expect(await nextView(other, 0, () => true)).toEqual(before);
    expect(logs.some((log) => log.entry["event"] === "prq.state.refused")).toBe(true);
  });
});
