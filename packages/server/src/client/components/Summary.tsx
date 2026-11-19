import "./Summary.css";
import type { ReactNode } from "react";

import { Icon } from "./Icon.tsx";
import { RetryButton, RetryError, type RetryState } from "./retry.tsx";
import { Sha } from "./Sha.tsx";
import { Skeleton } from "./Skeleton.tsx";
import { Status } from "./Status.tsx";

type SummaryState = "ready" | "loading" | "streaming" | "empty";

// The pull request's summary (design/components.md, PR detail), pinned above the conversation: its heading with the
// version menu, then the shown version's text and the model and tokens muted at its end. While a newer head is
// analyzed, a line under the heading says so, or, once that analysis is possibly stalled, says that in attention with
// its Retry (and the retry error after it); a notice above the body says the newest analysis failed; a streaming
// version shows its text so far with the caret and its running line; an empty one says why no analysis has started.
// In the panel's Disclosure the heading is off (the Disclosure's row has the label and the menu), a streaming version
// keeping its running line.
export function Summary({
  state,
  version,
  heading = true,
  summarizing,
  stalled,
  retry,
  onRetry,
  notice,
  content,
  running,
  meta,
  waiting,
}: {
  state: SummaryState;
  version?: ReactNode | undefined;
  heading?: boolean | undefined;
  // A newer head being analyzed.
  summarizing?: string | null | undefined;
  // An analysis possibly stalled: its head, why ("possibly stalled: no result from laptop after 64 min"), and its Retry.
  stalled?: { sha: string; detail: string } | null | undefined;
  retry?: RetryState | null | undefined;
  onRetry?: (() => void) | undefined;
  notice?: ReactNode | undefined;
  content?: ReactNode | undefined;
  // A streaming version's turn: who runs it and since when ("cloud · started 10:14").
  running?: ReactNode | undefined;
  // The model, and for a stored cloud result the tokens.
  meta?: string | null | undefined;
  // Why no analysis has started (empty).
  waiting?: string | undefined;
}) {
  const runningLine = state === "streaming" && running !== undefined && (
    <span className="running">
      <Status state="running" label="Writing" />
      <span>{running}</span>
    </span>
  );
  const progress =
    stalled !== undefined && stalled !== null ? (
      <div className="progress" data-tone="attention">
        <span className="info">
          <Icon name="alert" />
          Summary of <Sha sha={stalled.sha} /> {stalled.detail}
        </span>
        {retry !== undefined && retry !== null && <RetryButton state={retry} onRetry={onRetry} />}
        {retry === "failed" && <RetryError />}
      </div>
    ) : (
      summarizing !== undefined &&
      summarizing !== null && (
        <p className="progress">
          <span className="info">
            <Icon name="sync" />
            Summarizing <Sha sha={summarizing} />
          </span>
        </p>
      )
    );
  return (
    <section data-component="Summary" data-state={state} aria-busy={state === "loading" || undefined}>
      {(heading || runningLine !== false || progress !== false) && (
        <div className="header">
          <div className="title-row">
            {heading && <h2 className="title">Summary</h2>}
            {heading && version}
            {runningLine}
          </div>
          {progress}
        </div>
      )}
      {notice}
      {state === "loading" && (
        <div className="skeleton">
          <Skeleton shape="line" />
          <Skeleton shape="line" />
          <Skeleton shape="line" />
          <Skeleton shape="block" />
        </div>
      )}
      {state === "empty" && waiting !== undefined && <Status state="waiting" label={waiting} />}
      {(state === "ready" || state === "streaming") && (
        <div className="body">
          {content}
          {state === "streaming" && content === undefined && <span className="caret" aria-hidden="true" />}
        </div>
      )}
      {meta !== undefined && meta !== null && state !== "loading" && <p className="meta">{meta}</p>}
    </section>
  );
}
