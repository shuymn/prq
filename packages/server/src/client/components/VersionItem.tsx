import "./VersionItem.css";
import type { MouseEvent } from "react";

import { Icon } from "./Icon.tsx";
import { RelativeTime } from "./RelativeTime.tsx";
import { Sha } from "./Sha.tsx";
import { Status } from "./Status.tsx";

export type VersionStatus = "done" | "running" | "waiting" | "failed" | "superseded";

// One analysis of the pull request (design/components.md, PR detail): its head's SHA, its status and its time, the
// shown one checked, never marked by color alone. In the version menu it is a radio item of the menu; in the rail a
// pressed button.
export function VersionItem({
  status,
  selected,
  sha,
  at,
  menu = false,
  onSelect,
}: {
  status: VersionStatus;
  selected: boolean;
  sha: string;
  at: number;
  menu?: boolean | undefined;
  onSelect?: ((event: MouseEvent) => void) | undefined;
}) {
  return (
    <button
      type="button"
      data-component="VersionItem"
      data-status={status}
      data-selected={selected}
      role={menu ? "menuitemradio" : undefined}
      aria-checked={menu ? selected : undefined}
      aria-pressed={menu ? undefined : selected}
      onClick={onSelect}
    >
      <span className="lead">{selected && <Icon name="check" />}</span>
      <Sha sha={sha} />
      <Status state={status} />
      <span className="time">
        <RelativeTime at={at} />
      </span>
    </button>
  );
}
