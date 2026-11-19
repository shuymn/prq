// Waiting for the page in a browser test without moving fake timers: React renders and runs effects in tasks, which
// fake timers do not move, while expect.poll, expect.element and the locators' actions advance fake time by their
// interval on each retry, which would move a bound the test measures.

// A task of the page's event loop.
export const nextTask = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.addEventListener("message", () => resolve(), { once: true });
    channel.port1.start();
    channel.port2.postMessage(null);
  });

// Waits, a task at a time, until the page gets there.
export async function until(check: () => boolean): Promise<void> {
  const end = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > end) {
      throw new Error("the page did not get there within 10 s");
    }
    await nextTask();
  }
}
