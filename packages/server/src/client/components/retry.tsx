// A job's Retry as Summary, Message and JobRow show it (design/components.md, PR detail): Button secondary sm "Retry",
// busy while its request is out, and the `retry-error` part after it once a retry failed without the job changing.

import "./retry.css";
import { Button } from "./Button.tsx";

export type RetryState = "ready" | "busy" | "failed";

export const RETRY_ERROR = "Couldn't retry. Try again.";

export function RetryButton({ state, onRetry }: { state: RetryState; onRetry?: (() => void) | undefined }) {
  return <Button variant="secondary" size="sm" label="Retry" busy={state === "busy"} onClick={onRetry} />;
}

export function RetryError() {
  return <span className="retry-error">{RETRY_ERROR}</span>;
}
