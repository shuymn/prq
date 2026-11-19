// An agent's Markdown (plan P3.11): raw HTML, images and links other than absolute http(s) URLs render no element of
// their own and no unsafe or relative link; a valid https link is followed in a new tab; inline code stays inline.

import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import { Markdown } from "./Markdown.tsx";

const TEXT = `<b>bold</b> <img src="https://example.com/x.png" onerror="alert(1)"> <script>alert(1)</script>

![a diagram](https://example.com/diagram.png) ![a local one](/local.png) ![a plain one](http://example.com/plain.png)

[run](javascript:alert(1)) [relative](/pr/shuymn/prq/1) [mail](mailto:host@example.com) [docs](https://example.com/docs)

Call \`retry()\` first.`;

test("renders an agent's Markdown with no element or link of its own making (P3.11)", async () => {
  const screen = await render(<Markdown text={TEXT} />);
  const root = screen.container.querySelector("[data-component=Markdown]");
  expect(root?.querySelectorAll("b, img, script, iframe, [onerror]")).toHaveLength(0);
  await expect
    .element(page.getByText('<b>bold</b> <img src="https://example.com/x.png"', { exact: false }))
    .toBeVisible();

  const links = [...(root?.querySelectorAll("a") ?? [])].map((link) => ({
    text: link.textContent,
    href: link.getAttribute("href"),
    target: link.getAttribute("target"),
    rel: link.getAttribute("rel"),
  }));
  expect(links).toEqual([
    { text: "a diagram", href: "https://example.com/diagram.png", target: "_blank", rel: "noreferrer" },
    { text: "docs", href: "https://example.com/docs", target: "_blank", rel: "noreferrer" },
  ]);
  for (const text of ["a local one", "a plain one", "run", "relative", "mail"]) {
    await expect.element(page.getByText(text, { exact: true })).toBeVisible();
  }

  const code = root?.querySelector("p > code");
  expect(code?.textContent).toBe("retry()");
  expect(root?.querySelector("pre")).toBeNull();
});
