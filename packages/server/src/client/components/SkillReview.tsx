import "./modal.css";
import "./SkillReview.css";
import type { AllowedTool, SkillPreview, SkillUpdatePreview } from "@prq/protocol";

import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { Notice } from "./Notice.tsx";
import { Sha, shortSha } from "./Sha.tsx";
import { refText, sourceText } from "./skill-text.ts";

// A confirm that failed: what to say, and whether trying again can help (the server's line) or not (the name taken,
// the skill changed), which turns the confirm off.
export type ConfirmError = { title: string; text: string; final: boolean };

const entries = (tools: readonly AllowedTool[] | null) => (tools ?? []).map((tool) => tool.entry);

// The update's allowed tools beside the registered ones: those kept, added and removed, each by its entry as written.
function toolChange(preview: SkillUpdatePreview) {
  const before = entries(preview.current.allowedTools);
  const after = entries(preview.allowedTools);
  return {
    kept: after.filter((entry) => before.includes(entry)),
    added: after.filter((entry) => !before.includes(entry)),
    removed: before.filter((entry) => !after.includes(entry)),
  };
}

// What a confirm would pin, before it does (design/components.md, Settings): the skill's name and description, its
// source and ref, the commit it pins (register) or the old and new ref and commit (update), the tools it permits and,
// for an update, those added and removed, and its files, scripts flagged. The confirm names the commit it pins; it is
// busy while out and off after a failure trying again cannot fix. Cancel closes the dialog `dialogId` names. The
// confirm has focus as the review opens, Cancel once the confirm is off.
export function SkillReview({
  preview,
  error = null,
  busy = false,
  titleId,
  dialogId,
  onConfirm,
}: {
  preview: { mode: "register"; skill: SkillPreview } | { mode: "update"; skill: SkillUpdatePreview };
  error?: ConfirmError | null | undefined;
  busy?: boolean | undefined;
  titleId?: string | undefined;
  dialogId?: string | undefined;
  onConfirm?: (() => void) | undefined;
}) {
  const { mode, skill } = preview;
  const change = preview.mode === "update" ? toolChange(preview.skill) : null;
  const tools = change?.kept ?? entries(skill.allowedTools);
  const final = error?.final ?? false;
  return (
    <div data-component="SkillReview" data-mode={mode} className="dialog-box">
      <div className="head">
        <h2 className="title" id={titleId}>
          {skill.name}
        </h2>
        <p className="description">{skill.description}</p>
      </div>
      <ul className="facts">
        <li>
          <span className="lead">
            <Icon name="repo" />
          </span>
          <span>
            {sourceText(skill.source)}
            {mode === "register" && ` @ ${refText(skill.ref)}`}
          </span>
        </li>
        <li className="pin">
          <Icon name="git-merge" />
          {preview.mode === "register" ? (
            <>
              Pinned to <Sha sha={skill.sha} />
            </>
          ) : (
            <>
              {refText(preview.skill.current.ref)} <Sha sha={preview.skill.current.sha} /> → {refText(skill.ref)}{" "}
              <Sha sha={skill.sha} />
            </>
          )}
        </li>
        <li className="tools">
          <Icon name="shield-check" />
          <span className="badges">
            {entries(skill.allowedTools).length === 0 && (
              <span>No allowed-tools: instructions and references only</span>
            )}
            {tools.map((entry) => (
              <Badge key={entry} tone="neutral" label={entry} />
            ))}
            {change !== null && change.added.length > 0 && (
              <Badge tone="success" label={`Added: ${change.added.join(", ")}`} />
            )}
            {change !== null && change.removed.length > 0 && (
              <Badge tone="danger" label={`Removed: ${change.removed.join(", ")}`} />
            )}
          </span>
        </li>
        <li>
          <span className="lead">
            <Icon name="file-code" />
          </span>
          <ul className="files" aria-label="Files">
            {skill.files.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>
                {file.script && <Badge tone="attention" label="script" />}
              </li>
            ))}
          </ul>
        </li>
      </ul>
      {error !== null && <Notice tone="danger" title={error.title} text={error.text} />}
      <div className="actions">
        <Button variant="secondary" size="md" label="Cancel" closes={dialogId} autofocus={final} />
        <Button
          variant="primary"
          size="md"
          label={mode === "register" ? `Register at ${shortSha(skill.sha)}` : `Apply update to ${shortSha(skill.sha)}`}
          busy={busy}
          disabled={final}
          autofocus={!final}
          onClick={onConfirm}
        />
      </div>
    </div>
  );
}
