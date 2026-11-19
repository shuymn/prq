// The agent pool in the header (plan §1.5, docs/ui.md 3): PoolStatus from the Hub's view as the button of PoolPopover,
// which reads the present agents while it is open (agents.ts). A route change closes it.

import type { HubView } from "@prq/protocol";
import { useEffect, useId, useRef, useState } from "react";

import { type AgentRead, useAgents } from "./agents.ts";
import { PoolPopover, type PoolPopoverState } from "./components/PoolPopover.tsx";
import { type PoolState, PoolStatus, type PoolSummary } from "./components/PoolStatus.tsx";
import { useFetch } from "./reads.ts";

// PoolStatus's props: loading until the Hub's first view, unavailable once its socket has gone RECONNECT_FAILED_MS
// without an open, else whether a local agent is present, with the view's count of agents and its jobs.
export function poolStatus(view: HubView | null, unavailable: boolean): PoolSummary {
  if (unavailable) {
    return { state: "unavailable" };
  }
  if (view === null) {
    return { state: "loading" };
  }
  return {
    state: view.localAgentPresent ? "local" : "cloud-only",
    agents: view.presentAgents,
    jobs: view.jobs,
  };
}

// What the popover says: unavailable with the status or after a failed read; else the agents its read found, none
// being cloud only, and the skeleton rows of the local section until a read lands.
function popoverState(status: PoolState, agents: AgentRead): PoolPopoverState {
  if (status === "unavailable" || agents.state === "failed") {
    return "unavailable";
  }
  return agents.state === "ready" && agents.rows.length === 0 ? "cloud-only" : "local";
}

// PoolStatus and its popover. `open` opens the popover once it renders (the gallery's pool.* states); `route` changing
// closes it.
export function AgentPool({
  view,
  unavailable,
  agents,
  route,
  open = false,
  onToggle,
}: {
  view: HubView | null;
  unavailable: boolean;
  agents: AgentRead;
  route?: string | undefined;
  open?: boolean | undefined;
  onToggle?: ((open: boolean) => void) | undefined;
}) {
  const popoverId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (open && trigger.current !== null) {
      popover.current?.showPopover({ source: trigger.current });
    }
  }, [open]);
  const routed = useRef(route);
  useEffect(() => {
    if (routed.current !== route) {
      routed.current = route;
      if (popover.current?.matches(":popover-open") === true) {
        popover.current.hidePopover();
      }
    }
  }, [route]);
  const status = poolStatus(view, unavailable);
  return (
    <>
      <PoolStatus ref={trigger} form="button" {...status} expanded={expanded} commandfor={popoverId} />
      <PoolPopover
        ref={popover}
        id={popoverId}
        popover="auto"
        state={popoverState(status.state, agents)}
        agents={agents.state === "ready" ? agents.rows : null}
        jobs={view?.jobs ?? null}
        // At the native close, before its toggle event's task, so that nothing of the read lands after it.
        onBeforeToggle={(event) => {
          const opened = event.newState === "open";
          setExpanded(opened);
          onToggle?.(opened);
        }}
      />
    </>
  );
}

// The header's pool: its popover's reads, and each new view read again while it is open.
export function Pool({
  view,
  unavailable,
  route,
}: {
  view: HubView | null;
  unavailable: boolean;
  route: string | undefined;
}) {
  const [agents, reads] = useAgents(useFetch());
  // The view the agents were last read at: an opening reads at the view shown, which its effect may not have seen yet.
  const shown = useRef(view);
  useEffect(() => {
    if (shown.current !== view) {
      shown.current = view;
      reads.refresh();
    }
  }, [view, reads]);
  return (
    <AgentPool
      view={view}
      unavailable={unavailable}
      agents={agents}
      route={route}
      onToggle={(opened) => {
        if (opened) {
          shown.current = view;
          reads.open();
        } else {
          reads.close();
        }
      }}
    />
  );
}
