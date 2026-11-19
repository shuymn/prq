// A job's Retry as Summary, Message and JobRow show it (design/components.md, PR detail): Button secondary sm "Retry",
// busy while its request is out, and the `retry-error` part after it once a retry failed without the job changing.
// Each renders nothing for a job without Retry (no state), and the error nothing until a retry failed.

import "./retry.css";
import { Button } from "./Button.tsx";

export type RetryState = "ready" | "busy" | "failed";

export const RETRY_ERROR = "Couldn't retry. Try again.";

type RetryProps = { state?: RetryState | null | undefined };

export function RetryButton({ state, onRetry }: RetryProps & { onRetry?: (() => void) | undefined }) {
  return state === undefined || state === null ? null : (
    <Button variant="secondary" size="sm" label="Retry" busy={state === "busy"} onClick={onRetry} />
  );
}

export function RetryError({ state }: RetryProps) {
  return state === "failed" ? <span className="retry-error">{RETRY_ERROR}</span> : null;
}
