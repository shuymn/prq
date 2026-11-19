// The PR list in Chrome against the real Worker in wrangler's local runtime, through the Access stand-in's browser door
// (plan P2.1–P2.4, P2.7–P2.9): what the list reads and when, a pass superseded while it pages, the repository menu, the
// version notice under an earlier deploy's bundle, and the paths that are no page.

import { LedgerPage, MAX_TITLE_CHARS, MAX_URL_CHARS, type PrRef } from "@prq/protocol";
import type { Page } from "playwright";
import * as v from "valibot";
import { describe, expect, test, vi } from "vitest";

import { useBrowser } from "../../test/browser.ts";
import { latch } from "../../test/latch.ts";
import { buildOldBundle, OLD_VERSION } from "../../test/old-bundle.ts";
import { push, sha } from "../../test/pr.ts";
import { useStack } from "../../test/stack.ts";

const stack = useStack();
const browser = useBrowser();

const SERVER_VERSION = `v${(await import("../../../../server/package.json", { with: { type: "json" } })).default.version}`;

const door = (path: string) => new URL(path, stack.access().door.url).href;
const pr = (repo: string, number: number): PrRef => ({ owner: "shuymn", repo, number });

// The ledger reads the door forwarded, in order, each with its query.
const ledgerReads = () => stack.access().door.log.filter((entry) => entry.path.startsWith("/api/ledger"));

// The pull requests the list shows, as the paths their rows link to.
async function shownRows(page: Page): Promise<string[]> {
  const hrefs: unknown = await page.evaluate(
    `[...document.querySelectorAll('table [data-component="PrRow"] a.title')].map((a) => a.getAttribute("href"))`,
  );
  return v.parse(v.array(v.string()), hrefs);
}

// The ledger as a fresh read gives it, every page, as the paths the list links to; and each page's row count.
async function freshRead(): Promise<{ rows: string[]; pages: number[] }> {
  const worker = stack.worker();
  const rows: string[] = [];
  let cursor: string | null = null;
  const pages: number[] = [];
  do {
    const query = new URLSearchParams({ state: "open", ...(cursor === null ? {} : { cursor }) });
    const res = await fetch(new URL(`/api/ledger?${query.toString()}`, worker.url()), {
      headers: { "Cf-Access-Jwt-Assertion": await worker.token() },
    });
    const page = v.parse(LedgerPage, await res.json());
    rows.push(...page.rows.map((row) => `/pr/${row.details?.fullName}/${row.pr.number}`));
    cursor = page.nextCursor;
    pages.push(page.rows.length);
  } while (cursor !== null);
  return { rows, pages };
}

// Gates the Hub's upgrades, a retry's too, until released.
function gateHub() {
  const arrived = latch();
  const release = latch();
  for (let i = 0; i < 5; i += 1) {
    stack.access().door.plan((path) => path.startsWith("/agents/hub/"), {
      kind: "gate",
      arrived: i === 0 ? arrived : latch(),
      release,
    });
  }
  return { arrived, release };
}

// A local agent's wait, with no work to wait for: it times out, its start and end contacts with the Hub.
async function agentWait(agentId: string): Promise<void> {
  expect((await stack.run(["wait", "--agent-id", agentId, "--timeout", "1"])).code).toBe(2);
}

// The shell's loads the door forwarded.
const shells = () => stack.access().door.log.filter((entry) => entry.path === "/").length;

// The pool's status in the header once the Hub's view says this.
const pool = (page: Page, label: string) => page.locator('[data-component="PoolStatus"] .label', { hasText: label });

const stateControl = (page: Page, label: "Open" | "All") =>
  page.getByRole("radiogroup", { name: "State" }).getByText(label, { exact: true });

