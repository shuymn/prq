import "./TextField.css";
import "./TextArea.css";
import { useId } from "react";

import { describedBy, FieldError } from "./TextField.tsx";

// A multi-line field (design/components.md, Settings), as TextField: room for three lines at rest, growing with its
// text to ten, then scrolling (form-fields-automatically-fit-contents). Without a label of its own it is named by the
// element `labelledBy` names and described by the one `describedById` names (a PromptEditor's title and purpose).
export function TextArea({
  label,
  labelledBy,
  hint,
  describedById,
  value,
  placeholder,
  maxLength,
  error = null,
  onChange,
  preview,
}: {
  label?: string | undefined;
  labelledBy?: string | undefined;
  hint?: string | undefined;
  describedById?: string | undefined;
  value: string;
  placeholder?: string | undefined;
  maxLength?: number | undefined;
  error?: string | null | undefined;
  onChange?: ((value: string) => void) | undefined;
  preview?: "focus" | undefined;
}) {
  const id = useId();
  const hintId = useId();
  const errorId = useId();
  const state = error !== null ? "invalid" : (preview ?? "rest");
  return (
    <div data-component="TextArea" data-state={state}>
      {label !== undefined && (
        <label className="label" htmlFor={id}>
          {label}
        </label>
      )}
      {hint !== undefined && (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      )}
      <textarea
        id={id}
        className="input"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-labelledby={labelledBy}
        aria-invalid={error !== null}
        aria-describedby={describedBy(
          hint === undefined ? (describedById ?? null) : hintId,
          error === null ? null : errorId,
        )}
        onChange={(event) => onChange?.(event.currentTarget.value)}
      />
      {error !== null && <FieldError id={errorId} text={error} />}
    </div>
  );
}
