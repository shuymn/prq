import "./TextField.css";
import { useId } from "react";

import { Icon } from "./Icon.tsx";

type FieldState = "rest" | "focus" | "invalid" | "disabled";

// Why a field is invalid, under its input: the x-circle in a lead one line high, then the reason.
export function FieldError({ id, text }: { id: string; text: string }) {
  return (
    <p className="error" id={id}>
      <span className="lead">
        <Icon name="x-circle" />
      </span>
      {text}
    </p>
  );
}

// The ids that describe a field: its hint, then the reason it is invalid while it is.
export function describedBy(hintId: string | null, errorId: string | null): string | undefined {
  const ids = [hintId, errorId].filter((id) => id !== null);
  return ids.length === 0 ? undefined : ids.join(" ");
}

// A one-line field (design/components.md, Settings): its label, a hint above the input, and the reason it is invalid
// below it. The reason is the server's (a ref it could not find, a link it refused), so the page sets it, and with it
// aria-invalid and the description (plan §1.20). It never corrects or capitalizes what is typed: it holds links and
// refs. `autofocus` focuses the input as it appears, also where a dialog opens around it (data-autofocus).
export function TextField({
  label,
  hint,
  value,
  placeholder,
  error = null,
  disabled = false,
  readOnly = false,
  autofocus = false,
  onChange,
  preview,
}: {
  label: string;
  hint?: string | undefined;
  value: string;
  placeholder?: string | undefined;
  error?: string | null | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  autofocus?: boolean | undefined;
  onChange?: ((value: string) => void) | undefined;
  preview?: "focus" | undefined;
}) {
  const id = useId();
  const hintId = useId();
  const errorId = useId();
  const state: FieldState = disabled ? "disabled" : error !== null ? "invalid" : (preview ?? "rest");
  return (
    <div data-component="TextField" data-state={state}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {hint !== undefined && (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      )}
      <input
        id={id}
        className="input"
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={error !== null}
        aria-describedby={describedBy(hint === undefined ? null : hintId, error === null ? null : errorId)}
        autoFocus={autofocus}
        data-autofocus={autofocus || undefined}
        onChange={(event) => onChange?.(event.currentTarget.value)}
      />
      {error !== null && <FieldError id={errorId} text={error} />}
    </div>
  );
}
