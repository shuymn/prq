// The web UI's shell in Chrome against the real Worker in wrangler's local runtime, through the Access stand-in's
// browser door: what each response carries (docs/design.md, Caching), the header's version, an authenticated
// WebSocket handshake, the Content Security Policy in force, and the favicon set.

import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { request } from "node:http";
import { fileURLToPath } from "node:url";

import { sessionName } from "@prq/protocol";
import { describe, expect, test } from "vitest";

import { useBrowser } from "../../test/browser.ts";
import { useStack } from "../../test/stack.ts";

const stack = useStack();
const browser = useBrowser();

const ASSETS_DIR = fileURLToPath(new URL("../../../../server/dist/client/assets", import.meta.url));
const SERVER_VERSION = `v${(await import("../../../../server/package.json", { with: { type: "json" } })).default.version}`;

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; " +
  "require-trusted-types-for 'script'; trusted-types 'none'";
const IMMUTABLE = "public, max-age=31536000, immutable";

// What every static response carries: the shell's revalidation, or an emitted file's year.
const shellHeaders = {
  "cache-control": "no-cache",
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
};

const door = (path: string) => new URL(path, stack.access().door.url).href;

// The header's version text, once the shell has rendered.
async function headerVersion(): Promise<string> {
  const version = browser.page().locator('[data-component="AppHeader"] .version');
  await version.waitFor();
  return version.innerText();
}

describe("the shell", () => {
  test("loads on / and on a client route with no-cache, the CSP and nosniff; its files are immutable", async () => {
    const page = browser.page();
    for (const path of ["/", "/pr/a/b/1"]) {
      const response = await page.goto(door(path));
      expect(response?.status()).toBe(200);
      expect(response?.headers()).toMatchObject({ ...shellHeaders, "content-type": "text/html; charset=utf-8" });
      expect(await headerVersion()).toBe(SERVER_VERSION);
    }
    // The page preloads the font of its first paint, Inter 400 Latin, under its emitted name.
    const preload: unknown = await page.evaluate(`[...document.querySelectorAll('link[rel="preload"]')]
      .map((link) => ({ href: link.getAttribute("href"), as: link.as, type: link.type, crossorigin: link.crossOrigin }))`);
    expect(preload).toEqual([
      {
        href: expect.stringMatching(/^\/assets\/inter-latin-400-normal-[\w-]+\.woff2$/),
        as: "font",
        type: "font/woff2",
        crossorigin: "anonymous",
      },
    ]);
    // The files the page loaded: its script, its stylesheet and the preloaded font, each for a year.
    const loaded = browser
      .recorded()
      .responses.filter((response) => new URL(response.url).pathname.startsWith("/assets/"));
    const paths = loaded.map((response) => new URL(response.url).pathname);
    expect(paths).toContain(await page.locator('link[rel="preload"]').getAttribute("href"));
    expect(paths.map((path) => path.split(".").at(-1))).toEqual(expect.arrayContaining(["css", "js"]));
    for (const response of loaded) {
      expect({ url: response.url, status: response.status, cache: response.headers["cache-control"] }).toEqual({
        url: response.url,
        status: 200,
        cache: IMMUTABLE,
      });
    }
  });

  test("draws the header's mark on whole pixels, at its grid's size", async () => {
    const page = browser.page();
    await page.goto(door("/"));
    await headerVersion();
    const box = await page.locator('[data-component="AppHeader"] [data-component="BrandMark"]').boundingBox();
    expect(box).toEqual({ x: Math.round(box?.x ?? 0.5), y: Math.round(box?.y ?? 0.5), width: 24, height: 16 });
  });

  test("revalidates on a reload: 304", async () => {
    const page = browser.page();
    const first = await page.goto(door("/"));
    const etag = first?.headers()["etag"];
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    await page.reload();
    // Chrome reports the revalidated page as its cached 200; the door saw the Worker's answer.
    const shells = stack.access().door.log.filter((entry) => entry.path === "/");
    expect(shells.map(({ ifNoneMatch, status }) => ({ ifNoneMatch, status }))).toEqual([
      { ifNoneMatch: null, status: 200 },
      { ifNoneMatch: etag, status: 304 },
    ]);
  });

  test("has one URL: /index.html redirects to /", async () => {
    const response = await browser.page().goto(door("/index.html"));
    expect(new URL(response?.url() ?? "").pathname).toBe("/");
    expect(response?.status()).toBe(200);
    const redirect = await response?.request().redirectedFrom()?.response();
    expect(redirect?.status()).toBe(307);
    expect(redirect?.headers()).toMatchObject({ ...shellHeaders, location: "/" });
  });

  test("serves every emitted file for a year, and a file the build did not emit as the shell under no-cache", async () => {
    const client = browser.page().request;
    const emitted = await readdir(ASSETS_DIR);
    expect(emitted.length).toBeGreaterThan(0);
    for (const name of emitted) {
      const response = await client.get(door(`/assets/${name}`));
      expect({ name, status: response.status(), headers: response.headers() }).toMatchObject({
        name,
        status: 200,
        headers: { ...shellHeaders, "cache-control": IMMUTABLE },
      });
    }
    const missing = await client.get(door("/assets/x.js"));
    expect(missing.status()).toBe(200);
    expect(missing.headers()).toMatchObject({ ...shellHeaders, "content-type": "text/html; charset=utf-8" });
    expect(await missing.text()).toContain('<div id="root"></div>');
  });

  test("leaves the Worker's routes to the Worker: no-store JSON, a navigation included", async () => {
    const page = browser.page();
    const fetched = await page.request.get(door("/api/ledger"));
    expect(fetched.status()).toBe(200);
    expect(fetched.headers()).toMatchObject({ "cache-control": "no-store", "content-type": "application/json" });
    const navigated = await page.goto(door("/api/ledger"));
    expect(navigated?.status()).toBe(200);
    expect(navigated?.headers()).toMatchObject({ "cache-control": "no-store", "content-type": "application/json" });
    expect(JSON.parse(await page.locator("body").innerText())).toHaveProperty("rows");
  });
});

