import "./PrStateLabel.css";
import type { PrDetails } from "@prq/protocol";

import { Icon } from "./Icon.tsx";

export type PrState = PrDetails["state"];

export const PR_STATE_ICONS = {
  open: "git-pull-request",
  merged: "git-merge",
  closed: "git-pull-request-closed",
} as const;

export const PR_STATE_LABELS: Record<PrState, string> = { open: "Open", merged: "Merged", closed: "Closed" };

// A pull request's state on GitHub, its Octicon before its label (design/components.md, Status and labels).
export function PrStateLabel({ state }: { state: PrState }) {
  return (
    <span data-component="PrStateLabel" data-state={state}>
      <Icon name={PR_STATE_ICONS[state]} />
      {PR_STATE_LABELS[state]}
    </span>
  );
}
