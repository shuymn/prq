// Which layout the page takes (plan §1.4): the extension panel's below the narrow breakpoint, the page's above it.
// The page root carries it as data-layout; the extension (#10) gives `panel` itself.

import { useSyncExternalStore } from "react";

import { NARROW_PX } from "./tokens.ts";

const narrow = matchMedia(`(width < ${NARROW_PX}px)`);

function subscribe(listener: () => void): () => void {
  narrow.addEventListener("change", listener);
  return () => narrow.removeEventListener("change", listener);
}

export type Layout = "page" | "panel";

export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, () => (narrow.matches ? "panel" : "page"));
}
