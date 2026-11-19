// The PR detail over a socket and a fetch the test answers, with the Agents SDK's chat hook and PartySocket unmodified
// (plan P3.1–P3.4, P3.10, P3.12, P3.13, P4.3–P4.6, P4.8): the history reads and what a read may change, the send
// model, streamed text by run, versions, the connection's states, a job's Retry and the rail.

import { type HubView, PrSessionView } from "@prq/protocol";
import { useEffect } from "react";
import * as v from "valibot";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

import { useAnnouncements } from "../announce.ts";
import { RETRY_ERROR } from "../components/retry.tsx";
import type { Hub } from "../hub.ts";
import { FetchContext } from "../reads.ts";
import { RECONNECT_FAILED_MS, RETRY_ANSWER_MS, RETRY_STALE_MS, SocketContext } from "../session.ts";
import { SEND_SETTLE_MS, SendSlots, SlotsContext } from "../slots.ts";
import { controlledFetch, settled } from "../test/fetch.ts";
import { controlledSockets, type TestSocket } from "../test/socket.ts";
import { PrDetailScreen } from "./PrDetailScreen.tsx";

const REF = { owner: "shuymn", repo: "prq", number: 42 };
const HISTORY = "/agents/pr-session/shuymn~prq~42/get-messages";
const HEAD = "e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3";
const OLDER = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const HUB: Hub = {
  view: {
    localAgentPresent: true,
    presentAgents: 1,
    jobs: { waiting: 0, running: 0, failed: 0 },
    needsAttention: 0,
    owners: 1,
    ledgerVersion: 1,
  } satisfies HubView,
  opens: 1,
  serverVersion: null,
};

type JobSpec = {
  id: string;
  state?: string;
  at?: number;
  rev?: number;
  run?: number;
  stalled?: boolean;
  agentId?: string;
  failure?: string;
} & ({ analysis: string } | { question: string });

const T0 = Date.parse("2026-11-19T10:14:00");

function job(spec: JobSpec, index: number) {
  return {
    jobId: spec.id,
    target:
      "analysis" in spec ? { kind: "analysis", headSha: spec.analysis } : { kind: "answer", messageId: spec.question },
    state: spec.state ?? "done",
    agentId: spec.agentId ?? null,
    since: spec.agentId === undefined ? null : (spec.at ?? T0 + index),
    stalled: spec.stalled ?? false,
    failure: spec.failure ?? null,
    resultMessageId: null,
    createdAt: T0 + index,
    updatedAt: spec.at ?? T0 + index,
    rev: spec.rev ?? 1,
    run: spec.run ?? 1,
  };
}

const sessionView = (jobs: JobSpec[] = [], owner: "cloud" | "local" = "cloud") =>
  v.parse(PrSessionView, {
    pr: REF,
    details: {
      fullName: "shuymn/prq",
      title: "Add retry to stalled jobs",
      state: "open",
      url: "https://github.com/shuymn/prq/pull/42",
      headSha: HEAD,
      baseSha: OLDER,
    },
    owner,
    jobs: jobs.map(job),
  });

const question = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }] });

const BY = { kind: "cloud", model: "deepseek-chat" };

const answer = (jobId: string, questionId: string, text: string, extra: object = {}) => ({
  id: `answer-${jobId}`,
  role: "assistant",
  parts: [{ type: "text", text }],
  metadata: { kind: "answer", jobId, questionId, sha: HEAD, run: 1, by: BY, ...extra },
});

const analysis = (jobId: string, headSha: string, text: string, extra: object = {}) => ({
  id: `analysis-${jobId}`,
  role: "assistant",
  parts: [{ type: "text", text }],
  metadata: { kind: "analysis", jobId, headSha, run: 1, by: BY, ...extra },
});

async function detail({ slots = new SendSlots() }: { slots?: SendSlots } = {}) {
  const fetch = controlledFetch();
  const sockets = controlledSockets();
  const tree = (shown: boolean) => (
    <FetchContext value={fetch.fetch}>
      <SlotsContext value={slots}>
        <SocketContext value={{ WebSocket: sockets.WebSocket }}>
          {shown ? <PrDetailScreen prRef={REF} hub={HUB} layout="page" notice={() => null} /> : <p>Elsewhere</p>}
        </SocketContext>
      </SlotsContext>
    </FetchContext>
  );
  const screen = await render(tree(true));
  return { fetch, sockets, slots, screen, show: (shown: boolean) => screen.rerender(tree(shown)) };
}

// The connection opens and the session sends its view, as the server does on connect.
async function connect(sockets: ReturnType<typeof controlledSockets>, index: number, jobs: JobSpec[] = []) {
  const socket = await sockets.socket(index);
  socket.open();
  socket.receive({ type: "cf_agent_state", state: sessionView(jobs) });
  return socket;
}

// A task of the page's event loop: React renders and runs effects in tasks, which fake timers do not move.
const nextTask = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.addEventListener("message", () => resolve(), { once: true });
    channel.port1.start();
    channel.port2.postMessage(null);
  });

const textOf = (selector: string) => document.querySelector(selector)?.textContent ?? "";

// Under fake timers, waits for the page without moving the clock: expect.poll, expect.element and the locators'
// actions advance fake time by their interval on each retry, which would move a bound the test measures.
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
async function reconnect(sockets: ReturnType<typeof controlledSockets>, index: number) {
  while (sockets.sockets[index] === undefined) {
    await nextTask();
    await vi.advanceTimersByTimeAsync(500);
  }
  return sockets.socket(index);
}

const listFrame = (messages: unknown[]) => ({ type: "cf_agent_chat_messages", messages });

