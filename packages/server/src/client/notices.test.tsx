// Which notice about the build the page shows (plan P2.8): the version notice whenever the server's version differs,
// the asset notice only without it, and only for a part of the page that failed to load; a part that failed as it
// rendered shows its own notice in its place.

import { lazy, Suspense } from "react";
import { describe, expect, test } from "vitest";
import { render, renderHook } from "vitest-browser-react";
import { page } from "vitest/browser";

import { PromptEditor } from "./components/PromptEditor.tsx";
import { BuildNotice, ChunkBoundary, chunkFailed, ShowFailed, useAssetFailed } from "./notices.tsx";

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
    expect(result.current[0]).toBe(false);
    window.dispatchEvent(new Event("vite:preloadError"));
    await expect.poll(() => result.current[0]).toBe(true);
  });
});

describe("a lazily loaded part's boundary", () => {
  test("a part whose module could not load shows the fallback and reports a failed asset", async () => {
    let reported = 0;
    const Part = lazy(() =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module")).catch(chunkFailed),
    );
    await render(
      <ChunkBoundary onError={() => (reported += 1)} fallback={<p>The fallback</p>} failed={<ShowFailed unsent />}>
        <Suspense fallback={null}>
          <Part />
        </Suspense>
      </ChunkBoundary>,
    );
    await expect.element(page.getByText("The fallback")).toBeVisible();
    expect(reported).toBe(1);
  });

  test("an error as a loaded part renders (a date past the clock's range) shows its own notice there, reports no failed asset, and leaves the rest of the page (LOW 2)", async () => {
    let reported = 0;
    await render(
      <>
        <p>The header</p>
        <ChunkBoundary onError={() => (reported += 1)} fallback={<p>The fallback</p>} failed={<ShowFailed unsent />}>
          <PromptEditor
            title="Analysis prompt"
            purpose=""
            placeholder=""
            value=""
            status="saved"
            savedAt={8_640_000_000_000_001}
          />
        </ChunkBoundary>
      </>,
    );
    await expect.element(page.getByText("Couldn't show settings")).toBeVisible();
    await expect
      .element(page.getByText("Reload the page to try again. Reloading loses your unsent question."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect.element(page.getByText("The header")).toBeVisible();
    expect([reported, page.getByText("The fallback").elements()]).toEqual([0, []]);
  });
});
