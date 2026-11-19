// The agent pool in the header (plan §1.5, docs/ui.md 3): PoolStatus from the Hub's view as the button of PoolPopover,
// which reads the present agents when it opens and again when the view changes while it is open. Nothing is read while
// it is closed.

import type { HubView } from "@prq/protocol";
import { useEffect, useId, useRef, useState } from "react";

import { type AgentRead, useAgents } from "./agents.ts";
import { PoolPopover, type PoolPopoverState } from "./components/PoolPopover.tsx";
import { type PoolState, PoolStatus } from "./components/PoolStatus.tsx";
import { useFetch } from "./reads.ts";

// The pool's status: loading until the Hub's first view, unavailable once its socket has gone RECONNECT_FAILED_MS
// without an open, else whether a local agent is present.
export function poolState(view: HubView | null, unavailable: boolean): PoolState {
  if (unavailable) {
    return "unavailable";
  }
  if (view === null) {
    return "loading";
  }
  return view.localAgentPresent ? "local" : "cloud-only";
}

// What the popover says: unavailable with the status or after a failed read; else the agents read, or, while they are
// read, the view's presence.
function popoverState(status: PoolState, agents: AgentRead, view: HubView | null): PoolPopoverState {
  if (status === "unavailable" || agents.state === "failed") {
    return "unavailable";
  }
  if (agents.state === "ready") {
    return agents.rows.length > 0 ? "local" : "cloud-only";
  }
  return view?.localAgentPresent === false ? "cloud-only" : "local";
}

// PoolStatus and its popover. `open` opens the popover once it renders (the gallery's pool.* states).
export function AgentPool({
  view,
  status,
  agents,
  open = false,
  onToggle,
}: {
  view: HubView | null;
  status: PoolState;
  agents: AgentRead;
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
  return (
    <>
      <PoolStatus
        ref={trigger}
        form="button"
        state={status}
        agents={view?.presentAgents}
        jobs={view?.jobs}
        expanded={expanded}
        commandfor={popoverId}
        command="toggle-popover"
      />
      <PoolPopover
        ref={popover}
        id={popoverId}
        popover="auto"
        state={popoverState(status, agents, view)}
        agents={agents.state === "ready" ? agents.rows : null}
        jobs={view?.jobs ?? null}
        onToggle={(event) => {
          const opened = event.newState === "open";
          setExpanded(opened);
          onToggle?.(opened);
        }}
      />
    </>
  );
}

// The header's pool: each opening reads the agents afresh, a new view while open reads them again, keeping the rows
// until that read ends, and closing ends the read in flight.
export function Pool({ view, unavailable }: { view: HubView | null; unavailable: boolean }) {
  const [agents, read, stop] = useAgents(useFetch());
  const open = useRef(false);
  const shown = useRef(view);
  useEffect(() => {
    if (open.current && shown.current !== view) {
      read(false);
    }
    shown.current = view;
  }, [view, read]);
  return (
    <AgentPool
      view={view}
      status={poolState(view, unavailable)}
      agents={agents}
      onToggle={(opened) => {
        open.current = opened;
        if (opened) {
          read(true);
        } else {
          stop();
        }
      }}
    />
  );
}
