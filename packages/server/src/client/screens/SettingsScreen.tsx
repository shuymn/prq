// The settings page as the app shows it (plan §1.14), in a chunk of its own the app loads when the page opens: the
// app's store over the page's fetch, which keeps the drafts across leaving the page; the saved values are read as the
// page opens, and its read and previews end when it leaves.

import { type ReactNode, useEffect, useSyncExternalStore } from "react";

import { useFetch } from "../reads.ts";
import { settingsStore } from "../settings.ts";
import { Settings } from "./Settings.tsx";

export default function SettingsScreen({ notice }: { notice?: ReactNode | undefined }) {
  const store = settingsStore(useFetch());
  useEffect(() => {
    store.reread();
    return () => store.leave();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  return <Settings state={state} actions={store} notice={notice} />;
}
