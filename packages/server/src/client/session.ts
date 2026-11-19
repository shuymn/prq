// A pull request's session as the detail shows it (plan §1.6–§1.8): its view (the Agent state), its stored history,
// the text each job run streams, the connection and the server's version, over one socket; and this page's question
// that history has yet to hold (slots.ts). The SDK's chat hook sends questions and assembles streams; what the page
// shows of history comes from the loader here, never from the SDK's own list.
//
// The loader reads the stored history on mount, on every open, on Try again, after a send settles and on
// prq:history-changed. A list, read or sent, replaces the shown one only when it holds every message shown (R3), so a
// late, stale or failed read changes nothing shown; reads never cancel each other. A run's streamed text, by
// (jobId, run) from its stream's start, gives way only to a stored row of that run.

import { useAgentChat } from "@cloudflare/ai-chat/react";
import {
  HistoryChangedMessage,
  MessageMetadata,
  type PrRef,
  PrSessionView,
  ServerVersionMessage,
  sessionName,
} from "@prq/protocol";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as v from "valibot";

import { type Fetch, readJson, useFetch } from "./reads.ts";
import { type SendSlots, type Slot, startRead, useSlot, useSlots } from "./slots.ts";

// How long the connection may stay without an open, after a close or from the first connect, before the page offers
// Reload. PartySocket keeps trying meanwhile.
export const RECONNECT_FAILED_MS = 15_000;

export type Connection = "connecting" | "open" | "reconnecting" | "failed";

// A stored message as the page shows it: its text parts joined, and its metadata as the protocol reads it.
export type StoredMessage = {
  id: string;
  role: "system" | "user" | "assistant";
  text: string;
  metadata: MessageMetadata | null;
};

// What a job's run has streamed so far, and whether its stream has ended.
export type RunText = { jobId: string; run: number; metadata: MessageMetadata; text: string; done: boolean };

export type Session = {
  view: PrSessionView | null;
  // Until the first history read completes; failed while no read has succeeded and the latest failed.
  history: "loading" | "ready" | "failed";
  // The latest read failed after one had succeeded: what is shown is as last read.
  refreshFailed: boolean;
  messages: readonly StoredMessage[];
  runs: readonly RunText[];
  connection: Connection;
  serverVersion: string | null;
};

const ChatMessage = v.looseObject({
  id: v.string(),
  role: v.picklist(["system", "user", "assistant"]),
  parts: v.array(v.looseObject({ type: v.string() })),
  metadata: v.optional(v.unknown()),
});
type ChatMessage = v.InferOutput<typeof ChatMessage>;
const History = v.array(ChatMessage);

const ListFrame = v.looseObject({ type: v.literal("cf_agent_chat_messages"), messages: History });
const ResponseFrame = v.looseObject({
  type: v.literal("cf_agent_use_chat_response"),
  id: v.string(),
  body: v.optional(v.string()),
  done: v.optional(v.boolean()),
  error: v.optional(v.boolean()),
});
type ResponseFrame = v.InferOutput<typeof ResponseFrame>;
// A frame of the session's socket the page reads, by its type; any other is ignored.
const Frame = v.pipe(
  v.string(),
  v.parseJson(),
  v.variant("type", [ListFrame, HistoryChangedMessage, ServerVersionMessage, ResponseFrame]),
);
const StartChunk = v.pipe(
  v.string(),
  v.parseJson(),
  v.looseObject({ type: v.literal("start"), messageId: v.string(), messageMetadata: MessageMetadata }),
);

const textOf = (parts: readonly { type: string; text?: unknown }[]) =>
  parts.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : "")).join("");

const storedMessage = (message: ChatMessage): StoredMessage => {
  const metadata = v.safeParse(MessageMetadata, message.metadata);
  return {
    id: message.id,
    role: message.role,
    text: textOf(message.parts),
    metadata: metadata.success ? metadata.output : null,
  };
};

const holdsRun = (messages: readonly StoredMessage[], jobId: string, run: number) =>
  messages.some((message) => message.metadata?.jobId === jobId && message.metadata.run === run);

// A run's text and, after its message's stream restarted under a new request, the text the SDK's copy held then: the
// shown text stays until the new stream's first other text.
type Run = RunText & { stale: string | null };

