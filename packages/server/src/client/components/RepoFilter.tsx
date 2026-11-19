import "./RepoFilter.css";
import { type KeyboardEvent, type MouseEvent, useEffect, useId, useRef, useState } from "react";

import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { Notice } from "./Notice.tsx";

// What the menu lists: the repositories as read (each value its owner/name, each label as the list names it), while
// they are read, or the read's failure.
export type RepoItems =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; repos: { value: string; label: string }[] };

export const ALL_REPOSITORIES = "All repositories";

const itemsOf = (menu: HTMLElement | null) => [
  ...(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
];

// The repository filter (design/components.md, PR list): a button that opens a menu of the followed repositories,
// "All repositories" first, the chosen one checked. The menu is a popover the button toggles; a keyboard open moves
// focus to the first item and a pointer open leaves it on the button; while a read a keyboard started (an open or Try
// again) changes what the menu holds, focus goes to the first item once the options render, or to Try again once the
// read failed. The arrow keys move between items (focusgroup), Home and End go to the ends; Escape and a choice close
// it and return focus to the button.
export function RepoFilter({
  label,
  selected,
  items,
  onOpen,
  onSelect,
  onRetry,
}: {
  label: string;
  selected: string | null;
  items: RepoItems;
  onOpen?: (() => void) | undefined;
  onSelect?: ((repo: string | null) => void) | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const menuId = useId();
  const triggerId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Set by a keyboard open, read when the menu has opened: only a keyboard open enters the menu.
  const enter = useRef(false);
  const fromPointer = useRef(false);
  // Set while a read a keyboard started has yet to end.
  const keyboardRead = useRef(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!keyboardRead.current) {
      return;
    }
    if (items.state === "failed") {
      menu.current?.querySelector<HTMLElement>('[data-component="Button"]')?.focus();
    } else {
      itemsOf(menu.current)[0]?.focus();
    }
    keyboardRead.current = items.state === "loading";
  }, [items.state]);

  const close = (pointer: boolean) => {
    trigger.current?.focus({ focusVisible: !pointer });
    menu.current?.hidePopover();
  };

  const onTriggerKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown") {
      return;
    }
    event.preventDefault();
    if (expanded) {
      itemsOf(menu.current)[0]?.focus();
    } else {
      enter.current = true;
      trigger.current?.click();
    }
  };
  const onTriggerClick = (event: MouseEvent) => {
    // A click with no pointer behind it came from Enter or Space.
    if (event.detail === 0) {
      enter.current = true;
    }
  };
  const onToggle = (event: { newState: string }) => {
    const open = event.newState === "open";
    setExpanded(open);
    keyboardRead.current = open && enter.current;
    if (open) {
      onOpen?.();
      if (enter.current) {
        itemsOf(menu.current)[0]?.focus();
      } else if (fromPointer.current) {
        trigger.current?.focus({ focusVisible: false });
      }
    }
    enter.current = false;
    fromPointer.current = false;
  };
  const onMenuKey = (event: KeyboardEvent) => {
    const all = itemsOf(menu.current);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(false);
    } else if ((event.key === "Home" || event.key === "End") && all.length > 0) {
      event.preventDefault();
      all.at(event.key === "Home" ? 0 : -1)?.focus();
    }
  };
  const choose = (event: MouseEvent, repo: string | null) => {
    onSelect?.(repo);
    close(event.detail > 0);
  };

  const options = [{ value: null, label: ALL_REPOSITORIES }, ...(items.state === "ready" ? items.repos : [])];
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
        onPointerDown={(event) => {
          event.preventDefault();
          fromPointer.current = true;
        }}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKey}
      >
        <Icon name="repo" />
        <span className="label">{label}</span>
        <Icon name="chevron-down" />
      </button>
      <div
        ref={menu}
        id={menuId}
        className="menu"
        popover="auto"
        onToggle={onToggle}
        onKeyDown={onMenuKey}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && !menu.current?.contains(next) && next !== trigger.current) {
            menu.current?.hidePopover();
          }
        }}
      >
        {items.state === "failed" ? (
          <Notice
            tone="danger"
            title="Couldn't load repositories"
            actions={
              <Button
                variant="secondary"
                size="sm"
                label="Try again"
                onClick={(event) => {
                  keyboardRead.current = event.detail === 0;
                  onRetry?.();
                }}
              />
            }
          />
        ) : (
          <div focusgroup="menu nomemory" aria-labelledby={triggerId}>
            <div role="group" aria-label="Repositories">
              {options.map((option) => (
                <button
                  key={option.value ?? ""}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.value === selected}
                  className="item"
                  onClick={(event) => choose(event, option.value)}
                >
                  <span className="check">{option.value === selected && <Icon name="check" />}</span>
                  <span className="item-label">{option.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