describe("the list's reads", () => {
  test("reads the open pull requests without waiting for the Hub; Open/All and the repository change the read", async () => {
    const worker = stack.worker();
    await push(worker, pr("prq", 1), sha("a"));
    await push(worker, pr("kopje", 2), sha("b"));
    const hub = gateHub();
    const page = browser.page();
    await page.goto(door("/"));
    await hub.arrived.promise;
    await page.locator('a.title[href="/pr/shuymn/kopje/2"]').waitFor();
    expect(ledgerReads().map((entry) => entry.path)).toEqual(["/api/ledger?state=open"]);
    expect(await page.getByText("Loading pool").isVisible()).toBe(true);

    await stateControl(page, "All").click();
    await vi.waitFor(() => expect(ledgerReads().at(-1)?.path).toBe("/api/ledger?state=all"));
    await page.getByRole("button", { name: "All repositories" }).click();
    await page.getByRole("menuitemradio", { name: "shuymn/kopje" }).click();
    await vi.waitFor(() => expect(ledgerReads().at(-1)?.path).toBe("/api/ledger?state=all&repo=shuymn%2Fkopje"));
    await page.locator('a.title[href="/pr/shuymn/prq/1"]').waitFor({ state: "detached" });
    expect(await shownRows(page)).toEqual(["/pr/shuymn/kopje/2"]);
    await stateControl(page, "Open").click();
    await vi.waitFor(() => expect(ledgerReads().at(-1)?.path).toBe("/api/ledger?state=open&repo=shuymn%2Fkopje"));
    hub.release.open();
  });

  test("Needs attention reads attention=1 alone, answered 200", async () => {
    // The pull request's analysis waits with no local agent present: it needs attention.
    await push(stack.worker(), pr("prq", 1), sha("a"));
    const page = browser.page();
    await page.goto(door("/"));
    await page.getByRole("button", { name: "Needs attention · 1" }).click();
    await vi.waitFor(() =>
      expect(ledgerReads().at(-1)).toMatchObject({ path: "/api/ledger?attention=1", status: 200 }),
    );
    await page.locator('a.title[href="/pr/shuymn/prq/1"]').waitFor();
  });

  test("reads again for the ledger, presence and a first view after the pass began; not for a second agent or a contact", async () => {
    const worker = stack.worker();
    await push(worker, pr("prq", 1), sha("a"));
    const hub = gateHub();
    const page = browser.page();
    await page.goto(door("/"));
    await hub.arrived.promise;
    await page.locator('a.title[href="/pr/shuymn/prq/1"]').waitFor();
    expect(ledgerReads()).toHaveLength(1);

    // The first view, after the pass began.
    hub.release.open();
    await pool(page, "Cloud only").waitFor();
    await vi.waitFor(() => expect(ledgerReads()).toHaveLength(2));

    // A stored entry advances ledgerVersion.
    await push(worker, pr("prq", 2), sha("b"));
    await page.locator('a.title[href="/pr/shuymn/prq/2"]').waitFor();
    expect(ledgerReads()).toHaveLength(3);

    // A local agent arrives: presence changes.
    await agentWait("laptop");
    await pool(page, "1 local agent").waitFor();
    await vi.waitFor(() => expect(ledgerReads()).toHaveLength(4));

    // A second agent's wait changes the view's count of agents, and the first agent's contact changes nothing in it.
    await agentWait("desk");
    await pool(page, "2 local agents").waitFor();
    await agentWait("laptop");

    // The next entry is read once: neither of them was.
    await push(worker, pr("prq", 3), sha("c"));
    await page.locator('a.title[href="/pr/shuymn/prq/3"]').waitFor();
    expect(ledgerReads().map((entry) => entry.path)).toEqual(Array(5).fill("/api/ledger?state=open"));
    // Three `prq wait` runs in the body take most of 30 s on a loaded machine.
  }, 60_000);
});

// A title and a URL at their longest in bytes, so that a page of the ledger holds few rows.
const largest = (number: number) => {
  const title = `${number} ${"あ".repeat(MAX_TITLE_CHARS - String(number).length - 1)}`;
  const url = `https://github.com/shuymn/prq/pull/${number}?`;
  return { title, url: url.padEnd(MAX_URL_CHARS, "x") };
};

