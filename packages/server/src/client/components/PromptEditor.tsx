import "./PromptEditor.css";
import { PROMPT_CHARS } from "@prq/protocol";
import { type FormEvent, useId } from "react";

import { clockTime } from "../screens/detail-model.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { TextArea } from "./TextArea.tsx";

// Where an editor's text is: as read or typed (idle; empty when there is none), its save out, saved, or its save
// failed.
export type PromptStatus = "idle" | "empty" | "saving" | "saved" | "failed";

const SAVE_FAILED = "Save failed: the server did not respond. Your text is kept; save again.";

// One of the host's prompts (design/components.md, Settings): its title and what it is for, the text, and Save with
// how the last save went. Typing goes on while a save is out; the page decides what the text is.
export function PromptEditor({
  title,
  purpose,
  placeholder,
  value,
  status,
  savedAt = null,
  onChange,
  onSave,
  preview,
}: {
  title: string;
  purpose: string;
  placeholder: string;
  value: string;
  status: PromptStatus;
  savedAt?: number | null | undefined;
  onChange?: ((value: string) => void) | undefined;
  onSave?: (() => void) | undefined;
  preview?: "focus" | undefined;
}) {
  const titleId = useId();
  const purposeId = useId();
  const save = (event: FormEvent) => {
    event.preventDefault();
    onSave?.();
  };
  return (
    <form data-component="PromptEditor" data-status={status} aria-labelledby={titleId} onSubmit={save}>
      <div className="head">
        <h3 className="title" id={titleId}>
          {title}
        </h3>
        <p className="purpose" id={purposeId}>
          {purpose}
        </p>
      </div>
      <TextArea
        labelledBy={titleId}
        describedById={purposeId}
        value={value}
        placeholder={placeholder}
        maxLength={PROMPT_CHARS}
        onChange={onChange}
        preview={preview}
      />
      <div className="footer">
        <Button variant="primary" size="md" label="Save prompt" type="submit" busy={status === "saving"} />
        {status === "saving" && <p className="status">Saving…</p>}
        {status === "saved" && savedAt !== null && (
          <p className="status">
            <Icon name="check-circle" />
            Saved at {clockTime(savedAt)}
          </p>
        )}
        {status === "failed" && (
          <p className="status" data-tone="danger">
            <span className="lead">
              <Icon name="x-circle" />
            </span>
            {SAVE_FAILED}
          </p>
        )}
      </div>
    </form>
  );
}
