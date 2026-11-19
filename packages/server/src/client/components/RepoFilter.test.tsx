// The repository menu's focus (plan P2.10, design/components.md): a keyboard open enters the menu, a pointer open
// leaves focus on the button.

import { describe, expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

import { ALL_REPOSITORIES, RepoFilter, type RepoItems } from "./RepoFilter.tsx";

const ITEMS: RepoItems = {
  state: "ready",
  repos: [
    { value: "shuymn/kopje", label: "kopje" },
    { value: "shuymn/prq", label: "prq" },
  ],
};

const trigger = () => page.getByRole("button", { name: ALL_REPOSITORIES });
const item = (name: string) => page.getByRole("menuitemradio", { name });
const menuOpen = () => document.querySelector(".menu")?.matches(":popover-open") ?? false;

describe("the repository menu", () => {
  test("opened by keyboard, focuses its first item; the arrows move; Escape closes it and returns focus", async () => {
    await render(<RepoFilter label={ALL_REPOSITORIES} selected={null} items={ITEMS} />);
    trigger().element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(item(ALL_REPOSITORIES)).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(item("kopje")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(item("prq")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(item("kopje")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(menuOpen()).toBe(false);
    await expect.element(trigger()).toHaveFocus();
  });

  test("opened by pointer, leaves focus on its button", async () => {
    await render(<RepoFilter label={ALL_REPOSITORIES} selected={null} items={ITEMS} />);
    await trigger().click();
    await expect.element(item(ALL_REPOSITORIES)).toBeVisible();
    expect(menuOpen()).toBe(true);
    await expect.element(trigger()).toHaveFocus();
  });
});
