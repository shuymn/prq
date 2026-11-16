// Bounded waits: every wait on another object, on the SDK or on an earlier task ends, at the latest with a WaitTimeout.

export class WaitTimeout extends Error {
  override readonly name = "WaitTimeout";
}

// The promise's outcome, or a WaitTimeout after ms. The promise itself keeps running; a caller that gives up on it
// must still accept its late outcome (prq's calls are idempotent or re-checked where their result is used).
export async function withTimeout<T>(promise: PromiseLike<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WaitTimeout(`${what} took over ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// How long a task waits for the tasks queued before it.
const SERIAL_WAIT_MS = 30_000;

// One task at a time, each starting after the previous one ended. A task that waits longer than waitMs for the earlier
// ones fails without running; later tasks still wait for the earlier ones, so two tasks never run together.
export class SerialQueue {
  readonly #what: string;
  readonly #waitMs: number;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(what: string, waitMs = SERIAL_WAIT_MS) {
    this.#what = what;
    this.#waitMs = waitMs;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    const result = withTimeout(previous, this.#waitMs, `${this.#what} waiting for the one before it`).then(task);
    this.#tail = Promise.allSettled([previous, result]);
    return result;
  }
}
