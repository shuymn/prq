import "./PoolStatus.css";
import type { JobCounts } from "@prq/protocol";

import { Icon } from "./Icon.tsx";
import { Spinner } from "./Spinner.tsx";

export type PoolState = "local" | "cloud-only" | "unavailable" | "loading";

// Who can take work now, from the Hub's view (design/components.md, Layout and navigation): the local agents present,
// or the cloud alone, with the jobs in flight. `button` is the header's form, `line` the panel's.
export function PoolStatus({
  form,
  state,
  agents = 0,
  jobs,
}: {
  form: "button" | "line";
  state: PoolState;
  agents?: number | undefined;
  jobs?: JobCounts | undefined;
}) {
  const label = {
    local: `${agents} local ${agents === 1 ? "agent" : "agents"}`,
    "cloud-only": "Cloud only",
    unavailable: "Pool unavailable",
    loading: "Loading pool",
  }[state];
  const counts = jobs === undefined || state === "unavailable" || state === "loading" ? null : jobsText(jobs);
  return (
    <div data-component="PoolStatus" data-form={form} data-state={state}>
      {state === "loading" ? <Spinner /> : <Icon name="dot-fill" />}
      <span className="label">{label}</span>
      {counts !== null && <span className="jobs">{form === "line" ? `· ${counts}` : counts}</span>}
    </div>
  );
}

// "1 running · 2 waiting", or "No jobs".
function jobsText({ running, waiting }: JobCounts): string {
  const parts = [running > 0 && `${running} running`, waiting > 0 && `${waiting} waiting`].filter(Boolean);
  return parts.length === 0 ? "No jobs" : parts.join(" · ");
}
