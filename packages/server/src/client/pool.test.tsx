// The header's agent pool over the Hub's socket and a fetch the test answers, with PartySocket unmodified (plan P5.1,
// P5.3): PoolStatus from the Hub's view and its connection, and the popover's read of the agents on opening, to the
// last page, within its bound, and only while the popover is open and the read the latest.

import type { HubView } from "@prq/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AGENTS_READ_MS } from "./agents.ts";
import { Frame } from "./frame.tsx";
import { useHub } from "./hub.ts";
import { FetchContext } from "./reads.ts";
import { RECONNECT_FAILED_MS, SocketContext } from "./session.ts";
import { controlledFetch, type Pending, settled } from "./test/fetch.ts";
import { controlledSockets, type TestSocket } from "./test/socket.ts";

const view = (change: Partial<HubView> = {}): HubView => ({
  localAgentPresent: true,
  presentAgents: 2,
  jobs: { waiting: 2, running: 1, failed: 0 },
  needsAttention: 0,
  owners: 1,
  ledgerVersion: 1,
  ...change,
});

const agent = (agentId: string, change: object = {}) => ({
  agentId,
  lastSeenAt: Date.now() - 3.5 * 60 * 60_000,
  waiting: false,
  holdsJob: false,
  ...change,
});

function Header() {
  const hub = useHub();
  return (
    <Frame view={hub.view} unavailable={hub.unavailable} version="v0.4.0" layout="page">
      <p>Page</p>
    </Frame>
  );
}

async function header() {
  const fetch = controlledFetch();
  const sockets = controlledSockets();
  const tree = (shown: boolean) => (
    <FetchContext value={fetch.fetch}>
      <SocketContext value={{ WebSocket: sockets.WebSocket }}>{shown ? <Header /> : <p>Elsewhere</p>}</SocketContext>
    </FetchContext>
  );
  const screen = await render(tree(true));
  return { fetch, sockets, leave: () => screen.rerender(tree(false)) };
}

// The Hub's socket opens and sends its view, as the server does on connect.
async function connect(sockets: ReturnType<typeof controlledSockets>, index: number, hubView: HubView) {
  const socket = await sockets.socket(index);
  socket.open();
  socket.receive({ type: "cf_agent_state", state: hubView });
  return socket;
}

// A task of the page's event loop: React renders and runs effects, and a popover's toggle event fires, in tasks,
// which fake timers do not move.
const nextTask = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.addEventListener("message", () => resolve(), { once: true });
    channel.port1.start();
    channel.port2.postMessage(null);
  });

// Waits for the page without moving a fake clock.
async function until(check: () => boolean) {
  const end = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > end) {
      throw new Error("the page did not get there within 10 s");
    }
    await nextTask();
  }
}

// Under fake timers: PartySocket's reconnect delay passes, a task at a time, until the page connects again.
async function reconnect(sockets: ReturnType<typeof controlledSockets>) {
  const index = sockets.sockets.length;
  while (sockets.sockets[index] === undefined) {
    await nextTask();
    await vi.advanceTimersByTimeAsync(500);
  }
  return index;
}

const textOf = (selector: string) => document.querySelector(selector)?.textContent ?? "";
const status = () => textOf("[data-component=PoolStatus]");
const button = () => document.querySelector<HTMLButtonElement>("button[data-component=PoolStatus]");
const popover = () => document.querySelector<HTMLElement>("[data-component=PoolPopover]");
const agentLines = () => [...document.querySelectorAll(".agent-text")].map((line) => line.textContent);
const reading = () => popover()?.querySelector(".skeleton")?.getAttribute("aria-busy") === "true";
const path = (request: Pending) => `${request.url.pathname}${request.url.search}`;

// Opens or closes the popover from its button, and waits for its toggle.
async function toggle(open: boolean) {
  button()?.click();
  await until(() => popover()?.matches(":popover-open") === open && button()?.ariaExpanded === String(open));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the pool's status", () => {
  test("is loading until the first view, unavailable once the first connect or a close has had no open for RECONNECT_FAILED_MS, not a tick less, else local or cloud-only from the view, with the design's cloud-only copy (P5.3)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetch, sockets } = await header();
    await until(() => status() === "Loading pool");
    await vi.advanceTimersByTimeAsync(RECONNECT_FAILED_MS - 1);
    expect(status()).toBe("Loading pool");
    await vi.advanceTimersByTimeAsync(1);
    await until(() => status() === "Pool unavailable");

    // PartySocket gave up on the connections that never opened: the latest one opens.
    const first = await connect(
      sockets,
      sockets.sockets.length - 1,
      view({ localAgentPresent: false, presentAgents: 0 }),
    );
    await until(() => status() === "Cloud only1 running · 2 waiting");
    first.receive({ type: "cf_agent_state", state: view() });
    await until(() => status() === "2 local agents1 running · 2 waiting");

    first.drop();
    await vi.advanceTimersByTimeAsync(RECONNECT_FAILED_MS - 1);
    expect(status()).toBe("2 local agents1 running · 2 waiting");
    await vi.advanceTimersByTimeAsync(1);
    await until(() => status() === "Pool unavailable");

    await connect(sockets, await reconnect(sockets), view({ localAgentPresent: false, presentAgents: 0 }));
    await until(() => status() === "Cloud only1 running · 2 waiting");
    vi.useRealTimers();
    await toggle(true);
    (await fetch.request(0)).respond({ rows: [], nextCursor: null });
    await until(() => popover()?.querySelector(".none") !== null);
    expect(textOf("[data-component=PoolPopover] .none")).toBe(
      "No local agent present. New PRs go to cloud; existing local sessions wait until their agent returns.",
    );
  });
});

