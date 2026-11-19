// The gallery against the design (plan P2.11, P2.12): one entry per inventory name and state ID, as far as the UI has
// them; each component entry renders its name's props; each PR list state shows what tells it apart.

import { describe, expect, test } from "vitest";
import { render, type RenderResult } from "vitest-browser-react";
import { page } from "vitest/browser";

import componentsMd from "../../../../../design/components.md?raw";
import { designNames } from "../../../../../design/inventory.mjs";
import screensMd from "../../../../../design/screens.md?raw";
import { ALL_REPOSITORIES } from "../components/RepoMenu.tsx";
import { NotFound } from "../screens/NotFound.tsx";
import { PrList, type ListBody } from "../screens/PrList.tsx";
import { REGISTRY } from "./registry.tsx";

const design = designNames(componentsMd, screensMd);

// What the UI has yet to build, by component and by state ID (plan §4): nothing now. A pending item must name something
// the design has.
const PENDING_COMPONENTS: string[] = [];
const PENDING_STATES: string[] = [];

// States the code has and the design draws no frame for, which the gallery shows for the owner's review beside the
// others (design/components.md): the pool's popover while its read is under way.
const CODE_ONLY_STATES = ["pool.local-reading"];

// Components the design keeps for its own frames, "design-only, not in code" (design/components.md).
const DESIGN_ONLY = ["Note"];

const componentOf = (name: string) => name.split("/")[0] ?? name;

describe("the gallery's registry", () => {
  test("names every inventory name and state ID once, but those pending", () => {
    const names = REGISTRY.map((entry) => entry.name);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    const expected = [
      ...design.inventory.filter((name) => ![...PENDING_COMPONENTS, ...DESIGN_ONLY].includes(componentOf(name))),
      ...design.stateIds.filter((id) => !PENDING_STATES.some((prefix) => id.startsWith(prefix))),
      ...CODE_ONLY_STATES,
    ];
    expect(names.toSorted()).toEqual(expected.toSorted());
    const components = new Set(design.inventory.map(componentOf));
    expect([...PENDING_COMPONENTS, ...DESIGN_ONLY].filter((component) => !components.has(component))).toEqual([]);
    expect(PENDING_STATES.filter((prefix) => !design.stateIds.some((id) => id.startsWith(prefix)))).toEqual([]);
    expect(CODE_ONLY_STATES.filter((id) => design.stateIds.includes(id))).toEqual([]);
  });

  test("renders each component with its name's props", async () => {
    for (const entry of REGISTRY) {
      const [component, ...values] = entry.name.split("/");
      const props = design.props[component ?? ""];
      if (props === undefined) {
        continue;
      }
      const screen = await render(entry.render());
      const root = screen.container.querySelector<HTMLElement>(`[data-component="${component}"]`);
      // A Disclosure's state is its <details> element's own.
      const valueOf = (prop: string) =>
        component === "Disclosure" ? String(root?.querySelector("details")?.open) : root?.dataset[prop];
      expect({ name: entry.name, values: props.map(valueOf) }).toEqual({
        name: entry.name,
        values,
      });
      await screen.unmount();
    }
  });
});

const renderOf = (name: string) => {
  const found = REGISTRY.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`no gallery entry ${name}`);
  }
  return found.render;
};
const entry = (name: string) => renderOf(name)();

const rows = () => page.getByRole("table").getByRole("row");
const statusState = (label: string) =>
  page.getByText(label, { exact: true }).element().closest("[data-component=Status]")?.getAttribute("data-state");

