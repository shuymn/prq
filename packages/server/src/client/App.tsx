import { useEffect, useRef } from "react";

import { AppHeader } from "./components/AppHeader.tsx";
import { PoolStatus } from "./components/PoolStatus.tsx";
import { type Hub, useHub } from "./hub.ts";
import { useLayout } from "./layout.ts";
import { BuildNotice, useAssetFailed } from "./notices.tsx";
import { type Route, useRoute } from "./routes.ts";
import { NotFound } from "./screens/NotFound.tsx";
import { PrListScreen } from "./screens/PrListScreen.tsx";

// The pool's status in the header, from the Hub's view; it opens nothing yet.
function Pool({ hub }: { hub: Hub }) {
  const { view } = hub;
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

// The route's view as a key: a change of it is a navigation to another view.
const viewKey = (route: Route) => (route.name === "detail" ? `detail:${JSON.stringify(route.ref)}` : route.name);

// The page on every path: the header, and the route's view, first in which a notice about the build shows.
export function App() {
  const hub = useHub();
  const route = useRoute();
  const layout = useLayout();
  const assetFailed = useAssetFailed();
  const notice = <BuildNotice serverVersion={hub.serverVersion} assetFailed={assetFailed} />;

  // After a navigation in the page, the new view's heading takes focus; the first view keeps the browser's.
  const key = viewKey(route);
  const first = useRef(key);
  useEffect(() => {
    if (key !== first.current) {
      first.current = "";
      document.querySelector<HTMLElement>("main h1")?.focus();
    }
  }, [key]);

  return (
    <div className="app" data-layout={layout}>
      <AppHeader version={__PRQ_VERSION__} pool={<Pool hub={hub} />} />
      <main>
        {route.name === "list" && <PrListScreen key={key} hub={hub} notice={notice} />}
        {route.name === "not-found" && <NotFound key={key} notice={notice} />}
      </main>
    </div>
  );
}
