// The present local agents for the pool's popover (plan §1.5): GET /api/agents paged to the end while the popover is
// open, from the moment it opens, on each new Hub view, AGENTS_REFRESH_MS after the last read ended, and when the page
// resumes from frozen; nothing while it is closed. A newer read, the popover closing or the header leaving aborts the
// read in flight and discards what it brings. From an opening, or from the end of the last read, a read must land
// within AGENTS_READ_MS, one bound across the reads that supersede each other; past it, the read has failed. A page
// frozen past the bound runs its timers late, so on resume a read past it fails first, and the resume read has a bound
// of its own.

import { type AgentRow, AgentPage } from "@prq/protocol";
import { useEffect, useMemo, useState } from "react";

import { type Fetch, readPages } from "./reads.ts";

// How long a read of every page may take before the popover says the pool could not be read: longer than the route's
// own bound on a page (ROUTE_CALL_MS), so the route's 503 comes first.
export const AGENTS_READ_MS = 45_000;

// How often the open popover reads the agents again. What a row shows changes with no new Hub view (whether the agent
// waits or holds a job, when the Hub last heard from it), and the row gives that time in whole minutes on the page's
// 30 s clock (RelativeTime): read as often, a row is no further behind the Hub than the clock is behind the time.
export const AGENTS_REFRESH_MS = 30_000;

// The agents as read, while the popover's first read since it opened is under way, or the latest read's failure.
export type AgentRead = { state: "loading" } | { state: "failed" } | { state: "ready"; rows: AgentRow[] };

export type AgentReads = {
  // The popover opened: the loading state, then a read.
  open(): void;
  // A read now, while the popover is open, keeping what is shown until it ends.
  refresh(): void;
  // The popover closed: the read in flight ends and nothing is read until it opens again.
  close(): void;
};

type Timer = ReturnType<typeof setTimeout>;

function agentReads(fetcher: Fetch, publish: (read: AgentRead) => void): AgentReads {
  // While the popover is open: the read in flight, the bound on landing one (its timer and when it ends), and the next
  // read.
  let open: {
    controller: AbortController | null;
    deadline: { timer: Timer; at: number } | null;
    next: Timer | undefined;
  } | null = null;

  function settle(outcome: AgentRead) {
    if (open !== null) {
      open.controller?.abort();
      open.controller = null;
      clearTimeout(open.deadline?.timer);
      open.deadline = null;
      clearTimeout(open.next);
      open.next = setTimeout(refresh, AGENTS_REFRESH_MS);
      publish(outcome);
    }
  }

  function refresh() {
    if (open === null) {
      return;
    }
    open.controller?.abort();
    clearTimeout(open.next);
    const controller = new AbortController();
    open.controller = controller;
    open.deadline ??= {
      timer: setTimeout(() => settle({ state: "failed" }), AGENTS_READ_MS),
      at: Date.now() + AGENTS_READ_MS,
    };
    const end = (outcome: AgentRead) => {
      if (open?.controller === controller) {
        settle(outcome);
      }
    };
    readPages(fetcher, "/api/agents", AgentPage, controller.signal).then(
      (rows) => end({ state: "ready", rows }),
      () => end({ state: "failed" }),
    );
  }

  function resume() {
    if (open !== null && open.deadline !== null && Date.now() >= open.deadline.at) {
      settle({ state: "failed" });
    }
    refresh();
  }

  return {
    open() {
      if (open === null) {
        open = { controller: null, deadline: null, next: undefined };
        document.addEventListener("resume", resume);
        publish({ state: "loading" });
        refresh();
      }
    },
    refresh,
    close() {
      if (open !== null) {
        open.controller?.abort();
        clearTimeout(open.deadline?.timer);
        clearTimeout(open.next);
        open = null;
        document.removeEventListener("resume", resume);
      }
    },
  };
}

// The popover's agents and the reads that bring them; the header leaving closes them.
export function useAgents(fetcher: Fetch): [AgentRead, AgentReads] {
  const [agents, setAgents] = useState<AgentRead>({ state: "loading" });
  const reads = useMemo(() => agentReads(fetcher, setAgents), [fetcher]);
  useEffect(() => () => reads.close(), [reads]);
  return [agents, reads];
}
