import { useEffect, useRef } from "react";

import { Frame } from "./frame.tsx";
import { useHub } from "./hub.ts";
import { useLayout } from "./layout.ts";
import { BuildNotice, useAssetFailed } from "./notices.tsx";
import { type Route, useRoute } from "./routes.ts";
import { NotFound } from "./screens/NotFound.tsx";
import { PrListScreen } from "./screens/PrListScreen.tsx";

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
    <Frame view={hub.view} version={__PRQ_VERSION__} layout={layout}>
      {route.name === "list" && <PrListScreen key={key} hub={hub} notice={notice} />}
      {route.name === "not-found" && <NotFound key={key} notice={notice} />}
    </Frame>
  );
}
