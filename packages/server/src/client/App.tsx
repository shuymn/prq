import { lazy, Suspense, useEffect, useRef } from "react";

import { Frame } from "./frame.tsx";
import { useHub } from "./hub.ts";
import { useLayout } from "./layout.ts";
import { BuildNotice, ChunkBoundary, chunkFailed, ShowFailed, useAssetFailed } from "./notices.tsx";
import { type Route, useRoute } from "./routes.ts";
import { NotFound } from "./screens/NotFound.tsx";
import { PrDetailScreen } from "./screens/PrDetailScreen.tsx";
import { PrListScreen } from "./screens/PrListScreen.tsx";
import { useUnsent } from "./slots.ts";

// The settings come in a chunk of their own, loaded when the page opens.
const SettingsScreen = lazy(() => import("./screens/SettingsScreen.tsx").catch(chunkFailed));

// The route's view as a key: a change of it is a navigation to another view.
const viewKey = (route: Route) => (route.name === "detail" ? `detail:${JSON.stringify(route.ref)}` : route.name);

// Focuses the view's heading once it renders: a detail's comes with its session's first view.
function focusHeading(main: HTMLElement): () => void {
  const focus = () => {
    const heading = main.querySelector<HTMLElement>("h1");
    heading?.focus();
    return heading !== null;
  };
  if (focus()) {
    return () => undefined;
  }
  const observer = new MutationObserver(() => {
    if (focus()) {
      observer.disconnect();
    }
  });
  observer.observe(main, { childList: true, subtree: true });
  return () => observer.disconnect();
}

// The page on every path: the header, and the route's view, first in which a notice about the build shows.
export function App() {
  const hub = useHub();
  const route = useRoute();
  const layout = useLayout();
  const [assetFailed, failAsset] = useAssetFailed();
  const unsent = useUnsent();
  const notice = (sessionVersion: string | null = null) => (
    <BuildNotice serverVersions={[hub.serverVersion, sessionVersion]} assetFailed={assetFailed} unsent={unsent} />
  );

  // After a navigation in the page, the new view's heading takes focus; the first view keeps the browser's.
  const key = viewKey(route);
  const first = useRef(key);
  useEffect(() => {
    const main = document.querySelector("main");
    if (key === first.current || main === null) {
      return undefined;
    }
    first.current = "";
    return focusHeading(main);
  }, [key]);

  return (
    <Frame
      view={hub.view}
      unavailable={hub.unavailable}
      route={key}
      version={__PRQ_VERSION__}
      layout={layout}
      header={!(layout === "panel" && route.name === "detail")}
      settings={route.name === "settings"}
    >
      {route.name === "list" && <PrListScreen key={key} hub={hub} notice={notice()} />}
      {route.name === "detail" && (
        <PrDetailScreen key={key} prRef={route.ref} hub={hub} layout={layout} notice={notice} />
      )}
      {route.name === "settings" && (
        <ChunkBoundary key={key} onError={failAsset} fallback={notice()} failed={<ShowFailed unsent={unsent} />}>
          <Suspense fallback={notice()}>
            <SettingsScreen notice={notice()} />
          </Suspense>
        </ChunkBoundary>
      )}
      {route.name === "not-found" && <NotFound key={key} notice={notice()} />}
    </Frame>
  );
}
