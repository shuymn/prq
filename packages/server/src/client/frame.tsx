// The page around every view, as the app and the gallery render it: the header, with the agent pool from the Hub's
// view, then the view in the main region.

import type { HubView } from "@prq/protocol";
import { type ReactNode, useEffect } from "react";

import { type Line, linesShown, type Politeness, useAnnouncements } from "./announce.ts";
import { AppHeader } from "./components/AppHeader.tsx";
import type { Layout } from "./layout.ts";
import { Pool } from "./pool.tsx";

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

// The panel's PR detail has no header: the panel is the pull request's (docs/ui.md). `unavailable`: the Hub's socket has
// gone RECONNECT_FAILED_MS without an open. `route` names the view shown, whose change closes the pool's popover. `pool`
// takes the header pool's place (the gallery's open popover). On the Settings page the header marks its link to it.
export function Frame({
  view,
  unavailable = false,
  route,
  version,
  layout,
  header = true,
  pool,
  settings = false,
  children,
}: {
  view: HubView | null;
  unavailable?: boolean | undefined;
  route?: string | undefined;
  version: string;
  layout: Layout;
  header?: boolean | undefined;
  pool?: ReactNode;
  settings?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div className="app" data-layout={layout}>
      {header && (
        <AppHeader
          version={version}
          pool={pool ?? <Pool view={view} unavailable={unavailable} route={route} />}
          settings={settings}
        />
      )}
      <main>{children}</main>
      <Announcer />
    </div>
  );
}