describe("a pass superseded while it pages", () => {
  test("the pass that replaces it reads as deep, also when replaced before its second page, and swaps the rows at once", async () => {
    const worker = stack.worker();
    const count = 60;
    for (let number = 1; number <= count; number += 1) {
      await push(worker, pr("prq", number), sha(`h${number}`), sha("base"), largest(number));
    }
    const first = await freshRead();
    expect(first.pages).toHaveLength(2);
    const firstPage = first.pages[0] ?? 0;

    const page = browser.page();
    await page.goto(door("/"));
    await pool(page, "Cloud only").waitFor();
    await vi.waitFor(async () => expect(await shownRows(page)).toEqual(first.rows.slice(0, firstPage)));
    const shown = await shownRows(page);
    // The first page in place, the list asks for the second, which the Worker answers and the door holds.
    const second = { kind: "hold", answered: latch(), release: latch() } as const;
    stack.access().door.plan((path) => path.includes("cursor="), second);
    const readsBefore = ledgerReads().length;
    await page.locator(".next-page").scrollIntoViewIfNeeded();
    await second.answered.promise;

    // A push moves a row of the second page onto the first: a new pass, whose first page the door holds too.
    const moved = "/pr/shuymn/prq/5";
    expect(first.rows.indexOf(moved)).toBeGreaterThanOrEqual(firstPage);
    const replaced = { kind: "hold", answered: latch(), release: latch() } as const;
    stack.access().door.plan((path) => path === "/api/ledger?state=open", replaced);
    await push(worker, pr("prq", 5), sha("h5-again"), sha("base"), largest(5));
    await replaced.answered.promise;
    expect(await shownRows(page)).toEqual(shown);

    // A local agent arrives before that pass reaches its second page: presence changes, and another pass replaces it,
    // whose second page the door holds. Until it answers, the rows are those shown before.
    const winning = { kind: "hold", answered: latch(), release: latch() } as const;
    stack.access().door.plan((path) => path.includes("cursor="), winning);
    await agentWait("laptop");
    await pool(page, "1 local agent").waitFor();
    await winning.answered.promise;
    expect(await shownRows(page)).toEqual(shown);
    second.release.open();
    replaced.release.open();
    winning.release.open();

    const fresh = await freshRead();
    expect(fresh.pages).toHaveLength(2);
    expect(fresh.rows[0]).toBe(moved);
    await vi.waitFor(async () => expect(await shownRows(page)).toEqual(fresh.rows), { timeout: 10_000 });
    // The held reads were given up; the last pass read two pages.
    const reads = ledgerReads().slice(readsBefore);
    expect(reads.map(({ path, cancelled }) => ({ next: path.includes("cursor="), cancelled }))).toEqual([
      { next: true, cancelled: true },
      { next: false, cancelled: true },
      { next: false, cancelled: false },
      { next: true, cancelled: false },
    ]);
  }, 60_000);
});

describe("the repository menu", () => {
  test("opening it reads the repositories; with one owner, rows and menu leave it out", async () => {
    const worker = stack.worker();
    await push(worker, pr("prq", 1), sha("a"));
    await push(worker, pr("kopje", 2), sha("b"));
    const page = browser.page();
    await page.goto(door("/"));
    await pool(page, "Cloud only").waitFor();
    await page.getByRole("button", { name: "All repositories" }).click();
    const items = page.getByRole("menuitemradio");
    await page.getByRole("menuitemradio", { name: "prq" }).waitFor();
    expect(await items.allInnerTexts()).toEqual(["All repositories", "kopje", "prq"]);
    expect(stack.access().door.log.filter((entry) => entry.path.startsWith("/api/repos"))).toMatchObject([
      { path: "/api/repos", status: 200 },
    ]);
    const repositories: unknown = await page.evaluate(
      `[...document.querySelectorAll('[data-component="PrRow"] .repo-cell')].map((cell) => cell.textContent)`,
    );
    expect(repositories).toEqual(["kopje", "prq"]);
  });
});

