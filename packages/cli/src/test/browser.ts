// The machine's Chrome for the web UI's browser check (src/e2e/ui), driven through playwright: no browser is
// downloaded. One headless Chrome per test file, a fresh context (profile) per test, every page recorded: the
// responses (redirects included), console errors and uncaught errors, and Content Security Policy violations, reported
// by a listener installed before any of the page's scripts runs. A test fails on a violation or a console error it did
// not name as expected, and a failed test leaves a screenshot under test-output/ui in this package.
//
// The page's scripts are given as strings: this package checks its types without the DOM's.

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";

// How long Chrome has to start, and each step on a page (a navigation, a wait) to complete.
const CHROME_MS = 30_000;
const STEP_MS = 10_000;
const SCREENSHOTS = fileURLToPath(new URL("../../test-output/ui/", import.meta.url));

type Violation = { directive: string; blocked: string; sample: string };

type Recorded = {
  // Each response: its URL, status and headers (lowercase names).
  responses: { url: string; status: number; headers: Record<string, string> }[];
  consoleErrors: string[];
  violations: Violation[];
};

export type Session = {
  page(): Page;
  recorded(): Recorded;
  // What the test expects to see once: a violation or a console error matching it is not a failure.
  expectViolation(match: (violation: Violation) => boolean): void;
  expectConsoleError(match: (message: string) => boolean): void;
};

// Reports each violation to the test through a binding, which no page policy can block.
const VIOLATION_LISTENER = `
document.addEventListener("securitypolicyviolation", (event) => {
  window.__prqViolation({ directive: event.effectiveDirective, blocked: event.blockedURI, sample: event.sample });
});
`;

export function useBrowser(): Session {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let recorded: Recorded = { responses: [], consoleErrors: [], violations: [] };
  let expectedViolations: ((violation: Violation) => boolean)[] = [];
  let expectedErrors: ((message: string) => boolean)[] = [];

  beforeAll(async () => {
    browser = await chromium.launch({ channel: "chrome", headless: true, timeout: CHROME_MS });
  });
  beforeEach(async () => {
    recorded = { responses: [], consoleErrors: [], violations: [] };
    expectedViolations = [];
    expectedErrors = [];
    if (browser === undefined) {
      throw new Error("Chrome is not started");
    }
    context = await browser.newContext();
    context.setDefaultTimeout(STEP_MS);
    context.setDefaultNavigationTimeout(STEP_MS);
    await context.exposeBinding("__prqViolation", (_source, violation: Violation) => {
      recorded.violations.push(violation);
    });
    await context.addInitScript({ content: VIOLATION_LISTENER });
    const opened = await context.newPage();
    page = opened;
    opened.on("response", (response) => {
      recorded.responses.push({ url: response.url(), status: response.status(), headers: response.headers() });
    });
    // Each console error with the URL it came from, which a failed load's text leaves out.
    opened.on("console", (message) => {
      if (message.type() === "error") {
        const { url } = message.location();
        recorded.consoleErrors.push(url === "" ? message.text() : `${message.text()} (${url})`);
      }
    });
    opened.on("pageerror", (error) => recorded.consoleErrors.push(`uncaught: ${error.message}`));
  });
  afterEach(async ({ task }) => {
    const violations = recorded.violations.filter((violation) => !expectedViolations.some((match) => match(violation)));
    const errors = recorded.consoleErrors.filter((message) => !expectedErrors.some((match) => match(message)));
    // A screenshot for a failed test, and for one the unexpected violations or errors below fail.
    const failing = task.result?.state === "fail" || violations.length > 0 || errors.length > 0;
    if (failing && page !== undefined) {
      await mkdir(SCREENSHOTS, { recursive: true });
      const name = task.name.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase();
      await page.screenshot({ path: `${SCREENSHOTS}${name}.png`, fullPage: true }).catch(() => {});
    }
    // The context closes before the check, so a failed check leaves no page open.
    await context?.close();
    context = undefined;
    page = undefined;
    expect({ violations, errors }).toEqual({ violations: [], errors: [] });
  });
  afterAll(async () => {
    await browser?.close();
  });

  return {
    page() {
      if (page === undefined) {
        throw new Error("no page: the browser session runs inside a test");
      }
      return page;
    },
    recorded: () => recorded,
    expectViolation(match) {
      expectedViolations.push(match);
    },
    expectConsoleError(match) {
      expectedErrors.push(match);
    },
  };
}
