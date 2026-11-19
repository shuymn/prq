// A fetch the test answers: each request waits until the test responds to it or fails it. An abort is recorded on
// the request's signal and does not settle it, so a test can deliver a superseded answer late. An answer's body reads
// at once, so the reader has taken it by the next task (settled()).

import type { Fetch } from "../reads.ts";

export type Pending = {
  url: URL;
  method: string;
  // The request's body, when it has a text one.
  body: string | null;
  signal: AbortSignal;
  respond(body: unknown, status?: number): void;
  fail(): void;
};

class Answer extends Response {
  readonly #body: unknown;

  constructor(body: unknown, status: number) {
    super(null, { status });
    this.#body = body;
  }

  override json(): Promise<unknown> {
    return Promise.resolve(this.#body);
  }
}

// Resolves once every answer given so far has been taken.
export const settled = () => new Promise((resolve) => setTimeout(resolve));

export function controlledFetch() {
  const requests: Pending[] = [];
  const waiters: (() => void)[] = [];
  const fetcher: Fetch = (input, init) =>
    new Promise<Response>((resolve, reject) => {
      requests.push({
        url: new URL(input, location.origin),
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? init.body : null,
        signal: init.signal ?? new AbortController().signal,
        respond: (body, status = 200) => resolve(new Answer(body, status)),
        fail: () => reject(new TypeError("Failed to fetch")),
      });
      for (const wake of waiters.splice(0)) {
        wake();
      }
    });
  return {
    fetch: fetcher,
    requests,
    // The n-th request (from 0), once it has been made.
    async request(index: number): Promise<Pending> {
      while (requests[index] === undefined) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      return requests[index];
    },
  };
}
