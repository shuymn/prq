import "./SkillRow.css";
import type { AllowedTool, SkillRef, SkillSource } from "@prq/protocol";
import type { FormEvent } from "react";

import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { Sha } from "./Sha.tsx";
import { refText, sourceText } from "./skill-text.ts";
import { TextField } from "./TextField.tsx";

type SkillRowState = "rest" | "update-ref" | "update-review";

// The ref form Update opens under the row: the ref, its preview out (busy) or refused (the reason).
type RefForm = {
  value: string;
  busy: boolean;
  error: string | null;
  onChange?: ((value: string) => void) | undefined;
  onReview?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
};

// The tools a skill's allowed-tools permits, as badges, or that it has none.
function ToolBadges({ tools }: { tools: readonly AllowedTool[] | null }) {
  if (tools === null || tools.length === 0) {
    return <Badge tone="neutral" label="Instructions only" />;
  }
  return tools.map((tool) => <Badge key={tool.entry} tone="neutral" label={tool.entry} />);
}

// A registered skill (design/components.md, Settings): its name and description, where it was registered from and
// the commit it is pinned to, and the tools it permits; Update and Remove. Update opens the ref form under the row
// (update-ref), which keeps its ref, its buttons off, while the update's review is open over the page (update-review).
// The buttons stay in place unseen then, so the dialog returns focus to the Review update that opened it.
export function SkillRow({
  name,
  description,
  source,
  skillRef,
  sha,
  allowedTools,
  state,
  refForm,
  onUpdate,
  onRemove,
}: {
  name: string;
  description: string;
  source: SkillSource;
  skillRef: SkillRef;
  sha: string;
  allowedTools: readonly AllowedTool[] | null;
  state: SkillRowState;
  refForm?: RefForm | undefined;
  onUpdate?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}) {
  const review = (event: FormEvent) => {
    event.preventDefault();
    refForm?.onReview?.();
  };
  return (
    <li data-component="SkillRow" data-state={state}>
      <div className="main">
        <div className="info">
          <h3 className="name">{name}</h3>
          <p className="description">{description}</p>
          <p className="source">
            <Icon name="repo" />
            <span>
              {sourceText(source)} @ {refText(skillRef)}
            </span>
            <Sha sha={sha} />
          </p>
          <p className="tools">
            <ToolBadges tools={allowedTools} />
          </p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" label="Update" onClick={onUpdate} />
          <Button variant="danger" size="sm" label="Remove" onClick={onRemove} />
        </div>
      </div>
      {state !== "rest" && refForm !== undefined && (
        <form className="ref-form" aria-label={`Update ${name}`} onSubmit={review}>
          <TextField
            label="Ref"
            hint="A branch, tag or commit to update to."
            value={refForm.value}
            error={refForm.error}
            readOnly={state === "update-review"}
            autofocus
            onChange={refForm.onChange}
          />
          <Button variant="primary" size="md" label="Review update" type="submit" busy={refForm.busy} />
          <Button variant="invisible" size="md" label="Cancel" onClick={refForm.onCancel} />
        </form>
      )}
    </li>
  );
}
