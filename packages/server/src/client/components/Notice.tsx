import "./Notice.css";
import type { ReactNode } from "react";

import { Icon } from "./Icon.tsx";

export type NoticeTone = "info" | "attention" | "danger";

const ICONS = { info: "info", attention: "alert", danger: "x-circle" } as const;

// An inline notice (design/components.md, Feedback): the icon, then the title, an optional text and optional actions
// (small buttons) in one column. It blocks nothing and has no dismiss.
export function Notice({
  tone,
  title,
  text,
  actions,
}: {
  tone: NoticeTone;
  title: string;
  text?: string | undefined;
  actions?: ReactNode | undefined;
}) {
  return (
    <div data-component="Notice" data-tone={tone}>
      <span className="lead">
        <Icon name={ICONS[tone]} />
      </span>
      <div className="body">
        <p className="title">{title}</p>
        {text !== undefined && <p className="text">{text}</p>}
        {actions !== undefined && <div className="actions">{actions}</div>}
      </div>
    </div>
  );
}
