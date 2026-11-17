// A one-time gate a test opens: what waits on it resumes when the test says so, never on a timer.
export type Latch = { promise: Promise<void>; open(): void };

export function latch(): Latch {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}
