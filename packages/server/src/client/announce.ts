// The app's two live regions (plan §1.20): one polite, one assertive, at the app root. A screen announces a line; the
// same line again is announced again.

import { useSyncExternalStore } from "react";

export type Politeness = "polite" | "assertive";

type Lines = Readonly<Record<Politeness, { text: string; count: number }>>;

let lines: Lines = { polite: { text: "", count: 0 }, assertive: { text: "", count: 0 } };
const listeners = new Set<() => void>();

export function announce(text: string, politeness: Politeness): void {
  lines = { ...lines, [politeness]: { text, count: lines[politeness].count + 1 } };
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAnnouncements(): Lines {
  return useSyncExternalStore(subscribe, () => lines);
}
