// What the page says about the build it runs (plan §1.12): a server version other than this build's, from either
// socket, shows the new version notice; a part of the page that failed to load shows the asset notice, only while no
// version mismatch is known. Either sits first in the content, blocks nothing and offers Reload, which loses a question
// history has yet to hold.

import { Component, type ReactNode, useCallback, useEffect, useState } from "react";

import { Button } from "./components/Button.tsx";
import { Notice } from "./components/Notice.tsx";

// Whether a lazily loaded part of the page failed to load since the page loaded (Vite's preload error, or a failure
// the page reports: a lazily loaded component that could not load), and the way to report one.
export function useAssetFailed(): [boolean, () => void] {
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  useEffect(() => {
    window.addEventListener("vite:preloadError", fail);
    return () => window.removeEventListener("vite:preloadError", fail);
  }, [fail]);
  return [failed, fail];
}

// A lazily loaded part of the page (the settings): when it cannot load, or fails as it renders, `fallback` shows in its
// place, and `onError` reports it.
export class ChunkBoundary extends Component<
  { onError: () => void; fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onError();
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
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