describe("the Worker behind the door", () => {
  test("completes the Hub's WebSocket handshake; its prq:version is the header's version", async () => {
    const page = browser.page();
    await page.goto(door("/"));
    const sent: unknown = await page.evaluate(`new Promise((resolve, reject) => {
      const socket = new WebSocket(new URL("/agents/hub/hub", location.href.replace(/^http/, "ws")));
      const timer = setTimeout(() => reject(new Error("no prq:version")), 5000);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "prq:version") {
          clearTimeout(timer);
          socket.close();
          resolve(message.version);
        }
      });
      socket.addEventListener("error", () => reject(new Error("the handshake failed")));
    })`);
    expect(sent).toBe(SERVER_VERSION);
    expect(await headerVersion()).toBe(sent);
  });

  test("without the door's assertion, refuses the API, the history and an upgrade with 401", async () => {
    const worker = stack.worker().url();
    const api = await fetch(new URL("/api/ledger", worker));
    const history = await fetch(
      new URL(`/agents/pr-session/${sessionName({ owner: "a", repo: "b", number: 1 })}/get-messages`, worker),
    );
    const upgrade = await new Promise<number>((resolve, reject) => {
      const req = request(new URL("/agents/hub/hub", worker), {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        },
      });
      req.once("upgrade", (_res, socket) => {
        socket.destroy();
        resolve(101);
      });
      req.once("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.once("error", reject);
      req.end();
    });
    expect([api.status, history.status, upgrade]).toEqual([401, 401, 401]);
  });
});

describe("the Content Security Policy", () => {
  test("the shell breaks none of it; an eval breaks it once", async () => {
    const page = browser.page();
    await page.goto(door("/"));
    await headerVersion();
    expect(browser.recorded().violations).toEqual([]);
    // Trusted Types refuses the string first: a script from no policy ('none' allows none).
    const refused = { directive: "require-trusted-types-for", blocked: "trusted-types-sink", sample: "eval|1" };
    browser.expectViolation(
      (violation) => violation.directive === refused.directive && violation.sample === refused.sample,
    );
    browser.expectConsoleError((message) => message.includes("requires 'TrustedScript' assignment"));
    // From a task of the page's own: DevTools' evaluation itself is exempt from the policy's eval rule.
    const outcome: unknown = await page.evaluate(`new Promise((resolve) => setTimeout(() => {
      try { eval("1"); resolve("ran"); } catch (error) { resolve(error.name); }
    }))`);
    expect(outcome).toBe("EvalError");
    await expect.poll(() => browser.recorded().violations).toEqual([refused]);
  });
});

describe("the favicon set", () => {
  test("is linked and served", async () => {
    const page = browser.page();
    await page.goto(door("/"));
    const links: unknown =
      await page.evaluate(`[...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')]
      .map((link) => ({ rel: link.rel, href: link.getAttribute("href"), type: link.type, sizes: link.sizes.value }))`);
    expect(links).toEqual([
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml", sizes: "" },
      { rel: "icon", href: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png", type: "", sizes: "" },
    ]);
    for (const [path, type] of [
      ["/favicon.svg", "image/svg+xml"],
      ["/favicon-32.png", "image/png"],
      ["/apple-touch-icon.png", "image/png"],
    ] as const) {
      const response = await page.request.get(door(path));
      expect({ path, status: response.status(), headers: response.headers() }).toMatchObject({
        path,
        status: 200,
        headers: { ...shellHeaders, "content-type": type },
      });
    }
  });
});
