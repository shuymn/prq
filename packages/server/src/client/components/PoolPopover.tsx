import "./PoolPopover.css";
import type { AgentRow, JobCounts } from "@prq/protocol";
import type { ComponentProps } from "react";

import { Badge, type BadgeTone } from "./Badge.tsx";
import { Icon } from "./Icon.tsx";
import { Notice } from "./Notice.tsx";
import { RelativeTime } from "./RelativeTime.tsx";
import { Skeleton } from "./Skeleton.tsx";

export type PoolPopoverState = "local" | "cloud-only" | "unavailable";

// What an agent does now: holding a claim, in a wait for work, both, or neither.
function activity({ holdsJob, waiting }: AgentRow): string {
  const parts = [holdsJob && "Holding a job", waiting && (holdsJob ? "waiting for work" : "Waiting for work")];
  const text = parts.filter(Boolean).join(" · ");
  return text === "" ? "Not waiting" : text;
}

const JOBS: [keyof JobCounts, BadgeTone][] = [
  ["waiting", "neutral"],
  ["running", "accent"],
  ["failed", "danger"],
];

function Agent({ row }: { row: AgentRow }) {
  return (
    <li className="agent">
      <span className="lead">
        <Icon name="device-desktop" />
      </span>
      <span className="agent-text">
        <span className="agent-id">{row.agentId}</span>
        <span className="agent-detail">
          {activity(row)}
          {row.lastSeenAt !== null && (
            <>
              {" · seen "}
              <RelativeTime at={row.lastSeenAt} />
            </>
          )}
        </span>
      </span>
    </li>
  );
}

// The agent pool's details (design/components.md, Layout and navigation), the popover PoolStatus opens in the header:
// the local agents present (each ID, what it does and when the Hub last heard from it; Skeleton rows while `agents` is
// null, the read under way), or that none is and what that means; the cloud, always available; and the jobs in flight.
// Unavailable, a notice says the pool could not be read. The header makes it its popover and gives it the popover's
// attributes.
export function PoolPopover({
  state,
  agents,
  jobs,
  ref,
  id,
  popover,
  onToggle,
}: {
  state: PoolPopoverState;
  agents?: readonly AgentRow[] | null | undefined;
  jobs?: JobCounts | null | undefined;
} & Pick<ComponentProps<"div">, "ref" | "id" | "popover" | "onToggle">) {
  const counts = jobs === null || jobs === undefined ? [] : JOBS.filter(([kind]) => jobs[kind] > 0);
  return (
    <div ref={ref} id={id} popover={popover} data-component="PoolPopover" data-state={state} onToggle={onToggle}>
      {state === "unavailable" ? (
        <Notice
          tone="attention"
          title="Pool status unavailable"
          text="The agent pool could not be read. Jobs keep their state."
        />
      ) : (
        <section className="local">
          <h2>Local agents</h2>
          {state === "cloud-only" ? (
            <p className="none">
              No local agent present. New PRs go to cloud; existing local sessions wait until their agent returns.
            </p>
          ) : agents === null || agents === undefined ? (
            <div className="skeleton" aria-busy="true">
              <Skeleton shape="line" />
              <Skeleton shape="line" />
            </div>
          ) : (
            <ul>
              {agents.map((row) => (
                <Agent key={row.agentId} row={row} />
              ))}
            </ul>
          )}
        </section>
      )}
      <section className="cloud">
        <h2>Cloud</h2>
        <p className="cloud-row">
          <Icon name="cloud" />
          <span className="cloud-label">Cloud</span>
          <span className="cloud-status">Available</span>
        </p>
      </section>
      {state !== "unavailable" && jobs !== null && jobs !== undefined && (
        <section className="jobs">
          <h2>Jobs in flight</h2>
          {counts.length === 0 ? (
            <p className="none-jobs">No jobs</p>
          ) : (
            <p className="badges">
              {counts.map(([kind, tone]) => (
                <Badge key={kind} tone={tone} label={`${jobs[kind]} ${kind}`} />
              ))}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
