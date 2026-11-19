// The page around every view, as the app and the gallery render it: the header, with the pool's status from the Hub's
// view, then the view in the main region.

import type { HubView } from "@prq/protocol";
import { type ReactNode, useEffect } from "react";

import { type Line, linesShown, type Politeness, useAnnouncements } from "./announce.ts";
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

// A live region: each announcement is a new line, so the same text is read again.
function Region({ politeness, lines }: { politeness: Politeness; lines: readonly Line[] }) {
  const last = lines.at(-1)?.count ?? 0;
  useEffect(() => {
    linesShown(politeness, last);
  }, [politeness, last]);
  return (
    <div className="announcer" aria-live={politeness}>
      {lines.map((line) => (
        <p key={line.count}>{line.text}</p>
      ))}
    </div>
  );
}

// The app's live regions.
function Announcer() {
  const { polite, assertive } = useAnnouncements();
  return (
    <>
      <Region politeness="polite" lines={polite} />
      <Region politeness="assertive" lines={assertive} />
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
