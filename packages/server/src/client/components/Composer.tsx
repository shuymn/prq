import "./Composer.css";
import { type FormEvent, type KeyboardEvent, type Ref, useId } from "react";

import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { Sha } from "./Sha.tsx";

// Why nothing can be sent: the connection is down (reconnecting, or reconnecting has kept failing).
export type ComposerDown = "reconnecting" | "disconnected";
// A sent question the stored history has yet to hold (pending), or whose send failed.
export type ComposerHeld = "pending" | "failed";

export const DOWN_REASONS: Record<ComposerDown, string> = {
  reconnecting: "Reconnecting. You can send once the connection is back.",
  disconnected: "Disconnected. You can send once the connection is back.",
};

const HELD: Record<ComposerHeld, string> = {
  pending: "You can send once the question above is saved.",
  failed: "You can send once the question above is sent or discarded.",
};

// Enter sends, Shift+Enter starts a new line; the Enter that confirms an input method's composition does neither.
function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!event.nativeEvent.isComposing) {
      event.currentTarget.form?.requestSubmit();
    }
  }
}

// The question field (design/components.md, PR detail): Enter sends and Shift+Enter starts a new line, not while an
// input method composes; the field grows with its text. While the connection is down the field is marked disabled
// with the reason (it stays focusable); while the page loads or a sent question is unconfirmed Send is off and the
// draft stays editable. Above the field, while an earlier version is shown, the SHA questions are answered at.
export function Composer({
  value,
  onChange,
  onSend,
  loading = false,
  down = null,
  held = null,
  answeredAt = null,
  fieldRef,
  preview,
}: {
  value: string;
  onChange?: ((value: string) => void) | undefined;
  onSend?: ((text: string) => void) | undefined;
  // Until the page's first view and history read: a question sent then would have no row to show it.
  loading?: boolean | undefined;
  down?: ComposerDown | null | undefined;
  held?: ComposerHeld | null | undefined;
  answeredAt?: string | null | undefined;
  fieldRef?: Ref<HTMLTextAreaElement> | undefined;
  preview?: "focus" | undefined;
}) {
  const reasonId = useId();
  const off = loading || down !== null || held !== null;
  const canSend = !off && value.trim() !== "";
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (canSend) {
      onSend?.(value);
    }
  };
  return (
    <form
      data-component="Composer"
      data-state={down === null ? (preview ?? "idle") : "disabled"}
      aria-label="Ask about this pull request"
      onSubmit={send}
    >
      {answeredAt !== null && (
        <p className="context">
          Questions are answered at <Sha sha={answeredAt} /> (latest)
        </p>
      )}
      <textarea
        ref={fieldRef}
        className="field"
        aria-label="Question"
        placeholder="Ask about this pull request..."
        value={value}
        readOnly={down !== null}
        aria-disabled={down !== null || undefined}
        aria-describedby={down === null ? undefined : reasonId}
        onChange={(event) => onChange?.(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      {down !== null && (
        <p className="reason" id={reasonId}>
          <span className="lead">
            <Icon name="plug" />
          </span>
          {DOWN_REASONS[down]}
        </p>
      )}
      <div className="footer">
        <p className="hint">{held === null ? "Enter to send · Shift+Enter for a new line" : HELD[held]}</p>
        <Button variant="primary" size="md" label="Send" type="submit" disabled={off} />
      </div>
    </form>
  );
}
