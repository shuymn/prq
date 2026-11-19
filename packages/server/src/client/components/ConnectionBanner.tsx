import "./ConnectionBanner.css";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";

export type ConnectionState = "reconnecting" | "failed";

const TEXT: Record<ConnectionState, string> = {
  reconnecting: "Reconnecting… Showing the last known content.",
  failed: "Can't reconnect. Try reloading the page.",
};

// The connection to the pull request's session is down (design/components.md, Feedback): reconnecting, or, once
// reconnecting has kept failing, a Reload that names no cause. It sits first in the content and blocks nothing; the
// page announces the drop itself.
export function ConnectionBanner({
  state,
  unsent = false,
  onReload,
}: {
  state: ConnectionState;
  // A question waits for the stored history to hold it: reloading loses it.
  unsent?: boolean | undefined;
  onReload?: (() => void) | undefined;
}) {
  return (
    <div data-component="ConnectionBanner" data-state={state}>
      <p className="message">
        <span className="lead">
          <Icon name="plug" />
        </span>
        <span>
          {TEXT[state]}
          {state === "failed" && unsent && " Reloading loses your unsent question."}
        </span>
      </p>
      {state === "failed" && <Button variant="secondary" size="sm" label="Reload" onClick={onReload} />}
    </div>
  );
}
