import "./modal.css";
import { type ReactNode, useLayoutEffect, useRef } from "react";

// The settings' dialogs (design/components.md, Settings: SkillRegisterForm, SkillReview, Dialog) as a native modal
// dialog (plan §1.20): opened with showModal() once it renders, so the page is inert and focus stays inside;
// Escape and its Cancel (an invoker command) close it, a click outside does not (`closedby="closerequest"`). The
// browser returns focus to the control that opened it when it closes, and closing it from the page (it stops
// rendering) closes it the same way. What it shows marks the control to focus with data-autofocus; a new `focusKey`
// focuses that control again (the review that replaces the registration form).
export function Modal({
  id,
  labelledBy,
  focusKey,
  onClose,
  children,
}: {
  id: string;
  labelledBy: string;
  focusKey: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // The focusKey whose control has been focused, since the dialog last opened.
  const focused = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) {
      return undefined;
    }
    element.showModal();
    return () => {
      focused.current = null;
      element.close();
    };
  }, []);
  useLayoutEffect(() => {
    if (focused.current !== focusKey) {
      focused.current = focusKey;
      dialog.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
  });
  return (
    <dialog
      ref={dialog}
      id={id}
      className="modal"
      closedby="closerequest"
      aria-labelledby={labelledBy}
      // A close the page made as it reopened the dialog (React's development remount) is no longer this one's.
      onClose={(event) => {
        if (!event.currentTarget.open) {
          onClose();
        }
      }}
    >
      {children}
    </dialog>
  );
}
