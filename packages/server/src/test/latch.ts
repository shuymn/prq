// A promise a test opens by hand, to hold a step until another has happened.
export type Latch = { promise: Promise<void>; open(): void };

export function latch(): Latch {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
