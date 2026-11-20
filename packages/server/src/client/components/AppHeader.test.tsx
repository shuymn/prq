// The AppHeader's brand (design/components.md, AppHeader): the mark, the name and the version link to the PR list, a
// navigation the app's routes handle in the page.

import { afterEach, expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import { useRoute } from "../routes.ts";
import { AppHeader } from "./AppHeader.tsx";

// The header over the route it shows, as the app renders them.
function Routed() {
  const route = useRoute();
  return (
    <>
      <AppHeader version="v0.4.0" />
      <p data-testid="route">{route.name}</p>
    </>
  );
}

const start = location.href;

afterEach(() => {
  history.replaceState(null, "", start);
});

test("the brand leads from a PR detail to the PR list in the page, without loading it again", async () => {
  history.replaceState(null, "", "/pr/shuymn/prq/42");
  // Gone if the click loaded a page.
  const marker = Symbol("page");
  Object.assign(window, { [marker]: true });
  await render(<Routed />);
  await expect.element(page.getByTestId("route")).toHaveTextContent("detail");

  const brand = page.getByRole("link", { name: "prq v0.4.0", exact: true });
  await expect.element(brand).toHaveAttribute("href", "/");
  await brand.click();

  await expect.element(page.getByTestId("route")).toHaveTextContent("list");
  expect(location.pathname).toBe("/");
  expect(marker in window).toBe(true);
});
