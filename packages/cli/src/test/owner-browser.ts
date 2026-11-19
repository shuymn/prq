// The owner checks' --browser (check:skills, check:workspace): the machine's Chrome, headed, on the check's Worker
// through the Access stand-in's browser door (door.ts), so that the owner watches the pages the check drives. Chrome
// starts within CHROME_MS and each step on a page completes within STEP_MS unless the check gives it a longer bound. A
// Chrome that fails to start closes the stand-in it opened; close() ends both.

import { chromium, type Page } from "playwright";

import { startAccess } from "./access.ts";
import type { Worker } from "./worker.ts";

const CHROME_MS = 30_000;
const STEP_MS = 10_000;

export type OwnerBrowser = {
  page: Page;
  // A path of the web UI, at the door.
  url(path: string): string;
  close(): Promise<void>;
};

export async function openOwnerBrowser(worker: Worker): Promise<OwnerBrowser> {
  const access = await startAccess(worker);
  try {
    const browser = await chromium.launch({ channel: "chrome", headless: false, timeout: CHROME_MS });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(STEP_MS);
      page.setDefaultNavigationTimeout(STEP_MS);
      return {
        page,
        url: (path) => new URL(path, access.door.url).href,
        async close() {
          try {
            await browser.close();
          } finally {
            await access.close();
          }
        },
      };
    } catch (error) {
      await browser.close();
      throw error;
    }
  } catch (error) {
    await access.close();
    throw error;
  }
}
