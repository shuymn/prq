import "./Notice.css";
import type { MouseEvent, ReactNode } from "react";

import { Button } from "./Button.tsx";
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

// A read that failed (design/components.md, Feedback): "Couldn't load" its subject in place of what it reads, or, for a
// refresh, "Couldn't refresh" it over what was read before; Try again reads again.
export function ReadFailed({
  subject,
  refresh = false,
  onRetry,
}: {
  subject: string;
  refresh?: boolean | undefined;
  onRetry?: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined;
}) {
  return (
    <Notice
      tone="danger"
      title={`Couldn't ${refresh ? "refresh" : "load"} ${subject}`}
      text={refresh ? "Showing what was loaded before." : undefined}
      actions={<Button variant="secondary" size="sm" label="Try again" onClick={onRetry} />}
    />
  );
}
