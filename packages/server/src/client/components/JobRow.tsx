import "./JobRow.css";
import type { ReactNode } from "react";

import { RetryButton, RetryError, type RetryState } from "./retry.tsx";
import { Sha } from "./Sha.tsx";
import { Status } from "./Status.tsx";

export type JobRowState = "waiting" | "running" | "stalled" | "failed" | "done";

// A question job's target: its question's text on one line, quoted and cut with an ellipsis.
export type JobTargetLabel = { kind: "analysis"; sha: string } | { kind: "answer"; question: string };

// One job of the pull request (design/components.md, PR detail): its target (an analysis by its head's SHA, a question
// by its text), its state, and what it is doing (the agent and since when, "cloud" and its start, why it waits, why it
// failed), ended by the workspace SHA a question runs at once one is recorded; then Retry on a claimed or failed job,
// and the retry error after it once a retry failed. Full is one line; compact stacks the meta under the target, Retry
// to its right and the retry error under both, as the rail and the panel show it.
export function JobRow({
  state,
  density,
  target,
  meta,
  at,
  retry,
  onRetry,
}: {
  state: JobRowState;
  density: "full" | "compact";
  target: JobTargetLabel;
  meta: ReactNode;
  // The workspace SHA a question job runs at.
  at?: string | null | undefined;
  // The job's Retry, when it offers one.
  retry?: RetryState | null | undefined;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div data-component="JobRow" data-state={state} data-density={density}>
      <div className="row">
        <div className="info">
          <span className="target-row">
            {target.kind === "analysis" ? (
              <span className="target">
                Analysis of <Sha sha={target.sha} />
              </span>
            ) : (
              <span className="target target-label">
                “<span className="cut">{target.question}</span>”
              </span>
            )}
            <Status state={state} />
          </span>
          <span className="meta-row">
            <span className="meta">{meta}</span>
            {at !== undefined && at !== null && (
              <span className="at">
                {meta !== "" && "· "}at <Sha sha={at} />
              </span>
            )}
          </span>
        </div>
        <RetryButton state={retry} onRetry={onRetry} />
      </div>
      <RetryError state={retry} />
    </div>
  );
}
