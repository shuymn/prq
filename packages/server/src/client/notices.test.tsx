// Which notice about the build the page shows (plan P2.8): the version notice whenever the server's version differs,
// the asset notice only without it.

import { describe, expect, test } from "vitest";
import { render, renderHook } from "vitest-browser-react";
import { page } from "vitest/browser";

import { BuildNotice, useAssetFailed } from "./notices.tsx";

const VERSION_TITLE = "A new version is available";
const ASSET_TITLE = "Couldn't load part of this page.";
const notices = () => document.querySelectorAll("[data-component=Notice]");

describe("the build's notice", () => {
  test("none while the server runs this build and every asset loaded", async () => {
    await render(<BuildNotice serverVersions={[__PRQ_VERSION__]} assetFailed={false} />);
    expect(notices()).toHaveLength(0);
  });

  test("the asset notice for a failed asset alone", async () => {
    await render(<BuildNotice serverVersions={[__PRQ_VERSION__]} assetFailed />);
    await expect.element(page.getByText(ASSET_TITLE)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(notices()).toHaveLength(1);
  });

  test("only the version notice for another server version, with or without a failed asset", async () => {
    for (const assetFailed of [false, true]) {
      const screen = await render(<BuildNotice serverVersions={["v999.0.0"]} assetFailed={assetFailed} />);
      await expect.element(page.getByText(VERSION_TITLE)).toBeVisible();
      expect(page.getByText(ASSET_TITLE).elements()).toEqual([]);
      expect(notices()).toHaveLength(1);
      await screen.unmount();
    }
  });

  test("an asset counts as failed once Vite reports a failed preload", async () => {
    const { result } = await renderHook(() => useAssetFailed());
    expect(result.current).toBe(false);
    window.dispatchEvent(new Event("vite:preloadError"));
    await expect.poll(() => result.current).toBe(true);
  });
});