const shown = () =>
  [...document.querySelectorAll<HTMLElement>("[data-component=Message] :is(.question, .body)")].map((node) =>
    node.textContent?.trim(),
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("the history", () => {
  test("a failed first read shows the load failure; Try again reads again and shows the history; a later failure keeps it with the refresh failure (P3.1)", async () => {
    const { fetch, sockets } = await detail();
    await connect(sockets, 0);
    const mount = await fetch.request(0);
    expect(mount.url.pathname).toBe(HISTORY);
    mount.fail();
    (await fetch.request(1)).fail();
    await expect.element(page.getByText("Couldn't load the summary and conversation")).toBeVisible();

    await page.getByRole("button", { name: "Try again" }).click();
    (await fetch.request(2)).respond([question("q1", "Why?")]);
    await expect.element(page.getByText("Why?")).toBeVisible();
    expect(page.getByText("Couldn't load the summary and conversation").elements()).toEqual([]);

    (await sockets.socket(0)).receive({ type: "prq:history-changed" });
    (await fetch.request(3)).respond({ error: "internal" }, 500);
    await expect.element(page.getByText("Couldn't refresh the summary and conversation")).toBeVisible();
    await expect.element(page.getByText("Why?")).toBeVisible();
  });

  test("a list lacking a shown message, and a failed read, change nothing; a save between the mount read and the first open shows after the open; nothing sends a list (P3.2)", async () => {
    const { fetch, sockets } = await detail();
    const mount = await fetch.request(0);
    mount.respond([]);
    await settled();
    // Saved after the mount read, before the first open: the open's read brings it.
    const socket = await connect(sockets, 0, [{ id: "j1", question: "q1" }]);
    const opened = await fetch.request(1);
    opened.respond([question("q1", "First?"), answer("j1", "q1", "First answer.")]);
    await expect.element(page.getByText("First answer.")).toBeVisible();

    // A read held across a list frame and a history-changed read, released in reverse order.
    socket.receive({ type: "prq:history-changed" });
    const held = await fetch.request(2);
    socket.receive(
      listFrame([
        question("q1", "First?"),
        answer("j1", "q1", "First answer."),
        question("q2", "Second?"),
        answer("j2", "q2", "Second answer."),
      ]),
    );
    await expect.element(page.getByText("Second answer.")).toBeVisible();
    socket.receive({ type: "prq:history-changed" });
    const later = await fetch.request(3);
    later.fail();
    held.respond([question("q1", "First?"), answer("j1", "q1", "First answer.")]);
    await settled();
    expect(shown()).toEqual(["First?", "First answer.", "Second?", "Second answer."]);
    expect(sockets.sent("cf_agent_chat_messages")).toEqual([]);
  });
});

// The chat requests the page sent: each request's ID and the messages its body carries.
const chatRequests = (sockets: ReturnType<typeof controlledSockets>) =>
  sockets.sent("cf_agent_use_chat_request").map((frame) => {
    const { id, init } = v.parse(v.looseObject({ id: v.string(), init: v.looseObject({ body: v.string() }) }), frame);
    return { id, messages: v.parse(v.looseObject({ messages: v.array(v.unknown()) }), JSON.parse(init.body)).messages };
  });

// The ID of the question a chat request carries.
const idOf = (request: { messages: unknown[] } | undefined) =>
  v.parse(v.looseObject({ id: v.string() }), request?.messages[0]).id;

const field = () => page.getByRole("textbox", { name: "Question" });
const sendButton = () => page.getByRole("button", { name: "Send" });

async function ask(text: string) {
  await userEvent.fill(field(), text);
  await sendButton().click();
}

// The page's connection open and its history read empty.
async function ready() {
  const opened = await detail();
  const socket = await connect(opened.sockets, 0);
  (await opened.fetch.request(0)).respond([]);
  (await opened.fetch.request(1)).respond([]);
  await expect.element(page.getByText("No questions yet. Ask about this pull request below.")).toBeVisible();
  return { ...opened, socket };
}

const done = (id: string) => ({ type: "cf_agent_use_chat_response", id, body: "", done: true });
const refused = (id: string) => ({ type: "cf_agent_use_chat_response", id, body: "refused", done: true, error: true });

describe("a question sent", () => {
  test("Send is off until a stored list holds it, which acknowledges it while the request is open; another turn's error, and the acknowledged request's end with a read lacking the next, leave the next pending; a history-changed read acknowledges it, its request carrying it alone (P3.3, P3.8)", async () => {
    const { fetch, sockets, socket } = await ready();
    await ask("First?");
    await expect.poll(() => chatRequests(sockets)).toHaveLength(1);
    const [first] = chatRequests(sockets);
    const id = idOf(first);
    await expect.element(page.getByText("First?")).toBeVisible();
    await expect.element(sendButton()).toBeDisabled();
    await expect.element(page.getByText("You can send once the question above is saved.")).toBeVisible();
    await userEvent.fill(field(), "Next draft");
    await expect.element(field()).toHaveValue("Next draft");

    // Another turn's error and the SDK's status after it: no read, the question still held.
    socket.receive({ type: "cf_agent_use_chat_response", id: "resumed", body: "boom", done: true, error: true });
    await settled();
    expect(fetch.requests).toHaveLength(2);
    await expect.element(sendButton()).toBeDisabled();

    socket.receive(listFrame([question(id, "First?")]));
    await expect.element(sendButton()).toBeEnabled();
    await expect.element(field()).toHaveValue("Next draft");

    // The next question goes before the first's request ends (the server stores a question before its turn).
    await ask("Second?");
    await expect.poll(() => chatRequests(sockets)).toHaveLength(2);
    const second = chatRequests(sockets)[1];
    const secondId = idOf(second);
    expect(second?.messages).toEqual([{ id: secondId, role: "user", parts: [{ type: "text", text: "Second?" }] }]);
    socket.receive(done(first?.id ?? ""));
    await settled();
    socket.receive({ type: "prq:history-changed" });
    (await fetch.request(2)).respond([question(id, "First?")]);
    await settled();
    expect(page.getByText("Not sent").elements()).toEqual([]);
    await expect.element(sendButton()).toBeDisabled();
    socket.receive({ type: "prq:history-changed" });
    (await fetch.request(3)).respond([question(id, "First?"), question(secondId, "Second?")]);
    await expect.element(sendButton()).toBeEnabled();
    expect(shown()).toEqual(["First?", "Second?"]);
  });

  test("a refused send whose read lacks it is Not sent, the newer draft kept; Try again resends it whole under its ID as the same row; Discard frees the slot and returns focus to the field (P3.3)", async () => {
    const { fetch, sockets, socket } = await ready();
    await ask("Lost?");
    await expect.poll(() => chatRequests(sockets)).toHaveLength(1);
    const [first] = chatRequests(sockets);
    const sent = first?.messages[0];
    await userEvent.fill(field(), "Newer draft");
    socket.receive(refused(first?.id ?? ""));
    (await fetch.request(2)).respond([]);
    await expect.element(page.getByText("Not sent")).toBeVisible();
    await expect.element(field()).toHaveValue("Newer draft");
    await expect.element(page.getByText("You can send once the question above is sent or discarded.")).toBeVisible();

    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => chatRequests(sockets)).toHaveLength(2);
    expect(chatRequests(sockets)[1]?.messages).toEqual([sent]);
    expect(shown()).toEqual(["Lost?"]);
    socket.receive(refused(chatRequests(sockets)[1]?.id ?? ""));
    (await fetch.request(3)).respond([]);
    await expect.element(page.getByText("Not sent")).toBeVisible();

    await page.getByRole("button", { name: "Discard" }).click();
    expect(shown()).toEqual([]);
    await expect.element(field()).toHaveFocus();
    await expect.element(sendButton()).toBeEnabled();
  });

  test("a silent socket settles the send at SEND_SETTLE_MS, not a tick before; Try again then acknowledges (P3.3)", async () => {
    const { fetch, sockets, socket } = await ready();
    await userEvent.fill(field(), "Anyone?");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    document.querySelector("form")?.requestSubmit();
    await until(() => chatRequests(sockets).length === 1);
    await vi.advanceTimersByTimeAsync(SEND_SETTLE_MS - 1);
    expect(fetch.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    (await fetch.request(2)).respond([]);
    await expect.element(page.getByText("Not sent")).toBeVisible();

    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => chatRequests(sockets)).toHaveLength(2);
    socket.receive(listFrame([question(idOf(chatRequests(sockets)[1]), "Anyone?")]));
    await expect.element(sendButton()).toBeEnabled();
    expect(page.getByText("Not sent").elements()).toEqual([]);
    expect(shown()).toEqual(["Anyone?"]);
  });

  test("a reconcile that never completes shows Couldn't confirm at SEND_SETTLE_MS, through navigation away and back, until a read holding it acknowledges it (P3.3)", async () => {
    const { fetch, sockets, socket, show } = await ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ask("Saved?");
    await expect.poll(() => chatRequests(sockets)).toHaveLength(1);
    const [first] = chatRequests(sockets);
    const id = idOf(first);
    socket.receive(done(first?.id ?? ""));
    await fetch.request(2);
    await vi.advanceTimersByTimeAsync(SEND_SETTLE_MS - 1);
    expect(page.getByText("Couldn't confirm it was sent").elements()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect.element(page.getByText("Couldn't confirm it was sent")).toBeVisible();

    await show(false);
    await show(true);
    await vi.advanceTimersByTimeAsync(0);
    const reopened = await connect(sockets, 1);
    (await fetch.request(3)).respond([]);
    (await fetch.request(4)).respond([]);
    await expect.element(page.getByText("Couldn't confirm it was sent")).toBeVisible();
    expect(shown()).toEqual(["Saved?"]);

    reopened.receive({ type: "prq:history-changed" });
    (await fetch.request(5)).respond([question(id, "Saved?")]);
    await expect.element(sendButton()).toBeEnabled();
    expect(page.getByText("Couldn't confirm it was sent").elements()).toEqual([]);
    expect(shown()).toEqual(["Saved?"]);
  });

  test("a held reconcile is decided by the reopen's or history-changed read that replaces it, the held result changing nothing (P3.3)", async () => {
    const { fetch, sockets, socket } = await ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ask("One?");
    await expect.poll(() => chatRequests(sockets)).toHaveLength(1);
    socket.receive(done(chatRequests(sockets)[0]?.id ?? ""));
    const held = await fetch.request(2);
    socket.drop();
    await reconnect(sockets, 1);
    await connect(sockets, 1);
    (await fetch.request(3)).respond([]);
    await expect.element(page.getByText("Not sent")).toBeVisible();
    held.respond([]);
    await vi.advanceTimersByTimeAsync(0);
    await expect.element(page.getByText("Not sent")).toBeVisible();
    await page.getByRole("button", { name: "Discard" }).click();

    await ask("Two?");
    await expect.poll(() => chatRequests(sockets)).toHaveLength(2);
    const second = chatRequests(sockets)[1];
    const id = idOf(second);
    const reopened = await sockets.socket(1);
    reopened.receive(done(second?.id ?? ""));
    const heldAgain = await fetch.request(4);
    reopened.receive({ type: "prq:history-changed" });
    (await fetch.request(5)).respond([question(id, "Two?")]);
    await expect.element(sendButton()).toBeEnabled();
    heldAgain.respond([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown()).toEqual(["Two?"]);
    expect(page.getByText("Not sent").elements()).toEqual([]);
  });

  test("closed while the request is prepared, the send waits for the reopen, whose read marks nothing, and the flushed request's list acknowledges it (P3.3)", async () => {
    const { fetch, sockets, socket } = await ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await userEvent.fill(field(), "Queued?");
    const form = document.querySelector("form");
    form?.requestSubmit();
    socket.drop();
    const reopened = await reconnect(sockets, 1);
    reopened.open();
    await expect.poll(() => chatRequests(sockets)).toHaveLength(1);
    const id = idOf(chatRequests(sockets)[0]);
    (await fetch.request(2)).respond([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(page.getByText("Not sent").elements()).toEqual([]);
    await expect.element(sendButton()).toBeDisabled();
    reopened.receive(listFrame([question(id, "Queued?")]));
    await expect.element(sendButton()).toBeEnabled();
    expect(shown()).toEqual(["Queued?"]);
  });

  test("a question held for the reopen, Not sent and discarded, never reaches the socket when it opens (P3.3)", async () => {
    const { fetch, sockets, socket } = await ready();
    await userEvent.fill(field(), "Gone?");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    socket.drop();
    document.querySelector("form")?.requestSubmit();
    await until(() => document.querySelector("[data-component=Message]") !== null);
    await vi.advanceTimersByTimeAsync(SEND_SETTLE_MS);
    (await fetch.request(2)).respond([]);
    await until(() => textOf("[data-component=Message]").includes("Not sent"));
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Discard")?.click();
    await until(() => document.querySelector("[data-component=Message]") === null);
    const latest = await reconnect(sockets, sockets.sockets.length);
    latest.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(chatRequests(sockets)).toEqual([]);
  });

  test("a cut before the server took the question ends Not sent; one after it was stored, before the list and the terminal frame, ends acknowledged (P3.3)", async () => {
    const { fetch, sockets, socket } = await ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ask("Dropped?");
    await expect.poll(() => chatRequests(sockets)).toHaveLength(1);
    socket.drop();
    (await fetch.request(2)).respond([]);
    await expect.element(page.getByText("Not sent")).toBeVisible();
    await page.getByRole("button", { name: "Discard" }).click();
    await reconnect(sockets, 1);
    const reopened = await connect(sockets, 1);
    (await fetch.request(3)).respond([]);

    await ask("Stored?");
    await expect.poll(() => chatRequests(sockets)).toHaveLength(2);
    const id = idOf(chatRequests(sockets)[1]);
    reopened.drop();
    (await fetch.request(4)).respond([question(id, "Stored?")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(page.getByText("Not sent").elements()).toEqual([]);
    expect(shown()).toEqual(["Stored?"]);
    expect(document.querySelector("[data-component=Message]")?.getAttribute("data-state")).toBe("sent");
  });
});

// A job turn's stream as the session broadcasts it: one request's frames, its start naming the job and the run.
const frame = (wire: string, body: object, extra: object = {}) => ({
  type: "cf_agent_use_chat_response",
  id: wire,
  body: JSON.stringify(body),
  done: false,
  ...extra,
});
const startOf = (wire: string, messageId: string, metadata: object, extra: object = {}) => [
  frame(wire, { type: "start", messageId, messageMetadata: metadata }, extra),
  frame(wire, { type: "text-start", id: "text" }, extra),
];
const delta = (wire: string, text: string, extra: object = {}) =>
  frame(wire, { type: "text-delta", id: "text", delta: text }, extra);
const answerRun = (run: number) => ({ kind: "answer", jobId: "j1", questionId: "q1", sha: HEAD, run, by: BY });
// A run of j1's text that stopped, stored with the reason the job failed with.
const incompleteAnswer = (run: number, text: string) => ({
  ...answer("j1", "q1", text),
  id: `answer-j1-r${run}-incomplete`,
  metadata: { ...answerRun(run), incomplete: { reason: "lost" } },
});

function receiveAll(socket: TestSocket, frames: object[]) {
  for (const sent of frames) {
    socket.receive(sent);
  }
}

describe("streamed text", () => {
  test("stays until its own run's row: a fresh stream of the run replaces it on its first text; a failed read, the done view and a stale read keep it; the cloud turn's line names cloud and its start, without Retry (P3.4, P3.13)", async () => {
    const { fetch, sockets } = await detail();
    // The turn started (its last change) five minutes after the job was made.
    const running: JobSpec[] = [{ id: "j1", question: "q1", state: "running", at: T0 + 5 * 60_000 }];
    const socket = await connect(sockets, 0, running);
    (await fetch.request(0)).respond([question("q1", "Why?")]);
    (await fetch.request(1)).respond([question("q1", "Why?")]);
    receiveAll(socket, [...startOf("w1", "answer-j1", answerRun(1)), delta("w1", "Old text")]);
    await expect.element(page.getByText("Old text")).toBeVisible();
    await expect.element(page.getByText("cloud · started 10:19").first()).toBeVisible();
    await expect.element(page.getByText("Answering")).toBeVisible();
    expect(page.getByRole("button", { name: "Retry" }).elements()).toEqual([]);

    // The run again under a new request (a rerun after a context overflow).
    receiveAll(socket, startOf("w2", "answer-j1", answerRun(1)));
    await settled();
    await expect.element(page.getByText("Old text")).toBeVisible();
    socket.receive(delta("w2", "Fresh text"));
    await expect.element(page.getByText("Fresh text")).toBeVisible();
    expect(page.getByText("Old text").elements()).toEqual([]);

    socket.receive(done("w2"));
    socket.receive({ type: "cf_agent_state", state: sessionView([{ id: "j1", question: "q1", state: "done" }]) });
    socket.receive({ type: "prq:history-changed" });
    (await fetch.request(2)).fail();
    await expect.element(page.getByText("Couldn't refresh the summary and conversation")).toBeVisible();
    socket.receive({ type: "prq:history-changed" });
    (await fetch.request(3)).respond([question("q1", "Why?")]);
    await settled();
    expect(shown()).toEqual(["Why?", "Fresh text"]);

    socket.receive(listFrame([question("q1", "Why?"), answer("j1", "q1", "Stored text")]));
    await expect.element(page.getByText("Stored text")).toBeVisible();
    expect(shown()).toEqual(["Why?", "Stored text"]);
  });

  test("a retried job shows run 1's incomplete row, arriving late, and run 2's text, which a shorter replay never shrinks (P3.4)", async () => {
    const { fetch, sockets } = await detail();
    const running: JobSpec[] = [{ id: "j1", question: "q1", state: "running" }];
    const socket = await connect(sockets, 0, running);
    (await fetch.request(0)).respond([question("q1", "Why?")]);
    (await fetch.request(1)).respond([question("q1", "Why?")]);
    receiveAll(socket, [...startOf("w1", "answer-j1", answerRun(1)), delta("w1", "Run one")]);
    await expect.element(page.getByText("Run one")).toBeVisible();
    socket.receive({ type: "cf_agent_use_chat_response", id: "w1", body: "failed", done: true, error: true });
    socket.receive({ type: "prq:history-changed" });
    const late = await fetch.request(2);
    receiveAll(socket, [...startOf("w2", "answer-j1", answerRun(2)), delta("w2", "Run two, longer")]);
    await expect.poll(shown).toEqual(["Why?", "Run one", "Run two, longer"]);
    late.respond([
      question("q1", "Why?"),
      {
        ...answer("j1", "q1", "Run one"),
        id: "answer-j1-1",
        metadata: { ...answerRun(1), incomplete: { reason: "failed" } },
      },
    ]);
    await expect.element(page.getByText("Incomplete — failed")).toBeVisible();
    expect(shown()).toEqual(["Why?", "Run one", "Run two, longer"]);

    // The connection drops and the session replays run 2's request from its start, shorter than what was shown.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    socket.drop();
    const reopened = await reconnect(sockets, 1);
    reopened.open();
    reopened.receive({ type: "cf_agent_state", state: sessionView(running) });
    reopened.receive({ type: "cf_agent_stream_resuming", id: "w2" });
    receiveAll(reopened, [
      ...startOf("w2", "answer-j1", answerRun(2), { replay: true }),
      delta("w2", "Run", { replay: true }),
      { type: "cf_agent_use_chat_response", id: "w2", body: "", done: false, replay: true, replayComplete: true },
    ]);
    await nextTask();
    await vi.advanceTimersByTimeAsync(100);
    await nextTask();
    expect(shown()).toEqual(["Why?", "Run one", "Run two, longer"]);

    // Run 2's result is stored before the view says the job is done: one answer for the run, none still answering.
    reopened.receive(
      listFrame([
        question("q1", "Why?"),
        {
          ...answer("j1", "q1", "Run one"),
          id: "answer-j1-1",
          metadata: { ...answerRun(1), incomplete: { reason: "failed" } },
        },
        { ...answer("j1", "q1", "Run two, stored"), metadata: answerRun(2) },
      ]),
    );
    await until(() => shown().includes("Run two, stored"));
    expect(shown()).toEqual(["Why?", "Run one", "Run two, stored"]);
    expect(document.querySelectorAll("[data-component=Message][data-role=answer]")).toHaveLength(2);
  });

  test("an incomplete answer stored before the failed view ends its run's answering row; the failed view puts Retry on it (carried M4)", async () => {
    const { fetch, sockets } = await detail();
    const socket = await connect(sockets, 0, [{ id: "j1", question: "q1", state: "running" }]);
    (await fetch.request(0)).respond([question("q1", "Why?")]);
    (await fetch.request(1)).respond([question("q1", "Why?")]);
    receiveAll(socket, [...startOf("w1", "answer-j1", answerRun(1)), delta("w1", "Partial")]);
    await expect.element(page.getByText("Partial")).toBeVisible();
    socket.receive({ type: "cf_agent_use_chat_response", id: "w1", body: "lost", done: true, error: true });
    socket.receive(listFrame([question("q1", "Why?"), incompleteAnswer(1, "Partial")]));
    await expect.element(page.getByText("Incomplete — lost")).toBeVisible();
    expect(shown()).toEqual(["Why?", "Partial"]);
    expect(page.getByText("Answering").elements()).toEqual([]);
    expect(page.getByRole("button", { name: "Retry" }).elements()).toEqual([]);

    socket.receive({
      type: "cf_agent_state",
      state: sessionView([{ id: "j1", question: "q1", state: "failed", rev: 4, failure: "lost" }]),
    });
    await expect
      .poll(() => document.querySelector(".conversation [data-component=Message][data-state=incomplete] button"))
      .not.toBeNull();
    expect(shown()).toEqual(["Why?", "Partial"]);
  });

  test("a retry's running view, while the read holding run 1's incomplete row is out, shows run 2's answering row before its first frame (carried M4)", async () => {
    const { fetch, sockets } = await detail();
    const socket = await connect(sockets, 0, [{ id: "j1", question: "q1", state: "running" }]);
    (await fetch.request(0)).respond([question("q1", "Why?")]);
    (await fetch.request(1)).respond([question("q1", "Why?")]);
    receiveAll(socket, [...startOf("w1", "answer-j1", answerRun(1)), delta("w1", "Run one")]);
    await expect.element(page.getByText("Run one")).toBeVisible();
    socket.receive({ type: "cf_agent_use_chat_response", id: "w1", body: "lost", done: true, error: true });
    socket.receive({ type: "prq:history-changed" });
    const held = await fetch.request(2);
    socket.receive({
      type: "cf_agent_state",
      state: sessionView([{ id: "j1", question: "q1", state: "running", rev: 6, run: 2, at: T0 + 5 * 60_000 }]),
    });
    await expect.element(page.getByText("Answering")).toBeVisible();
    expect(textOf(".conversation [data-component=Message] .running")).toBe("Answeringcloud · started 10:19");

    held.respond([question("q1", "Why?"), incompleteAnswer(1, "Run one")]);
    await expect.element(page.getByText("Incomplete — lost")).toBeVisible();
    await expect.element(page.getByText("Answering")).toBeVisible();
    receiveAll(socket, [...startOf("w2", "answer-j1", answerRun(2)), delta("w2", "Run two")]);
    await expect.element(page.getByText("Run two")).toBeVisible();
    expect(shown()).toEqual(["Why?", "Run one", "Run two"]);
    expect(document.querySelectorAll(".conversation [data-component=Message] .running")).toHaveLength(1);
  });
});

const contextLine = () => document.querySelector("[data-component=Composer] .context")?.textContent ?? null;

describe("versions", () => {
  test("the default is the latest completed by completion; a pick stays through view updates; the running version picked shows its text until its row, after its done view too; the composer names the latest analyzed head (P3.10)", async () => {
    const { fetch, sockets } = await detail();
    const THIRD = "0123456789abcdef0123456789abcdef01234567";
    const NEWEST = "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
    // Created first, completed last; then a later head completed earlier.
    const jobs: JobSpec[] = [
      { id: "a1", analysis: OLDER, at: T0 + 100 },
      { id: "a2", analysis: HEAD, at: T0 + 50 },
      { id: "j1", question: "q1" },
    ];
    const socket = await connect(sockets, 0, jobs);
    const history = [
      analysis("a1", OLDER, "Completed last"),
      analysis("a2", HEAD, "Completed earlier"),
      question("q1", "Which head?"),
      answer("j1", "q1", "That one.", { sha: THIRD }),
    ];
    (await fetch.request(0)).respond(history);
    (await fetch.request(1)).respond(history);
    await expect.element(page.getByText("Completed last")).toBeVisible();
    expect(document.querySelector(".answered-at")?.textContent).toBe(`Answered at ${THIRD.slice(0, 7)}`);
    expect(contextLine()).toBeNull();

    await page
      .getByRole("complementary")
      .getByRole("button", { name: new RegExp(`^${HEAD}`) })
      .click();
    await expect.element(page.getByText("Completed earlier")).toBeVisible();
    await expect.poll(contextLine).toBe(`Questions are answered at ${OLDER.slice(0, 7)} (latest)`);

    const newest: JobSpec = { id: "a3", analysis: NEWEST, state: "running", at: T0 + 200 };
    socket.receive({ type: "cf_agent_state", state: sessionView([...jobs, newest]) });
    await expect
      .poll(() => document.querySelector("[data-component=Summary] .progress")?.textContent)
      .toBe(`Summarizing ${NEWEST.slice(0, 7)}`);
    await expect.element(page.getByText("Completed earlier")).toBeVisible();

    const metadata = { kind: "analysis", jobId: "a3", headSha: NEWEST, run: 1, by: BY };
    receiveAll(socket, [...startOf("w3", "analysis-a3", metadata), delta("w3", "Streaming summary")]);
    await page
      .getByRole("complementary")
      .getByRole("button", { name: new RegExp(`^${NEWEST}`) })
      .click();
    await expect.element(page.getByText("Streaming summary")).toBeVisible();
    await expect.element(page.getByText("Writing")).toBeVisible();
    await expect.poll(contextLine).toBe(`Questions are answered at ${OLDER.slice(0, 7)} (latest)`);

    socket.receive(done("w3"));
    socket.receive({
      type: "cf_agent_state",
      state: sessionView([...jobs, { ...newest, state: "done", at: T0 + 300 }]),
    });
    socket.receive({ type: "prq:history-changed" });
    (await fetch.request(2)).respond(history);
    await settled();
    await expect.element(page.getByText("Streaming summary")).toBeVisible();
    socket.receive(listFrame([...history, analysis("a3", NEWEST, "Stored summary")]));
    await expect.element(page.getByText("Stored summary")).toBeVisible();
    expect(page.getByText("Streaming summary").elements()).toEqual([]);
    expect(contextLine()).toBeNull();
  });
});

describe("the connection", () => {
  test("a close shows the reconnecting banner and the composer's reason; no open for RECONNECT_FAILED_MS, not a tick less, shows the failed banner with Reload; an open restores the page and reads history (P3.12)", async () => {
    const { fetch, sockets, socket } = await ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    socket.drop();
    await until(() => textOf("[data-component=Composer] .reason").includes("Reconnecting."));
    expect(textOf("[data-component=ConnectionBanner]")).toContain("Reconnecting… Showing the last known content.");
    expect(textOf("[data-component=Composer] .reason")).toContain(
      "Reconnecting. You can send once the connection is back.",
    );
    expect(document.querySelector("textarea")?.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(RECONNECT_FAILED_MS - 1);
    expect(page.getByText("Can't reconnect. Try reloading the page.").elements()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect.element(page.getByText("Can't reconnect. Try reloading the page.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect.element(page.getByText("Disconnected. You can send once the connection is back.")).toBeVisible();

    const reads = fetch.requests.length;
    const latest = await reconnect(sockets, sockets.sockets.length);
    latest.open();
    await expect.poll(() => fetch.requests.length).toBe(reads + 1);
    expect(page.getByText("Can't reconnect. Try reloading the page.").elements()).toEqual([]);
    await expect.element(field()).not.toHaveAttribute("aria-disabled");
    await expect.element(sendButton()).toBeEnabled();
  });

  test("the page loads until the first view and the first history read, Send off and the draft kept meanwhile; an unknown pull request shows only after both (P3.15)", async () => {
    const { fetch, sockets } = await detail();
    const socket = await sockets.socket(0);
    await expect.poll(() => document.querySelector("[data-component=Summary]")?.getAttribute("aria-busy")).toBe("true");
    socket.open();
    socket.receive({
      type: "cf_agent_state",
      state: v.parse(PrSessionView, { pr: REF, details: null, owner: null, jobs: [] }),
    });
    await settled();
    expect(page.getByText("Unknown pull request").elements()).toEqual([]);
    expect(document.querySelector("[data-component=Summary]")?.getAttribute("aria-busy")).toBe("true");
    await userEvent.fill(field(), "Early?");
    await expect.element(sendButton()).toBeDisabled();
    document.querySelector("form")?.requestSubmit();
    await settled();
    expect(chatRequests(sockets)).toEqual([]);
    await expect.element(field()).toHaveValue("Early?");
    (await fetch.request(0)).respond([]);
    await expect.element(page.getByRole("heading", { level: 1, name: "Unknown pull request" })).toBeVisible();
    await expect.element(page.getByText("prq has nothing for shuymn/prq#42.", { exact: false })).toBeVisible();
  });
});

const RETRY = "/api/pr/shuymn/prq/42/jobs/j1/retry";
const retryPosts = (fetch: ReturnType<typeof controlledFetch>) =>
  fetch.requests.filter((request) => request.method === "POST" && request.url.pathname === RETRY);
// The Retry buttons, found without a locator: under fake timers a locator's retries would move the clock.
const retryButtons = () => [...document.querySelectorAll("button")].filter((button) => button.textContent === "Retry");

// j1, the answer to q1, failed without text at rev 3, as the session shows it once its history is read.
async function failed() {
  const opened = await detail();
  const socket = await connect(opened.sockets, 0, [
    { id: "j1", question: "q1", state: "failed", rev: 3, failure: "step limit reached" },
  ]);
  (await opened.fetch.request(0)).respond([question("q1", "Why?")]);
  (await opened.fetch.request(1)).respond([question("q1", "Why?")]);
  await expect.element(page.getByText("Incomplete — step limit reached")).toBeVisible();
  return { ...opened, socket };
}

describe("a job's Retry", () => {
  test("is offered on a claimed job, before and after the stall mark, and a failed one, on no other (P4.4)", async () => {
    const { fetch, sockets } = await detail();
    const states: JobSpec[] = [
      { id: "pending", question: "q-pending", state: "pending" },
      { id: "claimed", question: "q-claimed", state: "claimed", agentId: "laptop" },
      { id: "stalled", question: "q-stalled", state: "claimed", agentId: "laptop", stalled: true },
      { id: "running", question: "q-running", state: "running" },
      { id: "failed", question: "q-failed", state: "failed", failure: "step limit reached" },
      { id: "done", question: "q-done", state: "done" },
      { id: "superseded", analysis: OLDER, state: "superseded" },
    ];
    const socket = await sockets.socket(0);
    socket.open();
    socket.receive({ type: "cf_agent_state", state: sessionView(states, "local") });
    const history = states.flatMap((spec) => ("question" in spec ? [question(spec.question, spec.id)] : []));
    (await fetch.request(0)).respond(history);
    (await fetch.request(1)).respond(history);
    await expect.element(page.getByText("Incomplete — step limit reached")).toBeVisible();
    const rows = [...document.querySelectorAll(".rail [data-component=JobRow]")].map((row) => [
      row.querySelector(".cut")?.textContent,
      row.querySelector("button")?.textContent ?? null,
    ]);
    expect(rows).toEqual([
      ["pending", null],
      ["claimed", "Retry"],
      ["stalled", "Retry"],
      ["running", null],
      ["failed", "Retry"],
      ["done", null],
    ]);
    // The failed answer's own, under its question.
    expect(retryButtons()).toHaveLength(4);
  });

  test("a press sends one POST from the shown rev, both of the job's Retry busy meanwhile; a 503 and a network failure each show the retry error at that job's Retry and send nothing again (P4.1, P4.5)", async () => {
    const { fetch } = await failed();
    await page.getByRole("button", { name: "Retry" }).first().click();
    await expect.poll(() => retryPosts(fetch)).toHaveLength(1);
    expect(JSON.parse(retryPosts(fetch)[0]?.body ?? "")).toEqual({ expectedRev: 3 });
    // The rail's and the answer's.
    expect(document.querySelectorAll("[data-component=Button][data-state=busy]")).toHaveLength(2);
    retryPosts(fetch)[0]?.respond({ error: "unavailable" }, 503);
    await expect.element(page.getByText(RETRY_ERROR).first()).toBeVisible();
    expect(page.getByText(RETRY_ERROR).elements()).toHaveLength(2);
    await settled();
    expect(retryPosts(fetch)).toHaveLength(1);

    await page.getByRole("button", { name: "Retry" }).first().click();
    await expect.poll(() => retryPosts(fetch)).toHaveLength(2);
    expect(page.getByText(RETRY_ERROR).elements()).toEqual([]);
    retryPosts(fetch)[1]?.fail();
    await expect.element(page.getByText(RETRY_ERROR).first()).toBeVisible();
    await settled();
    expect(retryPosts(fetch)).toHaveLength(2);
  });

  test("a retry nobody answers is busy for RETRY_ANSWER_MS, not a tick less, then shows the retry error; its late answer changes nothing (P4.5)", async () => {
    const { fetch } = await failed();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    retryButtons()[0]?.click();
    await until(() => retryPosts(fetch).length === 1);
    await vi.advanceTimersByTimeAsync(RETRY_ANSWER_MS - 1);
    expect(document.querySelectorAll("[data-component=Button][data-state=busy]")).toHaveLength(2);
    expect(textOf(".pr-detail")).not.toContain(RETRY_ERROR);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => textOf(".pr-detail").includes(RETRY_ERROR));
    expect(retryPosts(fetch)[0]?.signal.aborted).toBe(true);
    retryPosts(fetch)[0]?.respond({ status: "retried" });
    await vi.advanceTimersByTimeAsync(0);
    await nextTask();
    expect(textOf(".pr-detail")).toContain(RETRY_ERROR);
    expect(retryPosts(fetch)).toHaveLength(1);
  });

  test("a 409 withdraws that Retry while the view shows the rev it was sent from; with no newer view by RETRY_STALE_MS, not a tick less, the socket connects again and its view shows the job as it is (P4.3)", async () => {
    const { fetch, sockets, socket } = await failed();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    retryButtons()[0]?.click();
    await until(() => retryPosts(fetch).length === 1);
    retryPosts(fetch)[0]?.respond({ error: "stale_job" }, 409);
    await until(() => retryButtons().length === 0);
    expect(textOf(".pr-detail")).not.toContain(RETRY_ERROR);
    await vi.advanceTimersByTimeAsync(RETRY_STALE_MS - 1);
    // A reconnect closes the open socket at once.
    expect(socket.readyState).toBe(socket.OPEN);
    await vi.advanceTimersByTimeAsync(1);
    const reopened = await reconnect(sockets, 1);
    reopened.open();
    reopened.receive({
      type: "cf_agent_state",
      state: sessionView([{ id: "j1", question: "q1", state: "running", rev: 5, run: 2 }]),
    });
    await until(() => textOf(".conversation").includes("Answering"));
    expect(retryButtons()).toEqual([]);
    expect(retryPosts(fetch)).toHaveLength(1);
  });

  test("a 409 after a view with the job's newer rev leaves Retry from that view at once, and nothing connects again (P4.2, P4.3)", async () => {
    const { fetch, sockets, socket } = await failed();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    retryButtons()[0]?.click();
    await until(() => retryPosts(fetch).length === 1);
    socket.receive({
      type: "cf_agent_state",
      state: sessionView([{ id: "j1", question: "q1", state: "failed", rev: 5, failure: "step limit reached" }]),
    });
    retryPosts(fetch)[0]?.respond({ error: "stale_job" }, 409);
    await until(() => document.querySelectorAll("[data-component=Button][data-state=busy]").length === 0);
    expect(retryButtons()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RETRY_STALE_MS);
    expect(sockets.sockets).toHaveLength(1);
    retryButtons()[0]?.click();
    await until(() => retryPosts(fetch).length === 2);
    expect(JSON.parse(retryPosts(fetch)[1]?.body ?? "")).toEqual({ expectedRev: 5 });
  });

  test("with the socket down at the 409, nothing connects again but the reopen, whose view brings the job and its Retry from the new rev (P4.3)", async () => {
    const { fetch, sockets, socket } = await failed();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    retryButtons()[0]?.click();
    await until(() => retryPosts(fetch).length === 1);
    socket.drop();
    const reopened = await reconnect(sockets, 1);
    retryPosts(fetch)[0]?.respond({ error: "stale_job" }, 409);
    await until(() => retryButtons().length === 0);
    await vi.advanceTimersByTimeAsync(RETRY_STALE_MS);
    expect(sockets.sockets).toHaveLength(2);
    reopened.open();
    reopened.receive({
      type: "cf_agent_state",
      state: sessionView([{ id: "j1", question: "q1", state: "failed", rev: 7, failure: "step limit reached" }]),
    });
    await until(() => retryButtons().length === 2);
    retryButtons()[0]?.click();
    await until(() => retryPosts(fetch).length === 2);
    expect(JSON.parse(retryPosts(fetch)[1]?.body ?? "")).toEqual({ expectedRev: 7 });
  });

  test("leaving the page ends a retry: its request is aborted, and its late 409 connects nothing again (P4.3)", async () => {
    const { fetch, sockets, show } = await failed();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    retryButtons()[0]?.click();
    await until(() => retryPosts(fetch).length === 1);
    await show(false);
    expect(retryPosts(fetch)[0]?.signal.aborted).toBe(true);
    retryPosts(fetch)[0]?.respond({ error: "stale_job" }, 409);
    await vi.advanceTimersByTimeAsync(2 * RETRY_STALE_MS);
    expect(sockets.sockets).toHaveLength(1);
  });
});

describe("a retry's outcome", () => {
  test("holds for the rev it was sent from: a newer view while it is out ends it, so its late 503 marks nothing; after a 200, Retry stays withdrawn through a socket drop until the reopen's view (M2)", async () => {
    const { fetch, sockets, socket } = await failed();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    retryButtons()[0]?.click();
    await until(() => retryPosts(fetch).length === 1);
    socket.receive({
      type: "cf_agent_state",
      state: sessionView([
        { id: "j1", question: "q1", state: "failed", rev: 6, run: 2, failure: "step limit reached" },
      ]),
    });
    await until(() => document.querySelectorAll("[data-component=Button][data-state=busy]").length === 0);
    expect(retryPosts(fetch)[0]?.signal.aborted).toBe(true);
    retryPosts(fetch)[0]?.respond({ error: "unavailable" }, 503);
    await vi.advanceTimersByTimeAsync(0);
    await nextTask();
    expect(textOf(".pr-detail")).not.toContain(RETRY_ERROR);
    expect(retryButtons()).toHaveLength(2);

    retryButtons()[0]?.click();
    await until(() => retryPosts(fetch).length === 2);
    expect(JSON.parse(retryPosts(fetch)[1]?.body ?? "")).toEqual({ expectedRev: 6 });
    retryPosts(fetch)[1]?.respond({ status: "retried" });
    await until(() => retryButtons().length === 0);
    socket.drop();
    const reopened = await reconnect(sockets, 1);
    expect(retryButtons()).toEqual([]);
    reopened.open();
    reopened.receive({
      type: "cf_agent_state",
      state: sessionView([{ id: "j1", question: "q1", state: "running", rev: 7, run: 3 }]),
    });
    await until(() => textOf(".conversation").includes("Answering"));
    expect(retryButtons()).toEqual([]);
    expect(retryPosts(fetch)).toHaveLength(2);
    expect(sockets.sockets).toHaveLength(2);
  });

  test("each failed retry is announced once, in the order they fail, whichever was sent first (L2)", async () => {
    const counts: number[] = [];
    function Announced() {
      const { assertive } = useAnnouncements();
      useEffect(() => {
        counts.push(assertive.count);
      }, [assertive.count]);
      return null;
    }
    await render(<Announced />);
    const { fetch, sockets } = await detail();
    await connect(sockets, 0, [
      { id: "j1", question: "q1", state: "failed", rev: 3, failure: "step limit reached" },
      { id: "j2", question: "q2", state: "failed", rev: 3, failure: "step limit reached" },
    ]);
    const history = [question("q1", "Why?"), question("q2", "How?")];
    (await fetch.request(0)).respond(history);
    (await fetch.request(1)).respond(history);
    await expect.poll(() => document.querySelectorAll(".rail [data-component=JobRow] button")).toHaveLength(2);
    const [first, second] = document.querySelectorAll<HTMLButtonElement>(".rail [data-component=JobRow] button");
    first?.click();
    second?.click();
    const post = (jobId: string) =>
      fetch.requests.find((request) => request.url.pathname === `/api/pr/shuymn/prq/42/jobs/${jobId}/retry`);
    await expect.poll(() => post("j2")).toBeDefined();
    const before = counts.at(-1) ?? 0;
    post("j2")?.respond({ error: "unavailable" }, 503);
    await expect.poll(() => counts.at(-1)).toBe(before + 1);
    post("j1")?.respond({ error: "unavailable" }, 503);
    await expect.poll(() => counts.at(-1)).toBe(before + 2);
  });
});

describe("the summary and the rail", () => {
  test("a failed newer analysis shows its Notice with the reason and Retry above the completed summary, which stays readable (P4.6)", async () => {
    const { fetch, sockets } = await detail();
    await connect(sockets, 0, [
      { id: "a1", analysis: OLDER },
      {
        id: "a2",
        analysis: HEAD,
        state: "failed",
        rev: 2,
        failure: "provider refused the request (HTTP 402): spend limit",
      },
    ]);
    const history = [analysis("a1", OLDER, "The completed summary.")];
    (await fetch.request(0)).respond(history);
    (await fetch.request(1)).respond(history);
    await expect.element(page.getByText("The completed summary.")).toBeVisible();
    const notice = document.querySelector("[data-component=Summary] [data-component=Notice]");
    expect(notice?.textContent).toBe(
      "Summary of e4f5a6b failedProvider refused the request (HTTP 402): spend limit. The summary below is for a1b2c3d.Retry",
    );
    const body = document.querySelector("[data-component=Summary] > .body");
    expect(body === null ? 0 : (notice?.compareDocumentPosition(body) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    await page.getByRole("button", { name: "Retry" }).first().click();
    await expect
      .poll(() => fetch.requests.filter((request) => request.method === "POST").map((request) => request.url.pathname))
      .toEqual(["/api/pr/shuymn/prq/42/jobs/a2/retry"]);
  });

  test("done jobs collapse into N done; the collapsed rail stays collapsed across a reload, and the summary's version menu still picks a version (P4.8)", async () => {
    const { fetch, sockets, show } = await detail();
    const jobs: JobSpec[] = [
      { id: "a1", analysis: OLDER },
      { id: "a2", analysis: HEAD },
      { id: "j1", question: "q1" },
    ];
    const history = [
      analysis("a1", OLDER, "Older summary."),
      analysis("a2", HEAD, "Latest summary."),
      question("q1", "Why?"),
      answer("j1", "q1", "Because."),
    ];
    await connect(sockets, 0, jobs);
    (await fetch.request(0)).respond(history);
    (await fetch.request(1)).respond(history);
    await expect.element(page.getByText("Latest summary.")).toBeVisible();
    await expect.element(page.getByText("3 done")).toBeVisible();
    expect(document.querySelectorAll(".rail details [data-component=JobRow]")).toHaveLength(3);
    await page.getByRole("button", { name: "Collapse rail" }).click();
    await expect.element(page.getByRole("button", { name: "Expand rail", exact: true })).toBeVisible();
    expect(page.getByRole("heading", { name: "Versions" }).elements()).toEqual([]);

    await show(false);
    await show(true);
    await connect(sockets, 1, jobs);
    (await fetch.request(2)).respond(history);
    (await fetch.request(3)).respond(history);
    await expect.element(page.getByText("Latest summary.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Expand rail", exact: true })).toBeVisible();
    expect(page.getByRole("heading", { name: "Versions" }).elements()).toEqual([]);
    const trigger = document.querySelector("[data-component=VersionMenu] .trigger");
    expect(trigger).not.toBeNull();
    if (trigger !== null) {
      await page.elementLocator(trigger).click();
    }
    await page.getByRole("menuitemradio", { name: new RegExp(`^${OLDER.slice(0, 7)}`) }).click();
    await expect.element(page.getByText("Older summary.")).toBeVisible();
  });
});
