// What the menus a button toggles as a popover share (RepoFilter, VersionMenu; modern-web-guidance `menu`): a keyboard
// open moves focus to the first item and a pointer open leaves it on the button; Home and End go to the ends of the
// items (the arrow keys are the focusgroup's); Escape and a choice close the menu and return focus to the button; focus
// leaving the menu and its button closes it. How each opens stays its own.

import { type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, useRef } from "react";

export const menuItems = (menu: HTMLElement | null): HTMLElement[] => [
  ...(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
];

export function useMenuFocus() {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Set by a keyboard open, read when the menu has opened: only a keyboard open enters the menu.
  const enter = useRef(false);
  const fromPointer = useRef(false);

  // Closes the menu with focus back on the button, shown as focus unless a pointer chose.
  const close = (pointer: boolean) => {
    trigger.current?.focus({ focusVisible: !pointer });
    menu.current?.hidePopover();
  };

  return {
    trigger,
    menu,
    close,
    // Opens the menu as a keyboard does, which enters it.
    openByKeyboard: () => {
      enter.current = true;
      menu.current?.showPopover();
    },
    // The button's pointer keeps focus where it is; a click with no pointer behind it came from Enter or Space.
    onTriggerPointerDown: (event: PointerEvent) => {
      event.preventDefault();
      fromPointer.current = true;
    },
    onTriggerClick: (event: MouseEvent) => {
      if (event.detail === 0) {
        enter.current = true;
      }
    },
    // Once the menu toggled: focus as its open asks for. Whether a keyboard opened it.
    focusOnToggle: (opened: boolean): boolean => {
      const entered = opened && enter.current;
      if (entered) {
        menuItems(menu.current)[0]?.focus();
      } else if (opened && fromPointer.current) {
        trigger.current?.focus({ focusVisible: false });
      }
      enter.current = false;
      fromPointer.current = false;
      return entered;
    },
    onMenuKey: (event: KeyboardEvent) => {
      const all = menuItems(menu.current);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(false);
      } else if ((event.key === "Home" || event.key === "End") && all.length > 0) {
        event.preventDefault();
        all.at(event.key === "Home" ? 0 : -1)?.focus();
      }
    },
    onMenuBlur: (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && !menu.current?.contains(next) && next !== trigger.current) {
        menu.current?.hidePopover();
      }
    },
  };
}
