// The present local agents for the pool's popover (plan §1.5): GET /api/agents paged to the end when the popover opens,
// and again when the Hub's view changes while it is open. A newer read, the popover closing or the header leaving
// aborts the read in flight and discards what it brings; a read that has not ended within AGENTS_READ_MS has failed.

import { type AgentRow, AgentPage } from "@prq/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import { type Fetch, readJson } from "./reads.ts";

// How long a read of every page may take before the popover says the pool could not be read: longer than the route's
// own bound on a page (ROUTE_CALL_MS), so the route's 503 comes first.
export const AGENTS_READ_MS = 45_000;

// The agents as read, while the popover's first read since it opened is under way, or the latest read's failure.
export type AgentRead = { state: "loading" } | { state: "failed" } | { state: "ready"; rows: AgentRow[] };

async function readAgents(fetcher: Fetch, signal: AbortSignal): Promise<AgentRow[]> {
  const rows: AgentRow[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? "" : `?${new URLSearchParams({ cursor }).toString()}`;
    const page = await readJson(fetcher, `/api/agents${query}`, AgentPage, signal);
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return rows;
}

// The popover's agents: read(fresh) starts a read, from the loading state when `fresh` (an opening), keeping what is
// shown until it ends otherwise; stop() ends the read in flight.
export function useAgents(fetcher: Fetch): [AgentRead, (fresh: boolean) => void, () => void] {
  const [agents, setAgents] = useState<AgentRead>({ state: "loading" });
  const current = useRef<{ controller: AbortController; timer: ReturnType<typeof setTimeout> } | null>(null);
  const stop = useCallback(() => {
    current.current?.controller.abort();
    clearTimeout(current.current?.timer);
    current.current = null;
  }, []);
  const read = useCallback(
    (fresh: boolean) => {
      stop();
      const controller = new AbortController();
      // Applies the read's outcome while it is the current one.
      const end = (outcome: AgentRead) => {
        if (current.current?.controller === controller) {
          clearTimeout(current.current.timer);
          current.current = null;
          setAgents(outcome);
        }
      };
      const timer = setTimeout(() => {
        controller.abort();
        end({ state: "failed" });
      }, AGENTS_READ_MS);
      current.current = { controller, timer };
      if (fresh) {
        setAgents({ state: "loading" });
      }
      readAgents(fetcher, controller.signal).then(
        (rows) => end({ state: "ready", rows }),
        () => end({ state: "failed" }),
      );
    },
    [fetcher, stop],
  );
  useEffect(() => stop, [stop]);
  return [agents, read, stop];
}
