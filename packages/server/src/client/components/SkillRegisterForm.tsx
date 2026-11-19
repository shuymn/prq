import "./modal.css";
import "./SkillRegisterForm.css";
import type { FormEvent } from "react";

import { Button } from "./Button.tsx";
import { Notice } from "./Notice.tsx";
import { TextField } from "./TextField.tsx";

type RegisterFormState = "idle" | "registering" | "failed";

// The "Add skill" dialog (design/components.md, Settings): the link to a SKILL.md, then Review skill, busy while the
// server resolves the ref and fetches the skill; a refused link shows the server's reason. Cancel closes the dialog
// `dialogId` names. The field has focus as the dialog opens.
export function SkillRegisterForm({
  state,
  url,
  reason = null,
  titleId,
  dialogId,
  onChange,
  onReview,
}: {
  state: RegisterFormState;
  url: string;
  reason?: string | null | undefined;
  titleId?: string | undefined;
  dialogId?: string | undefined;
  onChange?: ((url: string) => void) | undefined;
  onReview?: (() => void) | undefined;
}) {
  // A busy Review skill takes no submit (Enter in the field included): one preview is out at a time.
  const review = (event: FormEvent) => {
    event.preventDefault();
    if (state !== "registering") {
      onReview?.();
    }
  };
  return (
    <form data-component="SkillRegisterForm" data-state={state} className="dialog-box" onSubmit={review}>
      <h2 className="title" id={titleId}>
        Add a skill
      </h2>
      <div className="body">
        <TextField
          label="SKILL.md URL"
          hint="Paste a GitHub link to a SKILL.md. The branch or tag in the link is pinned to a commit."
          value={url}
          autofocus
          onChange={onChange}
        />
        {state === "failed" && <Notice tone="danger" title="Register failed" text={reason ?? undefined} />}
      </div>
      <div className="actions">
        {state === "registering" && <p className="progress">Resolving the ref and fetching the skill…</p>}
        <Button variant="secondary" size="md" label="Cancel" closes={dialogId} />
        <Button variant="primary" size="md" label="Review skill" type="submit" busy={state === "registering"} />
      </div>
    </form>
  );
}
