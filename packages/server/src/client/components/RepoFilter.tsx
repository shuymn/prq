import "./RepoFilter.css";
import { type KeyboardEvent, type MouseEvent, useEffect, useId, useRef, useState } from "react";

import { Icon } from "./Icon.tsx";
import { menuItems, useMenuFocus } from "./menu.ts";
import { type RepoItems, RepoMenu } from "./RepoMenu.tsx";

// The repository filter (design/components.md, PR list): a button that opens RepoMenu, the menu of the followed
// repositories, as a popover the button toggles. A keyboard open moves focus to the first item and a pointer open
// leaves it on the button; while a read a keyboard started (an open or Try again) changes what the menu holds, focus
// goes to the first item once the options render, or to Try again once the read failed. The arrow keys move between
// items (focusgroup), Home and End go to the ends; Escape and a choice close it and return focus to the button.
export function RepoFilter({
  label,
  selected,
  items,
  open = false,
  onRead,
  onSelect,
}: {
  label: string;
  selected: string | null;
  items: RepoItems;
  // Opens the menu when the filter renders, with focus left where it is: the gallery's open menu (list.repo-menu).
  open?: boolean | undefined;
  // Reads the repositories: on each opening of the menu, and on its Try again.
  onRead?: (() => void) | undefined;
  onSelect?: ((repo: string | null) => void) | undefined;
}) {
  const menuId = useId();
  const triggerId = useId();
  const { trigger, menu, close, onTriggerPointerDown, onTriggerClick, focusOnToggle, onMenuKey, onMenuBlur } =
    useMenuFocus();
  // Set while a read a keyboard started has yet to end.
  const keyboardRead = useRef(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (open && trigger.current !== null) {
      menu.current?.showPopover({ source: trigger.current });
    }
  }, [open, menu, trigger]);

  useEffect(() => {
    if (!keyboardRead.current) {
      return;
    }
    if (items.state === "failed") {
      menu.current?.querySelector<HTMLElement>('[data-component="Button"]')?.focus();
    } else {
      menuItems(menu.current)[0]?.focus();
    }
    keyboardRead.current = items.state === "loading";
  }, [items.state, menu]);

  // ArrowDown on the button opens the menu as Enter does, or enters it while open.
  const onTriggerKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown") {
      return;
    }
    event.preventDefault();
    if (expanded) {
      menuItems(menu.current)[0]?.focus();
    } else {
      trigger.current?.click();
    }
  };
  // Each opening reads the repositories; a keyboard's open follows its read with focus.
  const onToggle = (event: { newState: string }) => {
    const opened = event.newState === "open";
    setExpanded(opened);
    if (opened) {
      onRead?.();
    }
    keyboardRead.current = focusOnToggle(opened);
  };
  const choose = (event: MouseEvent, repo: string | null) => {
    onSelect?.(repo);
    close(event.detail > 0);
  };

  return (
    <div data-component="RepoFilter">
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        className="trigger"
        aria-haspopup="menu"
        aria-expanded={expanded}
        commandfor={menuId}
        command="toggle-popover"
        onPointerDown={onTriggerPointerDown}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKey}
      >
        <Icon name="repo" />
        <span className="label">{label}</span>
        <Icon name="chevron-down" />
      </button>
      <RepoMenu
        ref={menu}
        id={menuId}
        popover="auto"
        items={items}
        selected={selected}
        labelledBy={triggerId}
        onChoose={choose}
        onRetry={(event) => {
          keyboardRead.current = event.detail === 0;
          onRead?.();
        }}
        onToggle={onToggle}
        onKeyDown={onMenuKey}
        onBlur={onMenuBlur}
      />
    </div>
  );
}
