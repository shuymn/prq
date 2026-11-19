// The questions this page sent that stored history has yet to hold (plan §1.6, R1 and R2): one per session, kept for
// the page's life, so in-app navigation keeps it. Only a stored list holding a question's ID acknowledges it, at any
// time. Its send settles when its request ends or SEND_SETTLE_MS after Send; the first history read started after that
// to complete decides: without the ID "Not sent", failed or none within SEND_SETTLE_MS "Couldn't confirm it was sent".
// Each attempt is its own entry, so what an earlier one, or an earlier question, leaves behind changes nothing.

import { createContext, useContext, useSyncExternalStore } from "react";

// Longer than the server's 30 s write-queue wait: a failed intake leaves the socket open with no terminal frame.
export const SEND_SETTLE_MS = 45_000;

type SlotPhase = "pending" | "settled" | "not-sent" | "unconfirmed";

export type Slot = {
  readonly id: string;
  readonly text: string;
  // When it was first sent.
  readonly at: number;
  readonly phase: SlotPhase;
};

// How a read decided against the question's send, if it did: what its row, the composer, Try again and the
// announcement go by.
export const failureOf = (slot: Slot | null): "not-sent" | "unconfirmed" | null =>
  slot?.phase === "not-sent" || slot?.phase === "unconfirmed" ? slot.phase : null;

type Entry = { slot: Slot; settledAt: number; timer: ReturnType<typeof setTimeout> };

// The page's history reads, numbered from one counter, so a send can tell the reads started after it settled.
let reads = 0;
export const startRead = (): number => ++reads;

export class SendSlots {
  readonly #entries = new Map<string, Entry>();
  readonly #readers = new Map<string, () => void>();
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  slot(session: string): Slot | null {
    return this.#entries.get(session)?.slot ?? null;
  }

  // Whether any session holds a question: reloading the page would lose it.
  held(): boolean {
    return this.#entries.size > 0;
  }

  // A new question in the session's slot, or null while the slot holds one.
  reserve(session: string, text: string): Slot | null {
    if (this.#entries.has(session)) {
      return null;
    }
    return this.#begin(session, { id: crypto.randomUUID(), text, at: Date.now(), phase: "pending" });
  }

  // Try again: the same question, as a new attempt, once a read has decided against the last one.
  retry(session: string): Slot | null {
    const entry = this.#entries.get(session);
    if (entry === undefined || failureOf(entry.slot) === null) {
      return null;
    }
    return this.#begin(session, { ...entry.slot, phase: "pending" });
  }

  // The request of the attempt `sent` began: its end settles that attempt alone.
  sending(session: string, sent: Slot, request: Promise<unknown>): void {
    const entry = this.#entries.get(session);
    if (entry?.slot !== sent) {
      return;
    }
    const settle = () => this.#settle(session, entry);
    request.then(settle, settle);
  }

  // A stored list: holding the question acknowledges it; a read started after the send settled that lacks it decides
  // "Not sent". `read` is the list's read number, null for a list the socket sent.
  listed(session: string, ids: ReadonlySet<string>, read: number | null): void {
    const entry = this.#entries.get(session);
    if (entry === undefined) {
      return;
    }
    if (ids.has(entry.slot.id)) {
      this.discard(session);
    } else if (read !== null) {
      this.#decide(session, entry, read, "not-sent");
    }
  }

  // A history read that failed: the deciding read failing leaves the send unconfirmed.
  readFailed(session: string, read: number): void {
    const entry = this.#entries.get(session);
    if (entry !== undefined) {
      this.#decide(session, entry, read, "unconfirmed");
    }
  }

  discard(session: string): void {
    const entry = this.#entries.get(session);
    if (entry !== undefined) {
      clearTimeout(entry.timer);
      this.#entries.delete(session);
      this.#notify();
    }
  }

  // The session's loader, which a settled send asks for a read; none while the session is not shown.
  attach(session: string, read: () => void): () => void {
    this.#readers.set(session, read);
    return () => {
      if (this.#readers.get(session) === read) {
        this.#readers.delete(session);
      }
    };
  }

  #begin(session: string, slot: Slot): Slot {
    const entry: Entry = {
      slot,
      settledAt: 0,
      timer: setTimeout(() => this.#settle(session, entry), SEND_SETTLE_MS),
    };
    this.#entries.set(session, entry);
    this.#notify();
    return slot;
  }

  #settle(session: string, entry: Entry): void {
    if (this.#entries.get(session) !== entry || entry.slot.phase !== "pending") {
      return;
    }
    clearTimeout(entry.timer);
    entry.settledAt = reads;
    entry.slot = { ...entry.slot, phase: "settled" };
    entry.timer = setTimeout(
      () => this.#decide(session, entry, Number.POSITIVE_INFINITY, "unconfirmed"),
      SEND_SETTLE_MS,
    );
    this.#notify();
    this.#readers.get(session)?.();
  }

  // The first outcome of a read started after the send settled, or the bound's end, decides a settled send.
  #decide(session: string, entry: Entry, read: number, phase: "not-sent" | "unconfirmed"): void {
    if (this.#entries.get(session) !== entry || entry.slot.phase !== "settled" || read <= entry.settledAt) {
      return;
    }
    clearTimeout(entry.timer);
    entry.slot = { ...entry.slot, phase };
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

// The page's slots; a test gives its own.
export const SlotsContext = createContext(new SendSlots());

export function useSlots(): SendSlots {
  return useContext(SlotsContext);
}

export function useSlot(slots: SendSlots, session: string): Slot | null {
  return useSyncExternalStore(slots.subscribe, () => slots.slot(session));
}

export function useUnsent(): boolean {
  const slots = useSlots();
  return useSyncExternalStore(slots.subscribe, () => slots.held());
}
