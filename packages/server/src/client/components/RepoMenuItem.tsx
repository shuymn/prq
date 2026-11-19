import "./RepoMenuItem.css";
import type { MouseEvent } from "react";

import { Icon } from "./Icon.tsx";

// An item of the repository menu (design/components.md, PR list): the check's slot, there on every item so the labels
// line up, and the label on one line. The selected item is checked and filled.
export function RepoMenuItem({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick?: ((event: MouseEvent) => void) | undefined;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      data-component="RepoMenuItem"
      data-selected={selected}
      onClick={onClick}
    >
      <span className="check">{selected && <Icon name="check" />}</span>
      <span className="label">{label}</span>
    </button>
  );
}