class SessionStore {
  #session: Session = {
    view: null,
    history: "loading",
    refreshFailed: false,
    messages: [],
    runs: [],
    connection: "connecting",
    serverVersion: null,
  };
  readonly #listeners = new Set<() => void>();
  readonly #reads = new Set<AbortController>();
  // Each streamed message's current request and run, and each request's run.
  readonly #streams = new Map<string, { wire: string; key: string }>();
  readonly #wires = new Map<string, string>();
  readonly #runs = new Map<string, Run>();
  // The number of the latest read whose outcome decides the failure shown.
  #outcome = 0;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #detach: (() => void) | undefined;
  #active = false;

  readonly name: string;
  readonly fetcher: Fetch;
  readonly slots: SendSlots;
  // Removes the SDK's copy of a message whose stream restarted; the hook gives it once the SDK's list exists.
  #drop: (messageId: string) => void = () => undefined;

  constructor(name: string, fetcher: Fetch, slots: SendSlots) {
    this.name = name;
    this.fetcher = fetcher;
    this.slots = slots;
  }

  dropWith(drop: (messageId: string) => void): void {
    this.#drop = drop;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  snapshot = (): Session => this.#session;

  // Once the socket's listeners are attached: the mount read, and the bound on the first connect.
  start(): void {
    this.#active = true;
    this.#detach = this.slots.attach(this.name, () => this.read());
    if (this.#session.connection !== "open") {
      this.#arm();
    }
    this.read();
  }

  // The page left the session: no read in flight is applied, no timer runs.
  stop(): void {
    this.#active = false;
    this.#detach?.();
    clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    for (const read of this.#reads) {
      read.abort();
    }
    this.#reads.clear();
  }

  read(): void {
    if (this.#active) {
      void this.#read(startRead());
    }
  }

  opened(): void {
    clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    this.#update({ connection: "open" });
    this.read();
  }

  closed(): void {
    if (this.#session.connection === "open") {
      this.#update({ connection: "reconnecting" });
    }
    this.#arm();
  }

  viewed(state: unknown): void {
    const view = v.safeParse(PrSessionView, state);
    if (view.success) {
      this.#update({ view: view.output });
    }
  }

  message(event: MessageEvent): void {
    const frame = v.safeParse(Frame, event.data);
    if (!frame.success) {
      return;
    }
    const { output } = frame;
    switch (output.type) {
      case "cf_agent_chat_messages":
        this.#listed(output.messages, null);
        break;
      case "prq:history-changed":
        this.read();
        break;
      case "prq:version":
        this.#update({ serverVersion: output.version });
        break;
      case "cf_agent_use_chat_response":
        this.#response(output);
        break;
    }
  }

  // The SDK's messages: each streamed message's text, taken into its run when it extends what is shown, or, after its
  // stream restarted, when it is the new stream's.
  observe(messages: readonly UIMessage[]): void {
    let changed = false;
    for (const message of messages) {
      const run = this.#runs.get(this.#streams.get(message.id)?.key ?? "");
      if (run === undefined) {
        continue;
      }
      const text = textOf(message.parts);
      const taken =
        run.stale === null
          ? text.length > run.text.length && text.startsWith(run.text)
          : text !== "" && text !== run.stale;
      if (taken) {
        run.text = text;
        run.stale = null;
        changed = true;
      }
    }
    if (changed) {
      this.#update({ runs: this.#runList() });
    }
  }

  async #read(read: number): Promise<void> {
    const controller = new AbortController();
    this.#reads.add(controller);
    const url = `/agents/pr-session/${encodeURIComponent(this.name)}/get-messages`;
    try {
      const messages = await readJson(this.fetcher, url, History, controller.signal);
      this.#listed(messages, read);
      const latest = read > this.#outcome;
      this.#outcome = Math.max(this.#outcome, read);
      this.#update({ history: "ready", refreshFailed: latest ? false : this.#session.refreshFailed });
    } catch {
      if (controller.signal.aborted) {
        return;
      }
      this.slots.readFailed(this.name, read);
      if (read > this.#outcome) {
        this.#outcome = read;
        this.#update(this.#session.history === "ready" ? { refreshFailed: true } : { history: "failed" });
      }
    } finally {
      this.#reads.delete(controller);
    }
  }

  // A stored list, read (its number) or sent by the socket (null).
  #listed(messages: readonly ChatMessage[], read: number | null): void {
    const stored = messages.map(storedMessage);
    const ids = new Set(stored.map((message) => message.id));
    this.slots.listed(this.name, ids, read);
    if (!this.#session.messages.every((message) => ids.has(message.id))) {
      return;
    }
    for (const [key, run] of this.#runs) {
      if (holdsRun(stored, run.jobId, run.run)) {
        this.#runs.delete(key);
      }
    }
    this.#update({ messages: stored, runs: this.#runList() });
  }

  #response(frame: ResponseFrame): void {
    const start = frame.body === undefined ? null : v.safeParse(StartChunk, frame.body);
    if (start?.success === true) {
      this.#started(frame.id, start.output.messageId, start.output.messageMetadata);
    }
    const run = this.#runs.get(this.#wires.get(frame.id) ?? "");
    if ((frame.done === true || frame.error === true) && run !== undefined && !run.done) {
      run.done = true;
      this.#update({ runs: this.#runList() });
    }
  }

  // A stream's start. The same request again is a replay, which changes nothing; a new request for the message is a
  // fresh stream (a rerun of the run, or a later run), whose SDK copy starts from the stale one's text.
  #started(wire: string, messageId: string, metadata: MessageMetadata): void {
    const { jobId, run } = metadata;
    const previous = this.#streams.get(messageId);
    if (run === undefined || previous?.wire === wire) {
      return;
    }
    const key = `${jobId}:${run}`;
    this.#streams.set(messageId, { wire, key });
    this.#wires.set(wire, key);
    if (previous !== undefined) {
      this.#drop(messageId);
    }
    if (holdsRun(this.#session.messages, jobId, run)) {
      return;
    }
    const stale = previous === undefined ? null : (this.#runs.get(previous.key)?.text ?? "");
    const text = this.#runs.get(key)?.text ?? "";
    this.#runs.set(key, { jobId, run, metadata, text, done: false, stale });
    this.#update({ runs: this.#runList() });
  }

  #arm(): void {
    if (this.#reconnect === undefined && this.#active) {
      this.#reconnect = setTimeout(() => {
        this.#reconnect = undefined;
        this.#update({ connection: "failed" });
      }, RECONNECT_FAILED_MS);
    }
  }

  #runList(): RunText[] {
    return [...this.#runs.values()].map(({ jobId, run, metadata, text, done }) => ({
      jobId,
      run,
      metadata,
      text,
      done,
    }));
  }

  #update(change: Partial<Session>): void {
    this.#session = { ...this.#session, ...change };
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

