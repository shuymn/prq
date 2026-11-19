// What the page says about the build it runs (plan §1.12): a server version other than this build's, from either
// socket, shows the new version notice; a part of the page that failed to load shows the asset notice, only while no
// version mismatch is known. Either sits first in the content, blocks nothing and offers Reload, which loses a question
// history has yet to hold. The settings page that failed as it rendered says so in its own place, with Reload too.

import { Component, type ReactNode, useCallback, useEffect, useState } from "react";

import { Button } from "./components/Button.tsx";
import { Notice, type NoticeTone } from "./components/Notice.tsx";

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

// A lazily loaded part's module that could not load.
class ChunkFailed extends Error {
  override name = "ChunkFailed";
}

// Marks a lazily loaded part's failed import: `lazy(() => import(…).catch(chunkFailed))`. The import's message, which
// names the module, stays the error's.
export function chunkFailed(error: unknown): never {
  throw new ChunkFailed(error instanceof Error ? error.message : String(error), { cause: error });
}

// A lazily loaded part of the page (the settings): when it cannot load, `fallback` shows in its place, and `onError`
// reports it. Any other error as it renders shows `failed` in its place, and the rest of the page keeps working.
export class ChunkBoundary extends Component<
  { onError: () => void; fallback: ReactNode; failed: ReactNode; children: ReactNode },
  { caught: { error: unknown } | null }
> {
  override state: { caught: { error: unknown } | null } = { caught: null };

  static getDerivedStateFromError(error: unknown): { caught: { error: unknown } } {
    return { caught: { error } };
  }

  override componentDidCatch(error: unknown): void {
    if (error instanceof ChunkFailed) {
      this.props.onError();
    }
  }

  override render(): ReactNode {
    const { caught } = this.state;
    if (caught === null) {
      return this.props.children;
    }
    return caught.error instanceof ChunkFailed ? this.props.fallback : this.props.failed;
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
  return notice === null ? null : <ReloadNotice tone="info" {...notice} unsent={unsent} />;
}

// The settings page in place of what failed as it rendered.
export function ShowFailed({ unsent }: { unsent: boolean }) {
  return (
    <ReloadNotice tone="danger" title="Couldn't show settings" text="Reload the page to try again." unsent={unsent} />
  );
}

function ReloadNotice({
  tone,
  title,
  text,
  unsent,
}: {
  tone: NoticeTone;
  title: string;
  text: string;
  unsent: boolean;
}) {
  return (
    <Notice
      tone={tone}
      title={title}
      text={unsent ? `${text} ${UNSENT}` : text}
      actions={<Button variant="secondary" size="sm" label="Reload" onClick={reload} />}
    />
  );
}
