import "./EmptyState.css";
import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon.tsx";

// What stands in the place of content there is none of (design/components.md, Feedback): an icon, a title, a text
// and optional actions (medium secondary buttons), centred in a bordered card. Its title is the page's heading where
// it is the whole page (heading h1), else a section's.
export function EmptyState({
  icon,
  title,
  text,
  actions,
  heading: Heading = "h2",
}: {
  icon: IconName;
  title: string;
  text: string;
  actions?: ReactNode | undefined;
  heading?: "h1" | "h2" | undefined;
}) {
  return (
    <section data-component="EmptyState">
      <Icon name={icon} />
      <Heading className="title" tabIndex={-1}>
        {title}
      </Heading>
      <p className="text">{text}</p>
      {actions !== undefined && <div className="actions">{actions}</div>}
    </section>
  );
}
