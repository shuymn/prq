// What the PR detail shows, read from the page for the browser checks (src/e2e/ui): the conversation in order and the
// shown summary. The page's scripts are given as strings: this package checks its types without the DOM's.

import type { Locator, Page } from "playwright";
import * as v from "valibot";

const Shown = v.array(v.object({ role: v.string(), state: v.string(), text: v.string() }));

// Each message of the conversation: question or answer, its state, and its text.
export async function conversation(page: Page): Promise<v.InferOutput<typeof Shown>> {
  const shown: unknown = await page.evaluate(
    `[...document.querySelectorAll('.conversation [data-component="Message"]')].map((message) => ({
      role: message.dataset.role,
      state: message.dataset.state,
      text: (message.querySelector(".question, .body")?.textContent ?? "").trim(),
    }))`,
  );
  return v.parse(Shown, shown);
}

// The shown summary's text, once it holds this.
export function summary(page: Page, text: string): Locator {
  return page.locator('[data-component="Summary"] .body', { hasText: text });
}
