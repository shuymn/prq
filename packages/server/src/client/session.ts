// A pull request's session as the detail shows it (plan §1.6–§1.8): its view (the Agent state), its stored history,
// the text each job run streams, the connection and the server's version, over one socket; and this page's question
// that history has yet to hold (slots.ts). The SDK's chat hook sends questions and assembles streams; what the page
// shows of history comes from the loader here, never from the SDK's own list.
//
// The loader reads the stored history on mount, on every open, on Try again, after a send settles and on
// prq:history-changed. A list, read or sent, replaces the shown one only when it holds every message shown (R3), so a
// late, stale or failed read changes nothing shown; reads never cancel each other. A run's streamed text, by
// (jobId, run) from its stream's start, gives way only to a stored row of that run.
//
// A job's Retry (plan §1.9) is one POST from the revision the page shows, never sent again, and what comes of it holds
// only for that revision: a view with another revision of the job ends it, whether its request is out (busy) or
// answered. Once the server took or refused it (2xx or 409), Retry is withdrawn until that view, and a reconnect after
// RETRY_STALE_MS brings the job's current state when none came; any other failure marks the job with the retry error.

import { useAgentChat } from "@cloudflare/ai-chat/react";
import {
  HistoryChangedMessage,
  MessageMetadata,
  type PrRef,
  PrSessionView,
  type RetryRequest,
  ServerVersionMessage,
  sessionName,
} from "@prq/protocol";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import * as v from "valibot";

import { type Fetch, readJson, useFetch } from "./reads.ts";
import { type SendSlots, type Slot, startRead, useSlot, useSlots } from "./slots.ts";

// How long the connection may stay without an open, after a close or from the first connect, before the page offers
// Reload. PartySocket keeps trying meanwhile.
export const RECONNECT_FAILED_MS = 15_000;

