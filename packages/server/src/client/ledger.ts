// The PR list's rows (plan §1.5): GET /api/ledger a page at a time, under one generation that covers paging,
// refreshes and filters. A pass reads from no cursor through the requested depth, stopping at the last page, and then
// replaces the rows at once; the rows shown stay until then, and no next page continues them until the pass gives its
// cursor. The depth only grows until the filter changes, which resets it to one: a continuation (the next page, read
// into the rows shown) raises it to the pages it reaches for, so a pass that replaces another reads as deep. A new
// generation (a filter change, a refresh the Hub's view asks for, Try again) aborts the requests in flight and discards
// whatever they bring: a result is adopted only while its generation's signal is not aborted.

import { type HubView, LedgerPage, LedgerQuery, type LedgerRow } from "@prq/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import type * as v from "valibot";

import { type Fetch, readJson } from "./reads.ts";

// What the list asks for: open (or all) pull requests, of one repository or all, or those needing attention.
export type ListFilter = { attention: true } | { attention: false; state: "open" | "all"; repo: string | null };

// The query string of a ledger page. Its type is the protocol's: an attention query cannot carry `state` or `repo`.
export function ledgerSearch(query: v.InferInput<typeof LedgerQuery>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(name, value);
    }
  }
  return params.toString();
}

function pageUrl(filter: ListFilter, cursor: string | null): string {
  const page = cursor === null ? {} : { cursor };
  const query = filter.attention
    ? ledgerSearch({ attention: "1", ...page })
    : ledgerSearch({ state: filter.state, ...(filter.repo === null ? {} : { repo: filter.repo }), ...page });
  return `/api/ledger?${query}`;
}

export type LedgerSnapshot = {
  // The rows shown and the filter they answer, null until a pass first completes.
  rows: LedgerRow[] | null;
  filter: ListFilter;
  // Whether the next page can be read (not while a pass that replaces the rows has yet to give its cursor), and whether
  // it is being read into the rows.
  more: boolean;
  loadingMore: boolean;
  // A failed read: the first pass ("load", nothing to show) or a later one ("refresh", the rows kept).
  failure: "load" | "refresh" | null;
};

// The Hub's view as far as the rows depend on it: a stored entry advances ledgerVersion, and a row's problem depends
// on presence. opens counts the Hub socket's opens.
type HubSignal = { view: Pick<HubView, "ledgerVersion" | "localAgentPresent"> | null; opens: number };

export class LedgerReader {
  readonly #fetch: Fetch;
  #filter: ListFilter;
  #depth = 1;
  #controller = new AbortController();
  #cursor: string | null = null;
  #pages = 0;
  #seen: HubSignal | null = null;
  #snapshot: LedgerSnapshot;
  readonly #listeners = new Set<() => void>();

  constructor(fetcher: Fetch, filter: ListFilter) {
    this.#fetch = fetcher;
    this.#filter = filter;
    this.#snapshot = { rows: null, filter, more: false, loadingMore: false, failure: null };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  snapshot = (): LedgerSnapshot => this.#snapshot;

  #update(change: Partial<LedgerSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) {
      listener();
    }
  }

  // A new generation: the requests in flight are aborted, and a pass reads through the depth. The rows shown are
  // replaced once it completes, so no page continues them meanwhile.
  refresh(): void {
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#cursor = null;
    if (this.#snapshot.more || this.#snapshot.loadingMore) {
      this.#update({ more: false, loadingMore: false });
    }
    void this.#pass(this.#controller.signal, this.#filter, this.#depth);
  }

  async #pass(signal: AbortSignal, filter: ListFilter, depth: number): Promise<void> {
    const rows: LedgerRow[] = [];
    let cursor: string | null = null;
    let pages = 0;
    try {
      do {
        const page: LedgerPage = await readJson(this.#fetch, pageUrl(filter, cursor), LedgerPage, signal);
        if (signal.aborted) {
          return;
        }
        rows.push(...page.rows);
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < depth);
    } catch {
      if (!signal.aborted) {
        this.#update({ failure: this.#snapshot.rows === null ? "load" : "refresh" });
      }
      return;
    }
    this.#cursor = cursor;
    this.#pages = pages;
    this.#update({ rows, filter, more: cursor !== null, failure: null });
  }

  // The next page, read into the rows shown, in the current generation.
  loadMore(): void {
    const cursor = this.#cursor;
    if (cursor === null || this.#snapshot.loadingMore || this.#snapshot.failure !== null) {
      return;
    }
    const signal = this.#controller.signal;
    this.#depth = Math.max(this.#depth, this.#pages + 1);
    this.#update({ loadingMore: true });
    readJson(this.#fetch, pageUrl(this.#filter, cursor), LedgerPage, signal).then(
      (page) => {
        if (signal.aborted) {
          return;
        }
        this.#cursor = page.nextCursor;
        this.#pages += 1;
        this.#update({
          rows: [...(this.#snapshot.rows ?? []), ...page.rows],
          more: page.nextCursor !== null,
          loadingMore: false,
        });
      },
      () => {
        if (!signal.aborted) {
          this.#update({ loadingMore: false, failure: "refresh" });
        }
      },
    );
  }

  setFilter(filter: ListFilter): void {
    if (JSON.stringify(filter) === JSON.stringify(this.#filter)) {
      return;
    }
    this.#filter = filter;
    this.#depth = 1;
    this.refresh();
  }

  // A change of the Hub's view or socket: the rows are read again when ledgerVersion or presence changed, when the
  // socket reopened, or when the first view arrives after a pass began (which may predate an entry). Any other change
  // of the view (the counts, a second agent's presence) reads nothing.
  hubChanged(hub: HubSignal): void {
    const seen = this.#seen;
    this.#seen = hub;
    if (seen === null) {
      return;
    }
    const reopened = hub.opens > seen.opens && seen.opens > 0;
    const firstView = seen.view === null && hub.view !== null;
    const changed =
      seen.view !== null &&
      hub.view !== null &&
      (seen.view.ledgerVersion !== hub.view.ledgerVersion ||
        seen.view.localAgentPresent !== hub.view.localAgentPresent);
    if (reopened || firstView || changed) {
      this.refresh();
    }
  }

  // The first pass, with the Hub as it is now.
  start(hub: HubSignal): void {
    this.#seen = hub;
    this.refresh();
  }

  // Ends the generation: whatever is in flight is aborted and discarded.
  stop(): void {
    this.#controller.abort();
  }
}

// The reader of a mounted list: it starts on mount with the Hub as it is, follows the filter and the Hub, and stops
// on unmount.
export function useLedger(fetcher: Fetch, filter: ListFilter, hub: HubSignal): [LedgerSnapshot, LedgerReader] {
  const [reader] = useState(() => new LedgerReader(fetcher, filter));
  const snapshot = useSyncExternalStore(reader.subscribe, reader.snapshot);
  // The Hub as it was at mount, which the first pass starts from.
  const [initial] = useState(hub);
  // The effects run in order: the first pass, then the filter and the Hub, which change nothing at mount.
  useEffect(() => {
    reader.start(initial);
    return () => reader.stop();
  }, [reader, initial]);
  useEffect(() => {
    reader.setFilter(filter);
  }, [reader, filter]);
  useEffect(() => {
    reader.hubChanged(hub);
  }, [reader, hub]);
  return [snapshot, reader];
}
