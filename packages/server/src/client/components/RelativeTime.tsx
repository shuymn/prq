import "./RelativeTime.css";
import { useSyncExternalStore } from "react";

// One clock for every relative time on the page, ticking every 30 seconds while any is shown.
const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) {
        notify();
      }
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const FORMAT = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60_000],
  ["month", 30 * 24 * 60 * 60_000],
  ["day", 24 * 60 * 60_000],
  ["hour", 60 * 60_000],
  ["minute", 60_000],
];

// How long ago `at` was from `from`, in its largest whole unit ("3 min. ago", "yesterday"); under a minute is "now".
function relativeText(at: number, from: number): string {
  const elapsed = Math.max(0, from - at);
  for (const [unit, size] of UNITS) {
    if (elapsed >= size) {
      return FORMAT.format(-Math.floor(elapsed / size), unit);
    }
  }
  return FORMAT.format(0, "second");
}

// A time as how long ago it was (design/components.md, Status and labels), in a <time> carrying the instant.
export function RelativeTime({ at }: { at: number }) {
  const current = useSyncExternalStore(subscribe, () => now);
  return (
    <time data-component="RelativeTime" dateTime={new Date(at).toISOString()}>
      {relativeText(at, Math.max(current, at))}
    </time>
  );
}