describe("the popover's read", () => {
  test("opening reads every page and lists each agent with what it does and when it was seen; a failed read, by status or network, shows unavailable with the Hub's view healthy (P5.1)", async () => {
    const { fetch, sockets } = await header();
    await connect(sockets, 0, view());
    await until(() => status().startsWith("2 local agents"));
    expect(fetch.requests).toEqual([]);

    await toggle(true);
    const first = await fetch.request(0);
    expect(path(first)).toBe("/api/agents");
    expect(reading()).toBe(true);
    first.respond({ rows: [agent("laptop", { holdsJob: true })], nextCursor: "laptop" });
    const second = await fetch.request(1);
    expect(path(second)).toBe("/api/agents?cursor=laptop");
    expect(reading()).toBe(true);
    second.respond({ rows: [agent("mini", { waiting: true, lastSeenAt: null })], nextCursor: null });
    await until(() => agentLines().length === 2);
    expect(agentLines()).toEqual(["laptopHolding a job · seen 3 hr ago", "miniWaiting for work"]);
    expect(popover()?.dataset["state"]).toBe("local");

    await toggle(false);
    await toggle(true);
    (await fetch.request(2)).respond({ error: "unavailable" }, 503);
    await until(() => popover()?.dataset["state"] === "unavailable");
    expect(textOf("[data-component=PoolPopover] [data-component=Notice]")).toBe(
      "Pool status unavailableThe agent pool could not be read. Jobs keep their state.",
    );
    expect(status()).toBe("2 local agents1 running · 2 waiting");

    await toggle(false);
    await toggle(true);
    expect(reading()).toBe(true);
    (await fetch.request(3)).fail();
    await until(() => popover()?.dataset["state"] === "unavailable");
  });

  test("a read that has not reached its last page within AGENTS_READ_MS, not a tick less, fails and is abandoned; its late page changes nothing", async () => {
    const { fetch, sockets } = await header();
    await connect(sockets, 0, view());
    await until(() => status().startsWith("2 local agents"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await toggle(true);
    const first = await fetch.request(0);
    await vi.advanceTimersByTimeAsync(AGENTS_READ_MS / 2);
    first.respond({ rows: [agent("laptop")], nextCursor: "laptop" });
    const second = await fetch.request(1);
    await vi.advanceTimersByTimeAsync(AGENTS_READ_MS / 2 - 1);
    expect(reading()).toBe(true);
    expect(second.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => popover()?.dataset["state"] === "unavailable");
    expect(second.signal.aborted).toBe(true);

    vi.useRealTimers();
    second.respond({ rows: [agent("mini")], nextCursor: null });
    await settled();
    expect(popover()?.dataset["state"]).toBe("unavailable");
    expect(fetch.requests).toHaveLength(2);
  });

  test("closing the popover or leaving the page ends the read in flight, a newer view while open reads again and keeps the rows until it ends, and a superseded read changes nothing", async () => {
    const { fetch, sockets, leave } = await header();
    const socket: TestSocket = await connect(sockets, 0, view());
    await until(() => status().startsWith("2 local agents"));

    // Closed: a new view reads nothing.
    socket.receive({ type: "cf_agent_state", state: view({ ledgerVersion: 2 }) });
    await settled();
    expect(fetch.requests).toEqual([]);

    await toggle(true);
    const closed = await fetch.request(0);
    await toggle(false);
    expect(closed.signal.aborted).toBe(true);
    await toggle(true);
    const shown = await fetch.request(1);
    closed.respond({ rows: [agent("stale")], nextCursor: null });
    await settled();
    expect(reading()).toBe(true);
    shown.respond({ rows: [agent("laptop")], nextCursor: null });
    await until(() => agentLines().length === 1);

    socket.receive({ type: "cf_agent_state", state: view({ jobs: { waiting: 1, running: 2, failed: 0 } }) });
    const superseded = await fetch.request(2);
    expect(agentLines()).toEqual(["laptopNot waiting · seen 3 hr ago"]);
    socket.receive({ type: "cf_agent_state", state: view({ jobs: { waiting: 0, running: 3, failed: 0 } }) });
    const latest = await fetch.request(3);
    expect(superseded.signal.aborted).toBe(true);
    superseded.respond({ rows: [agent("stale")], nextCursor: null });
    await settled();
    expect(agentLines()).toEqual(["laptopNot waiting · seen 3 hr ago"]);
    latest.respond({ rows: [agent("laptop"), agent("mini", { waiting: true })], nextCursor: null });
    await until(() => agentLines().length === 2);

    socket.receive({ type: "cf_agent_state", state: view({ ledgerVersion: 3 }) });
    const left = await fetch.request(4);
    await leave();
    expect(left.signal.aborted).toBe(true);
  });
});
