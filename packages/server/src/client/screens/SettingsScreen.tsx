// The settings page as the app shows it (plan §1.14), in a chunk of its own the app loads when the page opens: the
// store over the page's fetch, read as the page opens, its requests ended when the page leaves.

import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

import { useFetch } from "../reads.ts";
import { SettingsStore } from "../settings.ts";
import { Settings } from "./Settings.tsx";

export default function SettingsScreen({ notice }: { notice?: ReactNode | undefined }) {
  const fetcher = useFetch();
  const [store] = useState(() => new SettingsStore(fetcher));
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  return <Settings state={state} actions={store} notice={notice} />;
}
