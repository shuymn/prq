import "./Status.css";
import { Icon, type IconName } from "./Icon.tsx";
import { Spinner } from "./Spinner.tsx";

export type StatusState = "done" | "running" | "waiting" | "stalled" | "failed" | "superseded";

const DEFAULTS: Record<StatusState, { icon: IconName | null; label: string }> = {
  done: { icon: "check-circle", label: "Done" },
  running: { icon: null, label: "Running" },
  waiting: { icon: "clock", label: "Waiting" },
  stalled: { icon: "alert", label: "Possibly stalled" },
  failed: { icon: "x-circle", label: "Failed" },
  superseded: { icon: "circle-slash", label: "Superseded" },
};

// A job's or a pull request's state (design/components.md, Status and labels): never color alone, always its icon
// (running: the Spinner) and a label, which a screen may replace ("Answer failed"), as it may the icon ("New push not
// summarized" waits with history).
export function Status({ state, label, icon }: { state: StatusState; label?: string; icon?: IconName }) {
  const shown = DEFAULTS[state];
  const glyph = icon ?? shown.icon;
  return (
    <span data-component="Status" data-state={state}>
      <span className="lead">{glyph === null ? <Spinner /> : <Icon name={glyph} />}</span>
      <span className="label">{label ?? shown.label}</span>
    </span>
  );
}