describe("the PR list's states", () => {
  test("list.default, the frame of list.waiting-agent and list.failed: the filters, the header, one row for each problem, the waiting one a wait and the failed one a fault, repositories without their owner", async () => {
    expect(renderOf("list.waiting-agent")).toBe(renderOf("list.default"));
    expect(renderOf("list.failed")).toBe(renderOf("list.default"));
    await render(entry("list.default"));
    await expect.element(page.getByRole("button", { name: "Needs attention · 3" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: ALL_REPOSITORIES })).toBeVisible();
    await expect.element(page.getByRole("radio", { name: "Open" })).toBeChecked();
    expect(
      page
        .getByRole("columnheader")
        .elements()
        .map((cell) => cell.textContent),
    ).toEqual(["Repository", "Pull request", "Status", "Last activity"]);
    expect(rows().elements()).toHaveLength(11);
    for (const problem of [
      "Answer failed",
      "Possibly stalled",
      "Waiting for a local agent",
      "New push not summarized",
    ]) {
      expect({ problem, count: page.getByText(problem, { exact: true }).elements().length }).toEqual({
        problem,
        count: 1,
      });
    }
    expect({ waiting: statusState("Waiting for a local agent"), failed: statusState("Answer failed") }).toEqual({
      waiting: "waiting",
      failed: "failed",
    });
    expect(page.getByText("shuymn/").elements()).toEqual([]);
    const cells = rows().nth(2).getByRole("cell");
    expect(cells.elements().map((cell) => cell.textContent)).toEqual([
      "prq",
      "Add retry to stalled jobs#42",
      "",
      "Answer3 min ago",
    ]);
    // Each row's latest event and how long ago it was, as the frame writes it.
    await expect
      .poll(() =>
        rows()
          .elements()
          .slice(1)
          .map((row) => row.lastElementChild?.textContent),
      )
      .toEqual([
        "Push received2 min ago",
        "Answer3 min ago",
        "Question sent8 min ago",
        "Summary12 min ago",
        "Question sent1 hr ago",
        "Push received2 hr ago",
        "Summary3 hr ago",
        "Answeryesterday",
        "Summary2 days ago",
        "Answer3 days ago",
      ]);
  });

  test("list.all: All chosen, merged and closed pull requests among the open ones", async () => {
    await render(entry("list.all"));
    await expect.element(page.getByRole("radio", { name: "All" })).toBeChecked();
    expect(page.getByRole("img", { name: "Merged" }).elements()).toHaveLength(2);
    expect(page.getByRole("img", { name: "Closed" }).elements()).toHaveLength(1);
    expect(page.getByRole("img", { name: "Open" }).elements()).toHaveLength(10);
  });

  test("list.empty: the onboarding copy in the table's place, no header and no Needs attention", async () => {
    await render(entry("list.empty"));
    await expect.element(page.getByRole("heading", { name: "No pull requests yet" })).toBeVisible();
    await expect
      .element(page.getByText("Pull requests appear when the GitHub App receives a webhook for your own pull request."))
      .toBeVisible();
    expect(page.getByRole("table").elements()).toEqual([]);
    expect(page.getByRole("button", { name: /Needs attention/ }).elements()).toEqual([]);
  });

  test("list.loading: the header and skeleton rows, no Needs attention", async () => {
    await render(entry("list.loading"));
    await expect.element(page.getByRole("columnheader", { name: "Repository" })).toBeVisible();
    await expect.element(page.getByRole("table")).toHaveAttribute("aria-busy", "true");
    expect(document.querySelectorAll(".skeleton-row").length).toBeGreaterThan(0);
    expect(page.getByRole("button", { name: /Needs attention/ }).elements()).toEqual([]);
  });

  test("list.repo-menu: the repository menu open, its trigger expanded, All repositories first and checked, the repositories without their owner", async () => {
    await render(entry("list.repo-menu"));
    await expect.element(page.getByRole("button", { name: ALL_REPOSITORIES })).toHaveAttribute("aria-expanded", "true");
    const items = page.getByRole("menuitemradio");
    await expect.element(items.first()).toBeVisible();
    expect(items.elements()).toHaveLength(25);
    expect(items.elements().filter((item) => item.getAttribute("aria-checked") === "true")).toEqual([
      items.first().element(),
    ]);
    expect(
      items
        .elements()
        .slice(0, 3)
        .map((item) => item.textContent),
    ).toEqual([ALL_REPOSITORIES, "atlas", "beacon"]);
    expect(page.getByText("shuymn/").elements()).toEqual([]);
    expect(rows().elements()).toHaveLength(11);
  });

  test("list.new-version:the version notice with Reload above the list", async () => {
    await render(entry("list.new-version"));
    await expect.element(page.getByText("A new version is available")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(rows().elements()).toHaveLength(11);
  });
});

const poolLabel = () => page.getByRole("button", { name: /local agent|Cloud only|Pool unavailable|Loading pool/ });
const popover = () => document.querySelector<HTMLElement>("[data-component=PoolPopover]");

describe("the agent pool's states", () => {
  test("pool.local: the header's status and its open popover with each agent, the cloud and the jobs in flight", async () => {
    await render(entry("pool.local"));
    await expect.element(poolLabel()).toHaveAttribute("aria-expanded", "true");
    expect(poolLabel().element().textContent).toBe("2 local agents1 running · 2 waiting");
    expect([...(popover()?.querySelectorAll(".agent-id") ?? [])].map((agent) => agent.textContent)).toEqual([
      "mbp-office",
      "mini-home",
    ]);
    expect(textOf("[data-component=PoolPopover] .cloud-row")).toBe("CloudAvailable");
    expect(
      [...document.querySelectorAll("[data-component=PoolPopover] [data-component=Badge]")].map(
        (badge) => badge.textContent,
      ),
    ).toEqual(["2 waiting", "1 running", "1 failed"]);
  });

  test("pool.cloud-only, pool.unavailable, pool.loading and the read under way", async () => {
    const screen = await render(entry("pool.cloud-only"));
    await expect.element(poolLabel()).toHaveAttribute("aria-expanded", "true");
    expect(popover()?.querySelector(".none")?.checkVisibility()).toBe(true);
    await screen.unmount();
    const unavailable = await render(entry("pool.unavailable"));
    await expect.element(poolLabel()).toHaveAttribute("aria-expanded", "true");
    expect(textOf("[data-component=PoolStatus]")).toBe("Pool unavailable");
    expect(popover()?.querySelector("[data-component=Notice]")?.checkVisibility()).toBe(true);
    await unavailable.unmount();
    await render(entry("pool.loading"));
    expect(textOf("[data-component=PoolStatus]")).toBe("Loading pool");
    expect(popover()?.matches(":popover-open")).toBe(false);
    await render(entry("pool.local-reading"));
    await expect.element(page.getByRole("heading", { name: "Local agents" })).toBeVisible();
    expect(popover()?.querySelector(".skeleton")?.getAttribute("aria-busy")).toBe("true");
  });
});

describe("the EmptyStates outside the gallery's states", () => {
  test("a path that is no page", async () => {
    await render(<NotFound />);
    await expect.element(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    await expect.element(page.getByText("There is no page at this address.")).toBeVisible();
    await expect.element(page.getByRole("link", { name: "Go to pull requests" })).toHaveAttribute("href", "/");
  });

  test.each([
    ["open", "No open pull requests", "Choose All to see closed and merged ones."],
    [
      "repo",
      "No pull requests match these filters",
      "Choose another repository, or All to include closed and merged ones.",
    ],
    ["attention", "Nothing needs attention", "Turn off Needs attention to see every pull request."],
  ] as const)("a filter with no rows (%s)", async (reason, title, text) => {
    const body: ListBody = { kind: "empty", reason };
    await render(
      <PrList
        body={body}
        refreshFailed={false}
        needsAttention={1}
        attention={reason === "attention"}
        state="open"
        repoLabel={ALL_REPOSITORIES}
        repo={null}
        repoItems={{ state: "loading" }}
      />,
    );
    await expect.element(page.getByRole("heading", { name: title })).toBeVisible();
    await expect.element(page.getByText(text)).toBeVisible();
  });
});

// The text of the first element a selector finds in the rendered entry.
const textOf = (selector: string) => document.querySelector(selector)?.textContent ?? null;
const visible = async (text: string) => {
  await expect.element(page.getByText(text, { exact: true })).toBeVisible();
};
const details = () => document.querySelector<HTMLDetailsElement>("[data-component=Disclosure] > details");
const none = (name: string) => expect(page.getByRole("button", { name }).elements()).toEqual([]);

const retries = () => page.getByRole("button", { name: "Retry" }).elements();

describe("the PR detail's states", () => {
  // What tells each state apart (plan P3.15, P4.4, P4.6, P4.7).
  const checks: Record<string, (screen: RenderResult) => Promise<void>> = {
    "detail.default": async () => {
      expect(
        [...document.querySelectorAll("[data-component=Message] .question")].map((node) => node.textContent),
      ).toEqual([
        "Why does a retry issue a new claim ID instead of reusing the old one?",
        "Can I retry before the 60-minute stalled mark?",
      ]);
      expect(textOf("[data-component=Summary] .meta")).toBe("deepseek-chat · 12,480 tokens");
      // The rail collapsed to its toggle, no job needing attention.
      const toggle = page.getByRole("button", { name: "Jobs and versions" });
      expect(page.getByRole("complementary").getByRole("button").elements()).toEqual([toggle.element()]);
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle.element().getAttribute("aria-description")).toBeNull();
    },
    "detail.empty": async () => {
      expect(textOf("[data-component=Summary] > [data-component=Status]")).toMatch(
        /^Waiting for a local agent since \d\d:\d\d — continues when it returns$/,
      );
      await visible("No questions yet. Ask about this pull request below.");
    },
    "detail.loading": async () => {
      expect(document.querySelector("[data-component=Summary]")?.getAttribute("aria-busy")).toBe("true");
      expect(document.querySelectorAll(".conversation [data-component=Skeleton]").length).toBeGreaterThan(0);
    },
    "detail.streaming": async () => {
      await visible("Answering");
      expect(textOf("[data-component=Message] .running")).toMatch(/^Answeringcloud · started \d\d:\d\d$/);
      none("Retry");
    },
    "detail.summary-streaming": async () => {
      expect(textOf("[data-component=Summary] .progress")).toBe("Summarizing c4d5e6f");
      await visible(
        "Jobs that an agent claimed but never finished can now be retried from the UI. A retry puts the job back to pending and issues a new claim ID, so a late result from the old claim is dropped.",
      );
    },
    "detail.waiting-agent": async () => {
      expect(textOf("[data-component=Message][data-state=waiting-agent] [data-component=Status]")).toMatch(
        /^Waiting for a local agent since \d\d:\d\d — continues when it returns$/,
      );
      // The composer still takes questions.
      await expect.element(page.getByRole("textbox", { name: "Question" })).not.toHaveAttribute("aria-disabled");
    },
    "detail.running": async () => {
      expect(textOf("[data-component=Summary] .progress")).toBe("Summarizing c4d5e6f");
      expect(textOf("[data-component=JobRow][data-state=running] .meta")).toMatch(
        /^agent-7f3a · running since \d\d:\d\d \(10 min\)$/,
      );
      // A local claim's Retry, in its rail row only.
      expect(retries()).toEqual([document.querySelector("[data-component=JobRow][data-state=running] button")]);
    },
    "detail.queued": async () => {
      await visible("Queued behind the running answer");
      await visible("Answering");
    },
    "detail.stalled": async () => {
      expect(textOf("[data-component=Summary] .progress")).toBe(
        "Summary of e4f5a6b possibly stalled: no result from mbp-office after 1 hrRetry",
      );
      expect(retries()).toHaveLength(1);
      const toggle = page.getByRole("button", { name: "Jobs and versions" });
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
      await expect.element(toggle).toHaveAccessibleDescription("A job needs attention");
      expect(document.querySelector(".rail-toggle .alert")).not.toBeNull();
    },
    "detail.failed": async () => {
      expect(textOf("[data-component=Summary] [data-component=Notice]")).toBe(
        "Summary of d4e5f6a failedThe provider refused the call: spend limit reached. The summary below is for 7a8b9c0.Retry",
      );
      expect(textOf("[data-component=Summary] > .body")).toMatch(/^What changed/);
      await visible("Incomplete — the provider refused the call: spend limit reached");
      expect(
        [...document.querySelectorAll(".rail [data-component=JobRow]")].map((row) => [
          row.getAttribute("data-state"),
          row.querySelector("button")?.textContent ?? null,
        ]),
      ).toEqual([
        ["failed", "Retry"],
        ["failed", "Retry"],
        ["done", null],
        ["done", null],
        ["done", null],
      ]);
      // The notice's, the answer's and the two failed jobs'.
      expect(retries()).toHaveLength(4);
      await visible("3 done");
    },
    "detail.disconnected": async () => {
      await visible("Reconnecting… Showing the last known content.");
      await visible("Reconnecting. You can send once the connection is back.");
    },
    "detail.reconnect-failed": async () => {
      await visible("Can't reconnect. Try reloading the page.");
      await expect.element(page.getByRole("button", { name: "Reload" })).toBeVisible();
      await visible("Disconnected. You can send once the connection is back.");
    },
    "detail.earlier-version": async () => {
      expect(textOf("[data-component=Composer] .context")).toBe("Questions are answered at e4f5a6b (latest)");
      expect(textOf("[data-component=VersionMenu] .trigger code")).toBe("a1b2c3d");
    },
    "detail.send-failed": async () => {
      await visible("Not sent");
      await expect.element(page.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Discard" })).toBeVisible();
      await visible("You can send once the question above is sent or discarded.");
      expect(textOf("[data-component=Notice] .text")).toMatch(/Reloading loses your unsent question\.$/);
    },
    "panel.default": async (screen) => {
      expect(document.querySelector("[data-component=AppHeader]")).toBeNull();
      expect(document.querySelector("[data-component=PoolStatus]")).toBeNull();
      expect(document.querySelector("[data-component=PrHeader]")?.getAttribute("data-density")).toBe("compact");
      expect(textOf("[data-component=Message] .answered-at")).toBe("Answered at e4f5a6b");
      // The summary starts open; closed, it stays closed when the page renders again.
      expect(details()?.open).toBe(true);
      await page.getByText("Summary", { exact: true }).click();
      expect(details()?.open).toBe(false);
      await screen.rerender(entry("panel.default"));
      expect(details()?.open).toBe(false);
    },
    "panel.version-menu": async () => {
      await expect.element(page.getByRole("menuitemradio", { name: /^e4f5a6b/ })).toBeVisible();
      await expect
        .element(page.getByRole("menuitemradio", { name: /^e4f5a6b/ }))
        .toHaveAttribute("aria-checked", "true");
    },
    "panel.streaming": async () => {
      await visible("Answering");
      none("Retry");
    },
    "panel.summary-streaming": async () => {
      await visible("Writing");
      expect(textOf("[data-component=Summary] .meta")).toBe("deepseek-chat");
      expect(textOf("[data-component=Composer] .context")).toBe("Questions are answered at e4f5a6b (latest)");
    },
    "panel.failed": async () => {
      await visible("Incomplete — step limit reached");
      expect(retries()).toHaveLength(1);
      expect(textOf("[data-component=Message][data-state=incomplete] .answered-at")).toBe("Answered at 7a8b9c0");
      expect(document.querySelector("[data-component=Notice]")).toBeNull();
    },
    "panel.disconnected": async () => {
      await visible("Reconnecting… Showing the last known content.");
      await expect.element(page.getByRole("textbox", { name: "Question" })).toHaveAttribute("aria-disabled", "true");
    },
    "panel.reconnect-failed": async () => {
      await visible("Can't reconnect. Try reloading the page.");
      await expect.element(page.getByRole("button", { name: "Reload" })).toBeVisible();
    },
    "panel.new-version": async () => {
      await visible("A new version is available");
      const notice = document.querySelector("[data-component=Notice]");
      const header = document.querySelector("[data-component=PrHeader]");
      expect(
        notice !== null && header !== null && notice.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    },
    "panel.waiting-agent": async () => {
      expect(textOf("[data-component=PoolStatus][data-form=line]")).toBe("Cloud only· 1 waiting");
      expect(document.querySelector("[data-component=Message][data-state=waiting-agent]")).not.toBeNull();
    },
    "panel.unavailable": async () => {
      expect(textOf("[data-component=PoolStatus][data-form=line]")).toBe("Pool unavailable");
    },
    "panel.send-failed": async () => {
      await visible("Couldn't confirm it was sent");
      await expect.element(page.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Discard" })).toBeVisible();
      expect(textOf("[data-component=Notice] .text")).toMatch(/Reloading loses your unsent question\.$/);
    },
  };

  test("each state has a check, and only the states the registry has", () => {
    expect(Object.keys(checks).toSorted()).toEqual(
      REGISTRY.map((candidate) => candidate.name)
        .filter((name) => name.startsWith("detail.") || name.startsWith("panel."))
        .toSorted(),
    );
  });

  test.each(Object.keys(checks))("%s shows what tells it apart", async (name) => {
    const check = checks[name];
    expect(check).toBeDefined();
    await check?.(await render(entry(name)));
  });
});
