// The old bundle's build: its files carry the prefix and its version, and every ending removes its directory.

import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { buildOldBundle, OLD_VERSION } from "./old-bundle.ts";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// A stand-in build that records its directory and process ID, then runs this script.
async function standIn(script: string) {
  const record = await mkdtemp(join(tmpdir(), "prq-old-bundle-test-"));
  scratch.push(record);
  const seen = { dir: "", pid: 0 };
  const command = (outDir: string) => {
    seen.dir = outDir;
    return {
      file: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(join(record, "pid"))}, String(process.pid)); ${script}`,
      ],
    };
  };
  const pid = async () => Number(await readFile(join(record, "pid"), "utf8"));
  return { seen, command, pid };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the old bundle", () => {
  test("is the web UI under the old version, every emitted file prefixed; close() removes it", async () => {
    const bundle = await buildOldBundle();
    scratch.push(bundle.dir);
    const assets = await readdir(join(bundle.dir, "assets"));
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.filter((name) => !name.startsWith("old-"))).toEqual([]);
    const index = await readFile(join(bundle.dir, "index.html"), "utf8");
    expect(index).toMatch(/src="\/assets\/old-index-[\w-]+\.js"/);
    const scripts = await Promise.all(
      assets.filter((name) => name.endsWith(".js")).map((name) => readFile(join(bundle.dir, "assets", name), "utf8")),
    );
    expect(scripts.some((script) => script.includes(OLD_VERSION))).toBe(true);
    await bundle.close();
    expect(existsSync(bundle.dir)).toBe(false);
  }, 120_000);

  test("a failed build removes its directory", async () => {
    const build = await standIn("process.exit(3)");
    await expect(buildOldBundle({ command: build.command })).rejects.toThrow("the old bundle's build failed (3)");
    expect(build.seen.dir).not.toBe("");
    expect(existsSync(build.seen.dir)).toBe(false);
  });

  test("a build past the bound is killed and its directory removed; one inside it completes", async () => {
    const slow = await standIn("setTimeout(() => {}, 60_000)");
    await expect(buildOldBundle({ timeoutMs: 1000, command: slow.command })).rejects.toThrow(
      "the old bundle's build was killed after 1000 ms",
    );
    expect(alive(await slow.pid())).toBe(false);
    expect(existsSync(slow.seen.dir)).toBe(false);

    const inTime = await standIn("setTimeout(() => {}, 500)");
    const bundle = await buildOldBundle({ timeoutMs: 1000, command: inTime.command });
    scratch.push(bundle.dir);
    expect(existsSync(bundle.dir)).toBe(true);
    await bundle.close();
  });

  test("a build its caller cancels is killed and its directory removed", async () => {
    const slow = await standIn("setTimeout(() => {}, 60_000)");
    const cancel = new AbortController();
    const built = buildOldBundle({ command: slow.command, signal: cancel.signal });
    let pid: number;
    try {
      pid = await vi.waitFor(slow.pid);
    } finally {
      cancel.abort();
      await built.catch(() => {});
    }
    await expect(built).rejects.toThrow("the old bundle's build was cancelled");
    expect(alive(pid)).toBe(false);
    expect(existsSync(slow.seen.dir)).toBe(false);
  });

  test("a command that cannot be made removes its directory", async () => {
    let seen = "";
    const command = (outDir: string): never => {
      seen = outDir;
      scratch.push(outDir);
      throw new Error("no Vite");
    };
    await expect(buildOldBundle({ command })).rejects.toThrow("no Vite");
    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false);
  });
});
