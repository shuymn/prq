// What the page says about the build it runs (plan §1.12): a server version other than this build's shows the new
// version notice; a part of the page that failed to load shows the asset notice, only while no version mismatch is
// known. Either sits first in the content, blocks nothing and offers Reload.

import { useEffect, useState } from "react";

import { Button } from "./components/Button.tsx";
import { Notice } from "./components/Notice.tsx";

// Whether a lazily loaded part of the page failed to load (Vite's preload error), since the page loaded.
export function useAssetFailed(): boolean {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const failure = () => setFailed(true);
    window.addEventListener("vite:preloadError", failure);
    return () => window.removeEventListener("vite:preloadError", failure);
  }, []);
  return failed;
}

const reload = () => location.reload();

export function BuildNotice({ serverVersion, assetFailed }: { serverVersion: string | null; assetFailed: boolean }) {
  if (serverVersion !== null && serverVersion !== __PRQ_VERSION__) {
    return (
      <Notice
        tone="info"
        title="A new version is available"
        text="This tab still runs the previous version. Reload to update it."
        actions={<Button variant="secondary" size="sm" label="Reload" onClick={reload} />}
      />
    );
  }
  if (assetFailed) {
    return (
      <Notice
        tone="info"
        title="Couldn't load part of this page."
        text="Try reloading."
        actions={<Button variant="secondary" size="sm" label="Reload" onClick={reload} />}
      />
    );
  }
  return null;
}
