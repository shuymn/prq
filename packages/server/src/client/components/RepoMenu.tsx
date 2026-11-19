import "./RepoMenu.css";
import type { ComponentProps, MouseEvent } from "react";

import { Button } from "./Button.tsx";
import { Notice } from "./Notice.tsx";
import { RepoMenuItem } from "./RepoMenuItem.tsx";

// What the menu lists: the repositories as read (each value its owner/name, each label as the list names it), while
// they are read, or the read's failure.
export type RepoItems =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; repos: { value: string; label: string }[] };

export const ALL_REPOSITORIES = "All repositories";

// The menu RepoFilter opens (design/components.md, PR list): "All repositories" first, then the repositories as read,
// the selected one checked; while they are read, "All repositories" alone; once the read failed, a notice with Try
// again in the items' place. RepoFilter makes it its popover and gives it the popover's attributes and handlers.
export function RepoMenu({
  items,
  selected,
  labelledBy,
  onChoose,
  onRetry,
  ref,
  id,
  popover,
  onToggle,
  onKeyDown,
  onBlur,
}: {
  items: RepoItems;
  selected: string | null;
  // The trigger's id, which names the menu.
  labelledBy?: string | undefined;
  onChoose?: ((event: MouseEvent, repo: string | null) => void) | undefined;
  onRetry?: ((event: MouseEvent) => void) | undefined;
} & Pick<ComponentProps<"div">, "ref" | "id" | "popover" | "onToggle" | "onKeyDown" | "onBlur">) {
  const options = [{ value: null, label: ALL_REPOSITORIES }, ...(items.state === "ready" ? items.repos : [])];
  return (
    <div
      ref={ref}
      id={id}
      popover={popover}
      data-component="RepoMenu"
      data-state={items.state}
      onToggle={onToggle}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      {items.state === "failed" ? (
        <Notice
          tone="danger"
          title="Couldn't load repositories"
          actions={<Button variant="secondary" size="sm" label="Try again" onClick={onRetry} />}
        />
      ) : (
        <div focusgroup="menu nomemory" aria-labelledby={labelledBy}>
          <div role="group" aria-label="Repositories">
            {options.map((option) => (
              <RepoMenuItem
                key={option.value ?? ""}
                label={option.label}
                selected={option.value === selected}
                onClick={(event) => onChoose?.(event, option.value)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
