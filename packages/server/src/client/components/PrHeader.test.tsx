// The panel's PrHeader (design/screens.md, Extension side panel): a long repository name wraps within the heading
// and never reaches the GitHub link, whose space the back control already narrows.

import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import { PrHeader } from "./PrHeader.tsx";

test("a long repository name stays clear of the GitHub link at the panel's width", async () => {
  await page.viewport(360, 800);
  const screen = await render(
    <PrHeader
      density="compact"
      state="open"
      repository="acme/customerpropertymanagementplatform"
      number={128}
      title="Fix"
      url="https://github.com/acme/customerpropertymanagementplatform/pull/128"
      onBack={() => {}}
    />,
  );
  const repository = screen.container.querySelector(".repository")?.getBoundingClientRect();
  const link = page.getByRole("link", { name: "Open on GitHub" }).element().getBoundingClientRect();
  expect(repository?.right).toBeLessThanOrEqual(link.left);
});
