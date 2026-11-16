import type { AIChatAgent } from "@cloudflare/ai-chat";
import { HistoryChangedMessage } from "@prq/protocol";
import { WebSocketChatTransport } from "agents/chat/transport";
import type { UIMessage } from "ai";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prSessionStub } from "./names.ts";
import { CHAT_REQUEST_REFUSED } from "./pr-session/history.ts";
import type { PrSession } from "./pr-session/index.ts";
import { captureLogs, type LogEntry } from "./test/access.ts";
import { type AgentSocket, answer, connect, hostToken, question, storedMessages } from "./test/chat.ts";
import { latch } from "./test/latch.ts";
import { hydrateRecent } from "./test/session.ts";

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q1 = question("q1");
const Q2 = question("q2");
const Q3 = question("q3");
const A1 = answer("a1");

// A fresh pull request per test, its route, and a token to reach it.
let prNumber = 0;
async function session() {
  prNumber += 1;
  const ref = { owner: "octo", repo: "demo", number: prNumber };
  const path = `/agents/pr-session/octo~demo~${prNumber}`;
  const token = await hostToken();
  const open = async () => {
    const socket = await connect(path, token);
    sockets.push(socket);
    return socket;
  };
  return { stub: await prSessionStub(env, ref), path, token, open };
}

// The server's own append, as the job code makes it: through persistMessages on the instance.
async function serverAppend(stub: DurableObjectStub<PrSession>, message: UIMessage): Promise<void> {
  await runInDurableObject(stub, (instance) => instance.persistMessages([message]));
}

