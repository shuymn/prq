// The page around every view, as the app and the gallery render it: the header, with the pool's status from the Hub's
// view, then the view in the main region.

import type { HubView } from "@prq/protocol";
import type { ReactNode } from "react";

import { useAnnouncements } from "./announce.ts";
import { AppHeader } from "./components/AppHeader.tsx";
import { PoolStatus } from "./components/PoolStatus.tsx";
import type { Layout } from "./layout.ts";

// The pool's status in the header; it opens nothing yet.
function Pool({ view }: { view: HubView | null }) {
  if (view === null) {
    return <PoolStatus form="button" state="loading" />;
  }
  return (
    <PoolStatus
      form="button"
      state={view.localAgentPresent ? "local" : "cloud-only"}
      agents={view.presentAgents}
      jobs={view.jobs}
    />
  );
}

// The app's live regions: each announcement is a new line, so the same text is read again.
function Announcer() {
  const { polite, assertive } = useAnnouncements();
  return (
    <>
      <div className="announcer" aria-live="polite">
        <p key={polite.count}>{polite.text}</p>
      </div>
      <div className="announcer" aria-live="assertive">
        <p key={assertive.count}>{assertive.text}</p>
      </div>
    </>
  );
}

// The panel's PR detail has no header: the panel is the pull request's (docs/ui.md).
export function Frame({
  view,
  version,
  layout,
  header = true,
  children,
}: {
  view: HubView | null;
  version: string;
  layout: Layout;
  header?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div className="app" data-layout={layout}>
      {header && <AppHeader version={version} pool={<Pool view={view} />} />}
      <main>{children}</main>
      <Announcer />
    </div>
  );
}
