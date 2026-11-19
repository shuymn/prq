import "./VersionMenu.css";
import { type KeyboardEvent, type MouseEvent, useEffect, useId, useState } from "react";

import { Icon } from "./Icon.tsx";
import { menuItems, useMenuFocus } from "./menu.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { Sha } from "./Sha.tsx";
import { VersionItem, type VersionStatus } from "./VersionItem.tsx";

export type Version = { jobId: string; status: VersionStatus; sha: string; at: number };

// The summary's version picker (design/components.md, PR detail): a button with the shown version's SHA and time that
// opens a menu of the versions, newest first, the shown one checked. The menu is a popover the button toggles; a
// keyboard open moves focus to the first item and a pointer open leaves it on the button. The arrow keys move between
// items (focusgroup), Home and End go to the ends; Escape and a choice close it and return focus to the button.
// `open` opens it once it renders (the gallery's open state).
export function VersionMenu({
  versions,
  shown,
  open: initiallyOpen = false,
  onSelect,
}: {
  versions: Version[];
  shown: Version;
  open?: boolean | undefined;
  onSelect?: ((jobId: string) => void) | undefined;
}) {
  const menuId = useId();
  const triggerId = useId();
  const {
    trigger,
    menu,
    close,
    openByKeyboard,
    onTriggerPointerDown,
    onTriggerClick,
    focusOnToggle,
    onMenuKey,
    onMenuBlur,
  } = useMenuFocus();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (initiallyOpen) {
      menu.current?.showPopover();
    }
  }, [initiallyOpen, menu]);

  // ArrowDown on the button opens the menu as Enter does, or enters it while open.
  const onTriggerKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown") {
      return;
    }
    event.preventDefault();
    if (open) {
      menuItems(menu.current)[0]?.focus();
    } else {
      openByKeyboard();
    }
  };
  const onToggle = (event: { newState: string }) => {
    const opened = event.newState === "open";
    setOpen(opened);
    focusOnToggle(opened);
  };
  const choose = (event: MouseEvent, jobId: string) => {
    onSelect?.(jobId);
    close(event.detail > 0);
  };

  return (
    <div data-component="VersionMenu" data-open={open}>
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        className="trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        commandfor={menuId}
        command="toggle-popover"
        onPointerDown={onTriggerPointerDown}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKey}
      >
        <Sha sha={shown.sha} />
        <RelativeTime at={shown.at} />
        <Icon name="chevron-down" />
      </button>
      <div
        ref={menu}
        id={menuId}
        className="menu"
        popover="auto"
        onToggle={onToggle}
        onKeyDown={onMenuKey}
        onBlur={onMenuBlur}
      >
        <div focusgroup="menu nomemory" aria-labelledby={triggerId}>
          <div role="group" aria-label="Versions">
            {versions.map((version) => (
              <VersionItem
                key={version.jobId}
                menu
                status={version.status}
                selected={version.jobId === shown.jobId}
                sha={version.sha}
                at={version.at}
                onSelect={(event) => choose(event, version.jobId)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
