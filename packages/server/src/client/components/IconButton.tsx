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
  onClick,
  preview,
}: {
  variant: "invisible" | "secondary";
  size: ControlSize;
  icon: IconName;
  label: string;
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
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}