// The promise's outcome, or a rejection when it is still pending after WAIT_MS.
async function settled<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${WAIT_MS} ms`)), WAIT_MS);
  });
  try {
    return await Promise.race([promise, pending]);
  } finally {
    clearTimeout(timer);
  }
}

const WAIT_MS = 2000;

function refusals(logs: LogEntry[]): unknown[] {
  return logs.filter((log) => log.entry["event"] === "prq.chat.refused").map((log) => log.entry["type"]);
}

describe("resend without the answer", () => {
  it("keeps an answer the client's list lacks, and sends the stored list to the sender", async () => {
    captureLogs();
    const { stub, path, token, open } = await session();
    const sender = await open();
    const observer = await open();
    await sender.chat([Q1]);
    await sender.chat([Q1, Q2]);
    await serverAppend(stub, A1);
    const from = await sender.received(A1.id);

    await sender.chat([Q1, Q2]);

    expect(await storedMessages(path, token)).toEqual([Q1, Q2, A1]);
    expect(sender.chatLists(from).at(-1)).toEqual([Q1, Q2, A1]);
    expect(observer.chatLists().at(-1)).toEqual([Q1, Q2, A1]);
  });

  it("keeps an answer appended after the client's request arrived and before it was saved", async () => {
    captureLogs();
    const { stub, path, token, open } = await session();
    const sender = await open();
    const observer = await open();
    await sender.chat([Q1]);
    await sender.chat([Q1, Q2]);
    // The hold is made and released inside the object: a promise continues in the context that settles it.
    let entered = false;
    let release: (() => void) | null = null;
    await runInDurableObject(stub, (instance) => {
      const held = latch();
      release = () => held.open();
      const save = instance.persistMessages.bind(instance);
      vi.spyOn(instance, "persistMessages").mockImplementationOnce(async (...args) => {
        entered = true;
        await held.promise;
        return save(...args);
      });
    });

    let resent = false;
    const resend = sender.chat([Q1, Q2]).then(() => {
      resent = true;
    });
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 2000 });
    // The object keeps serving while the request is held, and the held request has not finished.
    expect(await storedMessages(path, token)).toEqual([Q1, Q2]);
    expect(resent).toBe(false);
    await serverAppend(stub, A1);
    const from = await sender.received(A1.id);
    await runInDurableObject(stub, () => release?.());
    await resend;

    expect(await storedMessages(path, token)).toEqual([Q1, Q2, A1]);
    expect(sender.chatLists(from).at(-1)).toEqual([Q1, Q2, A1]);
    expect(observer.chatLists().at(-1)).toEqual([Q1, Q2, A1]);
  });
});

describe("one write at a time", () => {
  it("queues a server append behind a client's save, so the last list sent is the stored one", async () => {
    captureLogs();
    const { stub, path, token, open } = await session();
    const sender = await open();
    const observer = await open();
    await sender.chat([Q1, Q2]);
    // Holds the SDK's save (AIChatAgent.prototype.persistMessages, inside the queue) for the next write, and marks
    // the server append's arrival at PrSession.persistMessages, before the queue.
    let entered = false;
    let appendArrived = false;
    let release: (() => void) | null = null;
    await runInDurableObject(stub, (instance) => {
      const held = latch();
      release = () => held.open();
      const base: AIChatAgent<Env> = Object.getPrototypeOf(Object.getPrototypeOf(instance));
      const save = base.persistMessages.bind(instance);
      vi.spyOn(base, "persistMessages").mockImplementationOnce(async (...args) => {
        entered = true;
        await held.promise;
        return save(...args);
      });
      const persist = instance.persistMessages.bind(instance);
      vi.spyOn(instance, "persistMessages").mockImplementation(async (messages) => {
        appendArrived ||= messages.some((message) => message.id === A1.id);
        return persist(messages);
      });
    });

    const asked = sender.chat([Q1, Q2, Q3]);
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 2000 });
    let appended = false;
    const append = serverAppend(stub, A1).then(() => {
      appended = true;
    });
    await vi.waitFor(() => expect(appendArrived).toBe(true), { timeout: 2000 });
    // The object keeps serving while the save is held, and the append, which has arrived, waits for it.
    expect(await storedMessages(path, token)).toEqual([Q1, Q2]);
    expect(appended).toBe(false);
    await runInDurableObject(stub, () => release?.());
    await Promise.all([asked, append]);
    await sender.received(A1.id);
    await observer.received(A1.id);

    expect(await storedMessages(path, token)).toEqual([Q1, Q2, Q3, A1]);
    expect(sender.chatLists().at(-1)).toEqual([Q1, Q2, Q3, A1]);
    expect(observer.chatLists().at(-1)).toEqual([Q1, Q2, Q3, A1]);
  });
});

describe("clients only add", () => {
  // The frames that write history other than through a chat request, each as a client could send it.
  const frames: Record<string, Record<string, unknown>> = {
    cf_agent_chat_clear: { type: "cf_agent_chat_clear" },
    cf_agent_chat_messages: {
      type: "cf_agent_chat_messages",
      messages: [question("q1", "edited"), Q2, Q3],
    },
    cf_agent_tool_result: {
      type: "cf_agent_tool_result",
      toolCallId: "call-1",
      toolName: "tool",
      output: "forged",
      autoContinue: false,
    },
    cf_agent_tool_approval: {
      type: "cf_agent_tool_approval",
      toolCallId: "call-1",
      approved: true,
      autoContinue: false,
    },
  };

  // An answer whose tool call waits for its result: the state tool-result and tool-approval frames update.
  const waiting: UIMessage = {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text: "answer a1" },
      { type: "tool-lookup", toolCallId: "call-1", state: "input-available", input: {} },
    ],
  };

  it.for(Object.entries(frames))("refuses a %s frame and keeps the history", async ([type, frame]) => {
    const logs = captureLogs();
    const { stub, path, token, open } = await session();
    const client = await open();
    await client.chat([Q1, Q2]);
    await serverAppend(stub, waiting);
    const before = await storedMessages(path, token);

    client.send(frame);
    await vi.waitFor(() => expect(refusals(logs)).toEqual([type]), { timeout: 2000 });
    // Handled after the frame on the same connection, the resend of known questions adds nothing; then the SDK's
    // queue of tool updates (which a passed tool frame would have joined) has drained.
    await client.chat([Q1, Q2]);
    await runInDurableObject(stub, (instance) => Reflect.get(instance, "_interactionApplyTail"));

    expect(before).toEqual([Q1, Q2, waiting]);
    expect(await storedMessages(path, token)).toEqual(before);
  });

  it("adds only the new question when a request edits a stored one", async () => {
    captureLogs();
    const { stub, path, token, open } = await session();
    const client = await open();
    const observer = await open();
    await client.chat([Q1, Q2]);
    await serverAppend(stub, A1);

    await client.chat([question("q1", "edited"), Q3]);
    await observer.received(Q3.id);

    expect(await storedMessages(path, token)).toEqual([Q1, Q2, A1, Q3]);
    expect(client.chatLists().at(-1)).toEqual([Q1, Q2, A1, Q3]);
    // The other connections receive stored lists only, never the client's list the SDK would relay before saving.
    expect(observer.chatLists().flat()).not.toContainEqual(question("q1", "edited"));
  });

  it("adds only questions: drops a new answer or system message from a chat request", async () => {
    const logs = captureLogs();
    const { stub, path, token, open } = await session();
    const client = await open();
    const observer = await open();
    await client.chat([Q1]);
    await serverAppend(stub, A1);
    const forged: UIMessage[] = [
      answer("answer-job-1", "client supplied answer"),
      { id: "system-1", role: "system", parts: [{ type: "text", text: "client supplied instruction" }] },
    ];

    // A1 is stored, so the client's copy of it is an echo, not an addition.
    await client.chat([Q1, A1, ...forged, Q2]);

    expect(await storedMessages(path, token)).toEqual([Q1, A1, Q2]);
    expect(logs.filter((log) => log.entry["event"] === "prq.chat.refused").map((log) => log.entry)).toEqual([
      {
        event: "prq.chat.refused",
        pr: `octo~demo~${prNumber}`,
        type: "cf_agent_use_chat_request",
        messages: 2,
      },
    ]);
    // The list the SDK relays to the other connections is the request as passed on, without them.
    const relayed = observer
      .chatLists()
      .flat()
      .map((message) => message.id);
    expect(relayed).not.toContain("answer-job-1");
    expect(relayed).not.toContain("system-1");
  });

  it("refuses a whole chat request whose messages are not all in the current form", async () => {
    const logs = captureLogs();
    const { path, token, open } = await session();
    const client = await open();
    const observer = await open();
    await client.chat([Q1]);
    // An older message form (no ID, content instead of parts), which the SDK would convert, next to a new answer.
    const legacy = { role: "user", content: "legacy" };
    const body = JSON.stringify({ messages: [Q1, legacy, answer("forged")], trigger: "submit-message" });

    client.send({ type: "cf_agent_use_chat_request", id: "mixed", init: { method: "POST", body } });
    // Handled after that request on the same connection.
    await client.chat([Q1]);

    expect(await storedMessages(path, token)).toEqual([Q1]);
    expect(logs.filter((log) => log.entry["event"] === "prq.chat.refused").map((log) => log.entry)).toEqual([
      { event: "prq.chat.refused", pr: `octo~demo~${prNumber}`, type: "cf_agent_use_chat_request", malformed: true },
    ]);
    expect(
      observer
        .chatLists()
        .flat()
        .map((message) => message.id),
    ).not.toContain("forged");
  });

  it("fails a refused chat request in the SDK's client, which would otherwise wait for it", async () => {
    captureLogs();
    const { path, token, open } = await session();
    const client = await open();
    await client.chat([Q1]);
    // The SDK's own client transport, as useAgentChat sends with it, on this connection.
    const transport = new WebSocketChatTransport({ agent: client.transportConnection() });

    const stream = await transport.sendMessages({
      chatId: "chat",
      // An empty ID: not a message a chat request may carry.
      messages: [Q1, { ...Q2, id: "" }],
      trigger: "submit-message",
      abortSignal: undefined,
    });

    await expect(settled(stream.getReader().read())).rejects.toThrow(CHAT_REQUEST_REFUSED);
    expect(await storedMessages(path, token)).toEqual([Q1]);
  });

  it("keeps the answer a regenerate request leaves out", async () => {
    captureLogs();
    const { stub, path, token, open } = await session();
    const client = await open();
    await client.chat([Q1, Q2]);
    await serverAppend(stub, A1);

    await client.chat([Q1, Q2], "regenerate-message");

    expect(await storedMessages(path, token)).toEqual([Q1, Q2, A1]);
  });
});

// A question big enough that a 1-byte budget holds only the most recent one.
function long(id: string): UIMessage {
  return question(id, id.repeat(512));
}

describe("history outside the cache", () => {
  it("keeps a stored message the cache lacks, and sends the whole stored history", async () => {
    captureLogs();
    const { stub, path, token, open } = await session();
    const sender = await open();
    const observer = await open();
    await sender.chat([long("q1"), long("q2")]);
    expect(await hydrateRecent(stub, 1)).toEqual(["q2"]);
    // The budget back at its default: the stored history fits it, only the cache is partial.
    await runInDurableObject(stub, (instance) => {
      instance.hydrationByteBudget = 32 * 1024 * 1024;
    });
    const from = sender.frames.length;

    await sender.chat([question("q1", "edited"), long("q2"), Q3]);

    const stored = await storedMessages(path, token);
    expect(stored).toEqual([long("q1"), long("q2"), Q3]);
    expect(sender.chatLists(from).at(-1)).toEqual(stored);
    expect(observer.chatLists().at(-1)).toEqual(stored);
  });

  it("announces a change, not a partial list, after a server append over the budget", async () => {
    captureLogs();
    const { stub, path, token, open } = await session();
    const clients = [await open(), await open()];
    await clients[0]?.chat([long("q1"), long("q2")]);
    await runInDurableObject(stub, (instance) => {
      instance.hydrationByteBudget = 1;
    });
    const from = clients.map((client) => client.frames.length);

    await serverAppend(stub, A1);

    expect(await storedMessages(path, token)).toEqual([long("q1"), long("q2"), A1]);
    for (const [index, client] of clients.entries()) {
      const changed = await client.next((frame) => frame["type"] === "prq:history-changed", from[index]);
      expect(v.parse(HistoryChangedMessage, changed)).toEqual({ type: "prq:history-changed" });
      expect(client.chatLists(from[index])).toEqual([]);
    }
  });

  it("relays no list, the client's or a partial one, for a chat request over the budget", async () => {
    captureLogs();
    const { stub, path, token, open } = await session();
    const sender = await open();
    const observer = await open();
    await sender.chat([long("q1"), long("q2")]);
    await runInDurableObject(stub, (instance) => {
      instance.hydrationByteBudget = 1;
    });
    const from = { sender: sender.frames.length, observer: observer.frames.length };

    await sender.chat([long("q1"), long("q2"), Q3]);
    await observer.next((frame) => frame["type"] === "prq:history-changed", from.observer);

    expect(await storedMessages(path, token)).toEqual([long("q1"), long("q2"), Q3]);
    expect({ sender: sender.chatLists(from.sender), observer: observer.chatLists(from.observer) }).toEqual({
      sender: [],
      observer: [],
    });
    expect(sender.frames.slice(from.sender).map((frame) => frame["type"])).toContain("prq:history-changed");
  });
});

it("persistence is insert-only", async () => {
  captureLogs();
  const { stub, path, token, open } = await session();
  const client = await open();
  await client.chat([Q1, Q2]);
  await serverAppend(stub, A1);
  const before = await storedMessages(path, token);

  await runInDurableObject(stub, async (instance) => {
    // Called as the SDK calls it, with deletion of the stored rows the list lacks.
    const agent: AIChatAgent<Env> = instance;
    await agent.persistMessages([question("q1", "edited"), answer("a1", "edited"), Q3], [], { _deleteStaleRows: true });
  });

  expect(await storedMessages(path, token)).toEqual([...before, Q3]);
});
