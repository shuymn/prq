// What the page says about the build it runs (plan §1.12): a server version other than this build's, from either
// socket, shows the new version notice; a part of the page that failed to load shows the asset notice, only while no
// version mismatch is known. Either sits first in the content, blocks nothing and offers Reload, which loses a question
// history has yet to hold.

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

// The notice for what is known, a version mismatch before a failed asset, or none.
function buildNotice(
  serverVersions: readonly (string | null)[],
  assetFailed: boolean,
): { title: string; text: string } | null {
  if (serverVersions.some((version) => version !== null && version !== __PRQ_VERSION__)) {
    return {
      title: "A new version is available",
      text: "This tab still runs the previous version. Reload to update it.",
    };
  }
  return assetFailed ? { title: "Couldn't load part of this page.", text: "Try reloading." } : null;
}

const UNSENT = "Reloading loses your unsent question.";

export function BuildNotice({
  serverVersions,
  assetFailed,
  unsent = false,
}: {
  serverVersions: readonly (string | null)[];
  assetFailed: boolean;
  unsent?: boolean | undefined;
}) {
  const notice = buildNotice(serverVersions, assetFailed);
  if (notice === null) {
    return null;
  }
  return (
    <Notice
      tone="info"
      title={notice.title}
      text={unsent ? `${notice.text} ${UNSENT}` : notice.text}
      actions={<Button variant="secondary" size="sm" label="Reload" onClick={reload} />}
    />
  );
}
