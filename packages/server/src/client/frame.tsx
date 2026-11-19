// The page around every view, as the app and the gallery render it: the header, with the pool's status from the Hub's
// view, then the view in the main region.

import type { HubView } from "@prq/protocol";
import type { ReactNode } from "react";

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

export function Frame({
  view,
  version,
  layout,
  children,
}: {
  view: HubView | null;
  version: string;
  layout: Layout;
  children: ReactNode;
}) {
  return (
    <div className="app" data-layout={layout}>
      <AppHeader version={version} pool={<Pool view={view} />} />
      <main>{children}</main>
    </div>
  );
}