// The socket the session connects with: the browser's, or the one a test gives.
export const SocketContext = createContext<{
  WebSocket?: new (url: string | URL, protocols?: string | string[]) => EventTarget;
}>({});

type SessionHandle = {
  session: Session;
  slot: Slot | null;
  // Sends a question unless one is held; whether it was sent.
  send: (text: string) => boolean;
  retry: () => void;
  discard: () => void;
  // Try again after a failed read.
  read: () => void;
};

export function useSession(ref: PrRef): SessionHandle {
  const name = sessionName(ref);
  const fetcher = useFetch();
  const slots = useSlots();
  const socket = useContext(SocketContext);
  const [store] = useState(() => new SessionStore(name, fetcher, slots));

  const agent = useAgent({
    agent: "pr-session",
    name,
    ...socket,
    onOpen: () => store.opened(),
    onClose: () => store.closed(),
    onMessage: (event: MessageEvent) => store.message(event),
    onStateUpdate: (state: unknown) => store.viewed(state),
  });
  // The question being sent: the request carries it alone, under its own ID (the server stores new IDs only).
  const outgoing = useRef<UIMessage[]>([]);
  const chat = useAgentChat({
    agent,
    getInitialMessages: null,
    syncMessagesToServer: false,
    resume: true,
    prepareSendMessagesRequest: () => ({ body: { messages: outgoing.current } }),
  });
  const { messages, setMessages, sendMessage } = chat;

  useEffect(() => {
    store.dropWith((messageId) => setMessages((current) => current.filter((message) => message.id !== messageId)));
  }, [store, setMessages]);
  useEffect(() => store.observe(messages), [store, messages]);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  const session = useSyncExternalStore(store.subscribe, store.snapshot);
  const slot = useSlot(slots, name);
  const transmit = (sent: Slot) => {
    const message: UIMessage = { id: sent.id, role: "user", parts: [{ type: "text", text: sent.text }] };
    outgoing.current = [message];
    slots.sending(name, sent.attempt, sendMessage(message));
  };
  return {
    session,
    slot,
    send: (text) => {
      const reserved = slots.reserve(name, text);
      if (reserved !== null) {
        transmit(reserved);
      }
      return reserved !== null;
    },
    retry: () => {
      const again = slots.retry(name);
      if (again !== null) {
        transmit(again);
      }
    },
    discard: () => slots.discard(name),
    read: () => store.read(),
  };
}