// A connection's bound on going without an open: arm() starts it unless it runs, and at its end `expire` runs;
// cancel() stops it. Its owner arms it after a close or at the first connect, and cancels it at an open or on leaving.
export function reconnectBound(expire: () => void): { arm(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    arm() {
      timer ??= setTimeout(() => {
        timer = undefined;
        expire();
      }, RECONNECT_FAILED_MS);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

// After a retry's 409, how long the page waits for a view with the job's newer revision before it reconnects, whose
// Agent state brings the job as it is.
export const RETRY_STALE_MS = 3_000;

// How long a retry may go unanswered before it counts as failed: longer than the route's own bound (ROUTE_CALL_MS), so
// the route's 503 comes first.
export const RETRY_ANSWER_MS = 45_000;

export type Connection = "connecting" | "open" | "reconnecting" | "failed";

// A job's retry from the revision `rev`: its request out (busy), answered by the server (withdrawn) or failed
// otherwise. `failure` numbers the page's failed retries in the order they failed (0 for the others).
type RetryMark = { rev: number; phase: "busy" | "withdrawn" | "failed"; failure: number };

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
  // The jobs' retries, by job.
  retries: Readonly<Record<string, RetryMark>>;
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
// A chat request the socket holds until it opens again, and the questions it carries.
const RequestFrame = v.pipe(
  v.string(),
  v.parseJson(),
  v.looseObject({
    type: v.literal("cf_agent_use_chat_request"),
    init: v.looseObject({
      body: v.pipe(v.string(), v.parseJson(), v.looseObject({ messages: v.array(v.looseObject({ id: v.string() })) })),
    }),
  }),
);
const StartChunk = v.pipe(
  v.string(),
  v.parseJson(),
  v.looseObject({ type: v.literal("start"), messageId: v.string(), messageMetadata: MessageMetadata }),
);

// A message's text as the UI shows it: its text parts after its last tool part. A cloud result's answer comes after the
// tool calls it read with, and text before them was the model's own narration; a message without tool parts (a
// question, a local agent's result) shows all of its text.
const textOf = (parts: readonly { type: string; text?: unknown }[]) =>
  parts
    .slice(parts.findLastIndex((part) => part.type === "dynamic-tool" || part.type.startsWith("tool-")) + 1)
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");

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
    retries: {},
  };
  readonly #listeners = new Set<() => void>();
  readonly #reads = new Set<AbortController>();
  // Each job's retry: its mark, the request while it is out, and its timer (the answer's bound while busy, the wait
  // for a newer view once withdrawn).
  readonly #retries = new Map<
    string,
    { mark: RetryMark; request: AbortController | null; timer: ReturnType<typeof setTimeout> | undefined }
  >();
  #failures = 0;
  // Each streamed message's current request and run, and each request's run.
  readonly #streams = new Map<string, { wire: string; key: string }>();
  readonly #wires = new Map<string, string>();
  readonly #runs = new Map<string, Run>();
  // The number of the latest read whose outcome decides the failure shown.
  #outcome = 0;
  readonly #reconnect = reconnectBound(() => this.#update({ connection: "failed" }));
  #detach: (() => void) | undefined;
  #active = false;

  readonly ref: PrRef;
  readonly name: string;
  readonly fetcher: Fetch;
  readonly slots: SendSlots;
  // Removes the SDK's copy of a message whose stream restarted; the hook gives it once the SDK's list exists.
  #drop: (messageId: string) => void = () => undefined;
  // Closes the socket and connects again; the hook gives it once the socket exists.
  #reopen: () => void = () => undefined;

  constructor(ref: PrRef, fetcher: Fetch, slots: SendSlots) {
    this.ref = ref;
    this.name = sessionName(ref);
    this.fetcher = fetcher;
    this.slots = slots;
  }

  dropWith(drop: (messageId: string) => void): void {
    this.#drop = drop;
  }

  reopenWith(reopen: () => void): void {
    this.#reopen = reopen;
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

  // The page left the session: no read or retry in flight is applied, no timer runs, no job is marked.
  stop(): void {
    this.#active = false;
    this.#detach?.();
    this.#reconnect.cancel();
    for (const read of this.#reads) {
      read.abort();
    }
    this.#reads.clear();
    for (const jobId of this.#retries.keys()) {
      this.#forget(jobId);
    }
    this.#update({ retries: {} });
  }

  read(): void {
    if (this.#active) {
      void this.#read(startRead());
    }
  }

  opened(): void {
    this.#reconnect.cancel();
    this.#update({ connection: "open" });
    this.read();
  }

  closed(): void {
    if (this.#session.connection === "open") {
      this.#update({ connection: "reconnecting" });
    }
    this.#arm();
  }

  // A view: a job shown at another revision than a mark's (or no longer shown) ends that mark, busy or answered.
  viewed(state: unknown): void {
    const view = v.safeParse(PrSessionView, state);
    if (!view.success) {
      return;
    }
    for (const [jobId, { mark }] of this.#retries) {
      const job = view.output.jobs.find((candidate) => candidate.jobId === jobId);
      if (job?.rev !== mark.rev) {
        this.#forget(jobId);
      }
    }
    this.#update({ view: view.output, retries: this.#retryMarks() });
  }

  // Retry of a job from the revision the page shows: one request, which nothing sends again. A busy job takes none.
  retry(jobId: string, rev: number): void {
    if (!this.#active || this.#retries.get(jobId)?.mark.phase === "busy") {
      return;
    }
    this.#forget(jobId);
    const mark: RetryMark = { rev, phase: "busy", failure: 0 };
    const request = new AbortController();
    const timer = setTimeout(() => this.#answered(jobId, mark, null), RETRY_ANSWER_MS);
    this.#retries.set(jobId, { mark, request, timer });
    this.#update({ retries: this.#retryMarks() });
    void this.#post(jobId, mark, request.signal);
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

  async #post(jobId: string, mark: RetryMark, signal: AbortSignal): Promise<void> {
    const { owner, repo, number } = this.ref;
    const path = [owner, repo, String(number), "jobs", jobId].map(encodeURIComponent).join("/");
    const body: RetryRequest = { expectedRev: mark.rev };
    let response: Response | null = null;
    try {
      response = await this.fetcher(`/api/pr/${path}/retry`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      // The request failed.
    }
    this.#answered(jobId, mark, response);
  }

  // A retry's answer (null when the request failed or RETRY_ANSWER_MS passed first), taken only while it is still the
  // job's mark, so the view still shows the revision it was sent from: the server took it (2xx) or refused it (409),
  // and Retry is withdrawn until the view shows the job's newer revision; anything else shows the retry error.
  #answered(jobId: string, mark: RetryMark, response: Response | null): void {
    if (this.#retries.get(jobId)?.mark !== mark) {
      return;
    }
    this.#forget(jobId);
    if (response !== null && (response.ok || response.status === 409)) {
      const withdrawn: RetryMark = { ...mark, phase: "withdrawn" };
      const timer = setTimeout(() => this.#stale(jobId, withdrawn), RETRY_STALE_MS);
      this.#retries.set(jobId, { mark: withdrawn, request: null, timer });
    } else {
      this.#failures += 1;
      this.#retries.set(jobId, {
        mark: { ...mark, phase: "failed", failure: this.#failures },
        request: null,
        timer: undefined,
      });
    }
    this.#update({ retries: this.#retryMarks() });
  }

  // No newer view came since the server answered: the socket connects again, whose Agent state brings the job as it
  // is. A socket that is down brings it when it opens.
  #stale(jobId: string, mark: RetryMark): void {
    const entry = this.#retries.get(jobId);
    if (entry?.mark !== mark) {
      return;
    }
    entry.timer = undefined;
    if (this.#session.connection === "open") {
      this.#reopen();
    }
  }

  // Ends a job's retry: its request, if out, is no longer awaited, and its timer stops.
  #forget(jobId: string): void {
    const entry = this.#retries.get(jobId);
    entry?.request?.abort();
    clearTimeout(entry?.timer);
    this.#retries.delete(jobId);
  }

  #retryMarks(): Record<string, RetryMark> {
    return Object.fromEntries([...this.#retries].map(([jobId, { mark }]) => [jobId, mark]));
  }

  #arm(): void {
    if (this.#active) {
      this.#reconnect.arm();
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
  // A job's Retry, from the revision shown.
  retryJob: (jobId: string, rev: number) => void;
};

// Takes the question's request out of what the socket holds for its next open, so a discarded question never reaches
// the server; the other frames stay queued in their order.
function unsend(socket: Pick<ReturnType<typeof useAgent>, "drainQueuedMessages" | "send">, id: string): void {
  for (const queued of socket.drainQueuedMessages()) {
    const request = v.safeParse(RequestFrame, queued);
    if (!request.success || !request.output.init.body.messages.some((message) => message.id === id)) {
      socket.send(queued);
    }
  }
}

export function useSession(ref: PrRef): SessionHandle {
  const name = sessionName(ref);
  const fetcher = useFetch();
  const slots = useSlots();
  const socket = useContext(SocketContext);
  const [store] = useState(() => new SessionStore(ref, fetcher, slots));

  const agent = useAgent({
    agent: "pr-session",
    name,
    ...socket,
    onOpen: () => store.opened(),
    onClose: () => store.closed(),
    onMessage: (event: MessageEvent) => store.message(event),
    onStateUpdate: (state: unknown) => store.viewed(state),
  });
  const chat = useAgentChat({ agent, getInitialMessages: null, syncMessagesToServer: false, resume: true });
  const { messages, setMessages, sendMessage } = chat;

  useEffect(() => {
    store.dropWith((messageId) => setMessages((current) => current.filter((message) => message.id !== messageId)));
  }, [store, setMessages]);
  useEffect(() => store.reopenWith(() => agent.reconnect()), [store, agent]);
  useEffect(() => store.observe(messages), [store, messages]);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  const session = useSyncExternalStore(store.subscribe, store.snapshot);
  const slot = useSlot(slots, name);
  // The request carries the question alone, under its own ID (the server stores new IDs only).
  const transmit = (sent: Slot) => {
    const message: UIMessage = { id: sent.id, role: "user", parts: [{ type: "text", text: sent.text }] };
    slots.sending(name, sent, sendMessage(message, { body: { messages: [message] } }));
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
    discard: () => {
      if (slot !== null) {
        unsend(agent, slot.id);
      }
      slots.discard(name);
    },
    read: () => store.read(),
    retryJob: (jobId, rev) => store.retry(jobId, rev),
  };
}
