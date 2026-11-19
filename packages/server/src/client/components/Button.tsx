import "./Button.css";
import { Spinner } from "./Spinner.tsx";

export type ButtonVariant = "primary" | "secondary" | "danger" | "invisible";
export type ControlSize = "md" | "sm";
// Hover and focus are CSS states in the page; the gallery shows them as states of their own (design/components.md,
// Controls), which `preview` sets.
export type PreviewState = "hover" | "focus";

type Props = {
  variant: ButtonVariant;
  size: ControlSize;
  label: string;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  // A toggle button's state (aria-pressed), as the "Needs attention" filter has.
  pressed?: boolean | undefined;
  onClick?: (() => void) | undefined;
  preview?: PreviewState | undefined;
};

// A text button (design/components.md, Controls). Busy shows a Spinner before the label and takes no clicks.
export function Button({ variant, size, label, disabled = false, busy = false, pressed, onClick, preview }: Props) {
  const state = busy ? "busy" : disabled ? "disabled" : (preview ?? "rest");
  return (
    <button
      type="button"
      data-component="Button"
      data-variant={variant}
      data-size={size}
      data-state={state}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-pressed={pressed}
      onClick={busy ? undefined : onClick}
    >
      {busy && <Spinner />}
      <span className="label">{label}</span>
    </button>
  );
}

// A link that looks like a button, for an action that goes to another page ("Go to pull requests").
export function ButtonLink({
  variant,
  size,
  label,
  href,
}: Pick<Props, "variant" | "size" | "label"> & { href: string }) {
  return (
    <a data-component="Button" data-variant={variant} data-size={size} data-state="rest" href={href}>
      <span className="label">{label}</span>
    </a>
  );
}
