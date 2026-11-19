import "./NotFound.css";
import { type ReactNode, useEffect } from "react";

import { ButtonLink } from "../components/Button.tsx";
import { EmptyState } from "../components/EmptyState.tsx";

// A path that is no page of the UI, or a pull request's path its parts cannot name (design/components.md, Feedback).
export function NotFound({ notice }: { notice?: ReactNode }) {
  useEffect(() => {
    document.title = "Page not found · prq";
  }, []);
  return (
    <div className="not-found">
      {notice}
      <EmptyState
        icon="alert"
        title="Page not found"
        text="There is no page at this address."
        heading="h1"
        actions={<ButtonLink variant="secondary" size="md" label="Go to pull requests" href="/" />}
      />
    </div>
  );
}