describe("an earlier deploy's bundle", () => {
  test("shows one version notice; its filter works; Reload loads the current shell without it", async ({ signal }) => {
    const bundle = await buildOldBundle({ signal });
    try {
      await push(stack.worker(), pr("prq", 1), sha("a"));
      stack.access().door.serve(bundle.dir);
      const page = browser.page();
      await page.goto(door("/"));
      const version = page.locator('[data-component="AppHeader"] .version');
      expect(await version.innerText()).toBe(OLD_VERSION);
      await page.getByText("A new version is available").waitFor();
      expect(await page.locator('[data-component="Notice"]').count()).toBe(1);

      await stateControl(page, "All").click();
      await vi.waitFor(() =>
        expect(ledgerReads().at(-1)).toMatchObject({ path: "/api/ledger?state=all", status: 200 }),
      );
      await page.locator('a.title[href="/pr/shuymn/prq/1"]').waitFor();

      stack.access().door.serve(null);
      await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Reload" }).click()]);
      await pool(page, "Cloud only").waitFor();
      expect(await version.innerText()).toBe(SERVER_VERSION);
      expect(await page.locator('[data-component="Notice"]').count()).toBe(0);
    } finally {
      await bundle.close();
    }
  });
});

describe("paths that are no page", () => {
  test("a path PrRef refuses and a path no route matches show the not-found page, with no session socket", async () => {
    const page = browser.page();
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(new URL(socket.url()).pathname));
    for (const path of ["/pr/a/b/0", "/pr/a/b/x", "/pr/-a/b/1", "/nope"]) {
      await page.goto(door(path));
      await page.getByRole("heading", { level: 1, name: "Page not found" }).waitFor();
      expect({ path, title: await page.title() }).toEqual({ path, title: "Page not found · prq" });
    }
    expect(sockets.filter((path) => !path.startsWith("/agents/hub/"))).toEqual([]);
  });

  test("a reload, a fragment link and the shell's own file are left to the browser", async () => {
    const page = browser.page();
    await page.goto(door("/"));
    await page.getByRole("heading", { level: 1, name: "Pull requests" }).waitFor();
    await page.evaluate(`(() => {
      window.prqPage = "first";
      window.prqHashChanges = 0;
      window.addEventListener("hashchange", () => { window.prqHashChanges += 1; });
      const link = document.createElement("a");
      link.href = "#below";
      link.textContent = "Below";
      document.querySelector("main").append(link);
    })()`);
    // An intercepted navigation would change the fragment without a hashchange.
    await page.getByRole("link", { name: "Below" }).click();
    await vi.waitFor(async () =>
      expect(await page.evaluate(`[location.hash, window.prqHashChanges, window.prqPage]`)).toEqual([
        "#below",
        1,
        "first",
      ]),
    );

    // A reload the page makes, as Reload in the version notice does: the Navigation API could intercept it.
    const before = shells();
    await Promise.all([page.waitForEvent("load"), page.evaluate(`setTimeout(() => location.reload())`)]);
    await page.getByRole("heading", { level: 1, name: "Pull requests" }).waitFor();
    expect(shells()).toBe(before + 1);
    expect(await page.evaluate(`window.prqPage ?? null`)).toBeNull();

    // A link to the shell's own file, which the Worker's assets answer: a page of the UI would say there is none.
    await page.evaluate(`(() => {
      window.prqPage = "second";
      const link = document.createElement("a");
      link.href = "/index.html";
      link.textContent = "Shell";
      document.querySelector("main").append(link);
    })()`);
    await page.getByRole("link", { name: "Shell" }).click();
    await vi.waitFor(
      async () =>
        expect(await page.evaluate(`[window.prqPage ?? null, document.querySelector("main h1")?.textContent]`)).toEqual(
          [null, "Pull requests"],
        ),
      { timeout: 10_000 },
    );
  });
});
