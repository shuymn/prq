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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Each unit from the largest, and how a whole number of it ago reads: minutes and hours abbreviated as the design
// writes them, without a period ("2 min ago", "1 hr ago"), and one day, month or year ago in words.
const UNITS: [number, (count: number) => string][] = [
  [365 * DAY, (count) => (count === 1 ? "last year" : `${count} years ago`)],
  [30 * DAY, (count) => (count === 1 ? "last month" : `${count} months ago`)],
  [DAY, (count) => (count === 1 ? "yesterday" : `${count} days ago`)],
  [HOUR, (count) => `${count} hr ago`],
  [MINUTE, (count) => `${count} min ago`],
];

// How long ago `at` was from `from`, in its largest whole unit; under a minute is "now".
function relativeText(at: number, from: number): string {
  const elapsed = Math.max(0, from - at);
  for (const [size, text] of UNITS) {
    if (elapsed >= size) {
      return text(Math.floor(elapsed / size));
    }
  }
  return "now";
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
