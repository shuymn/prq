import "./Disclosure.css";
import type { ReactNode } from "react";

import { Icon } from "./Icon.tsx";

// Content that opens and closes under a label (design/components.md, Layout and navigation), built on <details>: the
// chevron before the label, then the content lined up under the label. Meta follows the label in the same row but
// outside <summary>, since a control inside it would toggle the disclosure. `heading` gives the label the heading's
// type (the panel's "Summary"), without making it a heading inside <summary>. The element keeps its own open state,
// which the chevron follows; `defaultOpen` is where it starts.
export function Disclosure({
  label,
  meta,
  defaultOpen = false,
  heading = false,
  children,
}: {
  label: string;
  meta?: ReactNode | undefined;
  defaultOpen?: boolean | undefined;
  heading?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div data-component="Disclosure">
      <details open={defaultOpen}>
        <summary>
          <span className="lead">
            <Icon name="chevron-down" />
            <Icon name="chevron-right" />
          </span>
          <span className="label" data-heading={heading || undefined}>
            {label}
          </span>
        </summary>
        <div className="content">{children}</div>
      </details>
      {meta !== undefined && <div className="meta">{meta}</div>}
    </div>
  );
}
