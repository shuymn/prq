import "./Settings.css";
import type { PromptKind } from "@prq/protocol";
import { type ReactNode, useEffect, useId, useState } from "react";

import { Button } from "../components/Button.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Modal } from "../components/modal.tsx";
import { Notice, ReadFailed } from "../components/Notice.tsx";
import { PromptEditor } from "../components/PromptEditor.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { SkillRegisterForm } from "../components/SkillRegisterForm.tsx";
import { SkillReview } from "../components/SkillReview.tsx";
import { SkillRow } from "../components/SkillRow.tsx";
import { PROMPT_TITLES, type SettingsDialog, type SettingsState, type SettingsStore } from "../settings.ts";

type SettingsActions = Pick<
  SettingsStore,
  | "reread"
  | "editPrompt"
  | "savePrompt"
  | "openRegister"
  | "editUrl"
  | "previewRegister"
  | "confirmRegister"
  | "openUpdate"
  | "editRef"
  | "cancelUpdate"
  | "previewUpdate"
  | "confirmUpdate"
  | "openRemove"
  | "confirmRemove"
  | "closeDialog"
>;

const PROMPTS: Record<PromptKind, { purpose: string; placeholder: string }> = {
  analysis: {
    purpose: "Free-form instructions the agent follows when it writes a summary.",
    placeholder: "For example: Write in Japanese. Keep the summary under 200 words.",
  },
  answer: {
    purpose: "Free-form instructions the agent follows when it answers a question.",
    placeholder: "For example: Answer in Japanese. Cite file paths when you refer to code.",
  },
};

const KINDS: PromptKind[] = ["analysis", "answer"];

// What the open dialog shows.
function DialogContent({
  dialog,
  titleId,
  dialogId,
  actions,
}: {
  dialog: SettingsDialog;
  titleId: string;
  dialogId: string;
  actions: Partial<SettingsActions>;
}) {
  if (dialog.kind === "register") {
    return (
      <SkillRegisterForm
        state={dialog.phase}
        url={dialog.url}
        reason={dialog.reason}
        titleId={titleId}
        dialogId={dialogId}
        onChange={actions.editUrl}
        onReview={actions.previewRegister}
      />
    );
  }
  if (dialog.kind === "remove") {
    return (
      <Dialog
        title={`Remove the skill ${dialog.name}?`}
        text="Analyses and answers stop using it. Registering it again resolves the ref anew."
        error={dialog.error}
        titleId={titleId}
        actions={
          <>
            <Button variant="secondary" size="md" label="Cancel" closes={dialogId} autofocus />
            <Button
              variant="danger"
              size="md"
              label="Remove skill"
              busy={dialog.busy}
              onClick={actions.confirmRemove}
            />
          </>
        }
      />
    );
  }
  return (
    <SkillReview
      preview={
        dialog.kind === "register-review"
          ? { mode: "register", skill: dialog.preview }
          : { mode: "update", skill: dialog.preview }
      }
      error={dialog.error}
      busy={dialog.busy}
      titleId={titleId}
      dialogId={dialogId}
      onConfirm={dialog.kind === "register-review" ? actions.confirmRegister : actions.confirmUpdate}
    />
  );
}

// The settings page (design/screens.md, Settings; its states: design/components.md, Settings and Feedback).
export function Settings({
  state,
  actions = {},
  notice,
}: {
  state: SettingsState;
  actions?: Partial<SettingsActions> | undefined;
  notice?: ReactNode | undefined;
}) {
  const dialogId = useId();
  const titleId = useId();
  // What had focus when the host asked for an update's review: its dialog returns focus there.
  const [reviewOpener, setReviewOpener] = useState<HTMLElement | null>(null);
  useEffect(() => {
    document.title = "Settings · prq";
  }, []);
  const loading = state.read === "loading";
  const { dialog, refForm } = state;

  return (
    <div className="settings">
      {notice}
      <h1 className="page-title" tabIndex={-1}>
        Settings
      </h1>
      {state.read === "failed" ? (
        <ReadFailed subject="settings" onRetry={actions.reread} />
      ) : (
        <>
          {state.refreshFailed && <ReadFailed subject="settings" refresh onRetry={actions.reread} />}
          {state.unconfirmed.map((title, index) => (
            <Notice key={index} tone="attention" title={title} text="The next read of the list settles it." />
          ))}
          <section className="prompts">
            <h2>Prompts</h2>
            {KINDS.map((kind) => {
              const editor = state.prompts[kind];
              return loading ? (
                <div key={kind} className="placeholder">
                  <Skeleton shape="line" />
                  <Skeleton shape="block" />
                </div>
              ) : (
                <PromptEditor
                  key={kind}
                  title={PROMPT_TITLES[kind]}
                  purpose={PROMPTS[kind].purpose}
                  placeholder={PROMPTS[kind].placeholder}
                  value={editor.draft}
                  status={editor.status === "idle" && editor.draft === "" ? "empty" : editor.status}
                  savedAt={editor.savedAt}
                  onChange={(text) => actions.editPrompt?.(kind, text)}
                  onSave={() => void actions.savePrompt?.(kind)}
                />
              );
            })}
          </section>
          <section className="skills">
            <div className="skills-head">
              <div className="intro">
                <h2>Skills</h2>
                <p>
                  A skill adds instructions, references and scripts to analyses and answers. Each one is pinned to a
                  commit.
                </p>
              </div>
              {!loading && <Button variant="secondary" size="md" label="Add skill" onClick={actions.openRegister} />}
            </div>
            {loading && (
              <div className="placeholder">
                <Skeleton shape="block" />
                <Skeleton shape="block" />
              </div>
            )}
            {!loading && state.skills.length === 0 && (
              <EmptyState
                icon="tools"
                title="No skills registered"
                text="A skill is a folder with a SKILL.md that adds instructions, references and scripts to analyses and answers. Add one with “Add skill” above; it is pinned to a commit."
              />
            )}
            {!loading && state.skills.length > 0 && (
              <ul className="skill-list">
                {state.skills.map((skill) => {
                  const form = refForm?.name === skill.name ? refForm : null;
                  return (
                    <SkillRow
                      key={skill.name}
                      name={skill.name}
                      description={skill.description}
                      source={skill.source}
                      skillRef={skill.ref}
                      sha={skill.sha}
                      allowedTools={skill.allowedTools}
                      state={form === null ? "rest" : dialog?.kind === "update-review" ? "update-review" : "update-ref"}
                      refForm={
                        form === null
                          ? undefined
                          : {
                              value: form.ref,
                              busy: form.busy,
                              error: form.error,
                              onChange: actions.editRef,
                              onReview: () => {
                                const focused = document.activeElement;
                                setReviewOpener(focused instanceof HTMLElement ? focused : null);
                                void actions.previewUpdate?.();
                              },
                              onCancel: actions.cancelUpdate,
                            }
                      }
                      onUpdate={() => actions.openUpdate?.(skill.name)}
                      onRemove={() => actions.openRemove?.(skill.name)}
                    />
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
      {dialog !== null && (
        <Modal
          id={dialogId}
          labelledBy={titleId}
          focusKey={`${dialog.kind}:${dialog.kind !== "register" && dialog.error?.final === true}`}
          opener={dialog.kind === "update-review" ? reviewOpener : null}
          onClose={() => actions.closeDialog?.()}
        >
          <DialogContent dialog={dialog} titleId={titleId} dialogId={dialogId} actions={actions} />
        </Modal>
      )}
    </div>
  );
}
