// The app's two live regions (plan §1.20): one polite, one assertive, at the app root. A screen announces a line; the
// same line again is announced again. Each line is an element of its own: the lines announced before the region shows
// them are added together, in the order announced, so none replaces another unread, and the next line after that
// replaces the lines shown.

import { useSyncExternalStore } from "react";

export type Politeness = "polite" | "assertive";

export type Line = { text: string; count: number };
type Lines = Readonly<Record<Politeness, readonly Line[]>>;

let count = 0;
let lines: Lines = { polite: [], assertive: [] };
const shown: Record<Politeness, number> = { polite: 0, assertive: 0 };
const listeners = new Set<() => void>();

export function announce(text: string, politeness: Politeness): void {
  count += 1;
  const unshown = lines[politeness].filter((line) => line.count > shown[politeness]);
  lines = { ...lines, [politeness]: [...unshown, { text, count }] };
  for (const listener of listeners) {
    listener();
  }
}

// The region shows the lines up to `upTo`.
export function linesShown(politeness: Politeness, upTo: number): void {
  shown[politeness] = Math.max(shown[politeness], upTo);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAnnouncements(): Lines {
  return useSyncExternalStore(subscribe, () => lines);
}
