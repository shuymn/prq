import "./modal.css";
import "./Dialog.css";
import type { ReactNode } from "react";

import { Notice } from "./Notice.tsx";

// A confirmation (design/components.md, Settings: "Remove the skill review?"): its title and text, then its actions,
// the safe one first and focused; an action that failed shows a danger Notice above them.
export function Dialog({
  title,
  text,
  error = null,
  actions,
  titleId,
}: {
  title: string;
  text: string;
  error?: { title: string; text: string } | null | undefined;
  actions: ReactNode;
  titleId?: string | undefined;
}) {
  return (
    <div data-component="Dialog" className="dialog-box">
      <div className="head">
        <h2 className="title" id={titleId}>
          {title}
        </h2>
        <p className="text">{text}</p>
      </div>
      {error !== null && <Notice tone="danger" title={error.title} text={error.text} />}
      <div className="actions">{actions}</div>
    </div>
  );
}
