import "./Button.css";
import "./IconButton.css";
import type { ControlSize, PreviewState } from "./Button.tsx";
import { Icon, type IconName } from "./Icon.tsx";

// A square button that shows an icon and is named by its label (design/components.md, Controls).
export function IconButton({
  variant,
  size,
  icon,
  label,
  expanded,
  description,
  onClick,
  preview,
}: {
  variant: "invisible" | "secondary";
  size: ControlSize;
  icon: IconName;
  label: string;
  // A toggle's state, for a button that shows and hides content.
  expanded?: boolean | undefined;
  // What the button's look adds to its name, for assistive technology (a mark on the icon).
  description?: string | undefined;
  onClick?: (() => void) | undefined;
  preview?: PreviewState | undefined;
}) {
  return (
    <button
      type="button"
      data-component="IconButton"
      data-variant={variant}
      data-size={size}
      data-state={preview ?? "rest"}
      aria-label={label}
      aria-expanded={expanded}
      aria-description={description}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

// An icon button that is a link: to a page of the UI, marked while it is the current page (Settings in the
// AppHeader), or to another site, opened in a new tab ("Open on GitHub" in the compact PrHeader).
export function IconButtonLink({
  icon,
  label,
  href,
  external = false,
  current = false,
}: {
  icon: IconName;
  label: string;
  href: string;
  external?: boolean | undefined;
  current?: boolean | undefined;
}) {
  return (
    <a
      data-component="IconButton"
      data-variant="invisible"
      data-size="md"
      data-state="rest"
      aria-label={label}
      aria-current={current ? "page" : undefined}
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
    >
      <Icon name={icon} />
    </a>
  );
}
