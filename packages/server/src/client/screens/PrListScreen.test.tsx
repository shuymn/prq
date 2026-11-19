// The PR list over a fetch the test answers (plan P2.5–P2.7): its failures and Try again, its empty states, and how it
// names repositories and reads them for the menu.

import { type HubView, LedgerRow } from "@prq/protocol";
import * as v from "valibot";
import { describe, expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import type { Hub } from "../hub.ts";
import { FetchContext } from "../reads.ts";
import { controlledFetch, type Pending } from "../test/fetch.ts";
import { PrListScreen } from "./PrListScreen.tsx";

const view = (change: Partial<HubView> = {}): HubView => ({
  localAgentPresent: false,
  presentAgents: 0,
  jobs: { waiting: 0, running: 0, failed: 0 },
  needsAttention: 0,
  owners: 1,
  ledgerVersion: 1,
  ...change,
});

const hubOf = (hubView: HubView | null): Hub => ({ view: hubView, opens: 1, serverVersion: null });

const row = (fullName: string, number: number, title: string) => {
  const [owner = "", repo = ""] = fullName.split("/");
  return v.parse(LedgerRow, {
    pr: { owner, repo, number },
    details: {
      fullName,
      title,
      state: "open",
      url: `https://github.com/${fullName}/pull/${number}`,
      headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      baseSha: "0123456789abcdef0123456789abcdef01234567",
    },
    owner: "local",
    latestEvent: null,
    problem: null,
    jobs: { waiting: 0, running: 0, failed: 0 },
    claims: [],
  });
};

const ROWS = [row("shuymn/prq", 42, "Add retry to stalled jobs"), row("shuymn/kopje", 16, "Render tables")];

async function list(hub: Hub) {
  const fetch = controlledFetch();
  const screen = await render(
    <FetchContext value={fetch.fetch}>
      <PrListScreen hub={hub} />
    </FetchContext>,
  );
  const rerender = (next: Hub) =>
    screen.rerender(
      <FetchContext value={fetch.fetch}>
        <PrListScreen hub={next} />
      </FetchContext>,
    );
  return { fetch, rerender };
}

const path = (request: Pending) => `${request.url.pathname}${request.url.search}`;
const titles = () =>
  page
    .getByRole("table")
    .getByRole("link")
    .elements()
    .map((link) => link.textContent);
const controls = () => [
  page.getByRole("button", { name: "All repositories" }),
  page.getByRole("radio", { name: "Open" }),
  page.getByRole("radio", { name: "All" }),
];
const firstRepository = () => page.getByRole("table").getByRole("row").nth(1).getByRole("cell").first();

describe("the PR list's failures", () => {
  test("a failed first pass shows the load failure, and Try again reads again", async () => {
    const { fetch } = await list(hubOf(view()));
    (await fetch.request(0)).fail();
    await expect.element(page.getByText("Couldn't load pull requests")).toBeVisible();
    expect(page.getByRole("table").elements()).toEqual([]);

    await page.getByRole("button", { name: "Try again" }).click();
    const again = await fetch.request(1);
    expect(path(again)).toBe("/api/ledger?state=open");
    again.respond({ rows: ROWS, nextCursor: null });
    await expect.element(page.getByRole("link", { name: "Add retry to stalled jobs" })).toBeVisible();
    expect(page.getByText("Couldn't load pull requests").elements()).toEqual([]);
  });

  test("a failed later pass keeps the rows with the refresh failure, and Try again reads again", async () => {
    const { fetch, rerender } = await list(hubOf(view()));
    (await fetch.request(0)).respond({ rows: ROWS, nextCursor: null });
    await expect.element(page.getByRole("link", { name: "Render tables" })).toBeVisible();

    await rerender(hubOf(view({ ledgerVersion: 2 })));
    (await fetch.request(1)).respond({ error: "unavailable" }, 503);
    await expect.element(page.getByText("Couldn't refresh pull requests")).toBeVisible();
    await expect.element(page.getByText("Showing what was loaded before.")).toBeVisible();
    expect(titles()).toEqual(["Add retry to stalled jobs", "Render tables"]);

    await page.getByRole("button", { name: "Try again" }).click();
    (await fetch.request(2)).respond({ rows: ROWS.slice(1), nextCursor: null });
    await expect.element(page.getByText("Couldn't refresh pull requests")).not.toBeInTheDocument();
    expect(titles()).toEqual(["Render tables"]);
  });
});

describe("the PR list's empty states", () => {
  test("no owner in the Hub's view: the onboarding copy", async () => {
    const { fetch } = await list(hubOf(view({ owners: 0 })));
    (await fetch.request(0)).respond({ rows: [], nextCursor: null });
    await expect.element(page.getByRole("heading", { name: "No pull requests yet" })).toBeVisible();
  });

  test("no open pull request of a known owner: the filter's copy, the controls kept", async () => {
    const { fetch } = await list(hubOf(view({ owners: 1 })));
    (await fetch.request(0)).respond({ rows: [], nextCursor: null });
    await expect.element(page.getByRole("heading", { name: "No open pull requests" })).toBeVisible();
    for (const control of controls()) {
      await expect.element(control).toBeInTheDocument();
    }
  });

  test("before the Hub's view, the filter's copy, then the onboarding copy once it counts no owner", async () => {
    const { fetch, rerender } = await list(hubOf(null));
    (await fetch.request(0)).respond({ rows: [], nextCursor: null });
    await expect.element(page.getByRole("heading", { name: "No open pull requests" })).toBeVisible();
    await rerender(hubOf(view({ owners: 0 })));
    await expect.element(page.getByRole("heading", { name: "No pull requests yet" })).toBeVisible();
  });
});

describe("the PR list's repositories", () => {
  test("rows and the menu leave the owner out while there is one, and show it with more", async () => {
    const { fetch, rerender } = await list(hubOf(view({ owners: 1 })));
    (await fetch.request(0)).respond({ rows: ROWS, nextCursor: null });
    await expect.poll(() => firstRepository().element().textContent).toBe("prq");

    await page.getByRole("button", { name: "All repositories" }).click();
    (await fetch.request(1)).respond({ rows: [{ fullName: "shuymn/kopje" }], nextCursor: null });
    await expect.element(page.getByRole("menuitemradio", { name: "kopje" })).toBeVisible();

    await rerender(hubOf(view({ owners: 2 })));
    await expect.poll(() => firstRepository().element().textContent).toBe("shuymn/prq");
  });

  test("opening the menu reads every page of repositories", async () => {
    const { fetch } = await list(hubOf(view({ owners: 2 })));
    (await fetch.request(0)).respond({ rows: ROWS, nextCursor: null });
    await page.getByRole("button", { name: "All repositories" }).click();
    const first = await fetch.request(1);
    expect(path(first)).toBe("/api/repos");
    first.respond({ rows: [{ fullName: "nanaism/yomiyasu" }], nextCursor: "nanaism/yomiyasu" });
    const second = await fetch.request(2);
    expect(path(second)).toBe("/api/repos?cursor=nanaism%2Fyomiyasu");
    second.respond({ rows: [{ fullName: "shuymn/prq" }], nextCursor: null });
    await expect.element(page.getByRole("menuitemradio", { name: "shuymn/prq" })).toBeVisible();
    expect(
      page
        .getByRole("menuitemradio")
        .elements()
        .map((item) => item.textContent),
    ).toEqual(["All repositories", "nanaism/yomiyasu", "shuymn/prq"]);
  });

  test("a failed read shows the load failure in the menu, and Try again reads again", async () => {
    const { fetch } = await list(hubOf(view()));
    (await fetch.request(0)).respond({ rows: ROWS, nextCursor: null });
    await page.getByRole("button", { name: "All repositories" }).click();
    (await fetch.request(1)).fail();
    await expect.element(page.getByText("Couldn't load repositories")).toBeVisible();
    expect(page.getByRole("menuitemradio").elements()).toEqual([]);

    await page.getByRole("button", { name: "Try again" }).click();
    (await fetch.request(2)).respond({ rows: [{ fullName: "shuymn/prq" }], nextCursor: null });
    await expect.element(page.getByRole("menuitemradio", { name: "prq" })).toBeVisible();
  });

  test("an empty read leaves All repositories alone", async () => {
    const { fetch } = await list(hubOf(view()));
    (await fetch.request(0)).respond({ rows: ROWS, nextCursor: null });
    await page.getByRole("button", { name: "All repositories" }).click();
    (await fetch.request(1)).respond({ rows: [], nextCursor: null });
    await expect.element(page.getByRole("menuitemradio", { name: "All repositories" })).toBeVisible();
    expect(page.getByRole("menuitemradio").elements()).toHaveLength(1);
    expect(page.getByText("Couldn't load repositories").elements()).toEqual([]);
  });
});
