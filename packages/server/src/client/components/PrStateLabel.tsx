import "./PrStateLabel.css";
import { Icon } from "./Icon.tsx";

export type PrState = "open" | "merged" | "closed";

export const PR_STATE_ICONS = {
  open: "git-pull-request",
  merged: "git-merge",
  closed: "git-pull-request-closed",
} as const;

const LABELS: Record<PrState, string> = { open: "Open", merged: "Merged", closed: "Closed" };

// A pull request's state on GitHub, its Octicon before its label (design/components.md, Status and labels).
export function PrStateLabel({ state }: { state: PrState }) {
  return (
    <span data-component="PrStateLabel" data-state={state}>
      <Icon name={PR_STATE_ICONS[state]} />
      {LABELS[state]}
    </span>
  );
}
