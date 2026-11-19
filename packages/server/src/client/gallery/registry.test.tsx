// The gallery against the design (plan P2.11, P2.12): one entry per inventory name and state ID, as far as the UI has
// them; each component entry renders its name's props; each PR list state shows what tells it apart.

import { describe, expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import componentsMd from "../../../../../design/components.md?raw";
import { designNames } from "../../../../../design/inventory.mjs";
import screensMd from "../../../../../design/screens.md?raw";
import { ALL_REPOSITORIES } from "../components/RepoFilter.tsx";
import { NotFound } from "../screens/NotFound.tsx";
import { PrList, type ListBody } from "../screens/PrList.tsx";
import { REGISTRY } from "./registry.tsx";

const design = designNames(componentsMd, screensMd);

// What the UI has yet to build, by component and by state ID prefix (plan §4: the detail and the connection banner in
// PR 3 and 4, the pool's button and popover in PR 5, the settings in PR 5 and 6). A pending item must name something
// the design has.
const PENDING_COMPONENTS = [
  "ConnectionBanner",
  "PoolStatus",
  "PoolPopover",
  "Disclosure",
  "PrHeader",
  "CodeBlock",
  "Markdown",
  "Summary",
  "VersionItem",
  "VersionMenu",
  "JobRow",
  "Message",
  "Composer",
  "TextField",
  "TextArea",
  "PromptEditor",
  "SkillRow",
  "SkillRegisterForm",
  "SkillReview",
  "Dialog",
];
const PENDING_STATES = ["detail.", "pool.", "settings.", "panel."];

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
    ];
    expect(names.toSorted()).toEqual(expected.toSorted());
    const components = new Set(design.inventory.map(componentOf));
    expect([...PENDING_COMPONENTS, ...DESIGN_ONLY].filter((component) => !components.has(component))).toEqual([]);
    expect(PENDING_STATES.filter((prefix) => !design.stateIds.some((id) => id.startsWith(prefix)))).toEqual([]);
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
      expect({ name: entry.name, values: props.map((prop) => root?.dataset[prop]) }).toEqual({
        name: entry.name,
        values,
      });
      await screen.unmount();
    }
  });
});

const entry = (name: string) => {
  const found = REGISTRY.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`no gallery entry ${name}`);
  }
  return found.render();
};

const rows = () => page.getByRole("table").getByRole("row");

describe("the PR list's states", () => {
  test("list.default: the filters, the header and one row for each problem, repositories without their owner", async () => {
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
    expect(page.getByText("shuymn/").elements()).toEqual([]);
    const cells = rows().nth(2).getByRole("cell");
    expect(cells.elements().map((cell) => cell.textContent)).toEqual([
      "prq",
      "Add retry to stalled jobs#42",
      "",
      "Answer3 min. ago",
    ]);
  });

  test("list.waiting-agent: the waiting row as a wait, not a fault", async () => {
    await render(entry("list.waiting-agent"));
    const status = page.getByText("Waiting for a local agent");
    await expect.element(status).toBeVisible();
    expect(status.element().closest("[data-component=Status]")?.getAttribute("data-state")).toBe("waiting");
  });

  test("list.failed: the failed row says what failed, as a fault", async () => {
    await render(entry("list.failed"));
    const status = page.getByText("Answer failed");
    await expect.element(status).toBeVisible();
    expect(status.element().closest("[data-component=Status]")?.getAttribute("data-state")).toBe("failed");
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

  test("list.new-version: the version notice with Reload above the list", async () => {
    await render(entry("list.new-version"));
    await expect.element(page.getByText("A new version is available")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(rows().elements()).toHaveLength(11);
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
