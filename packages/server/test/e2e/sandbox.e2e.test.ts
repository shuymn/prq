// Doc check 4, locally: wrangler dev runs the Workspace Container with Docker. Needs Docker and github.com access, so
// it runs only with `pnpm test:sandbox`. The times are local (Docker on this machine), not production numbers.
import { afterAll, beforeAll, expect, it } from "vitest";

import { startDev, type Dev } from "./support.ts";

const REPO = "octocat/Hello-World";
const HEAD = "b3cbd5bbd7e81436d2eee04537ea2b4c0cad4cdf"; // "Create CONTRIBUTING.md" (branch test)
const BASE = "553c2077f0edc3d5dc5d17262f6aa498e69d6f8e"; // "first commit", two commits below HEAD

let dev: Dev;
beforeAll(async () => {
  dev = await startDev({}, { config: "wrangler.sandbox.jsonc" });
}, 300_000);
afterAll(async () => {
  await post("stop").catch(() => {});
  await dev?.stop();
});

async function post(action: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${dev.url}/ws/spike-1/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${action}: ${res.status} ${text}`);
  return action === "read" ? text : JSON.parse(text);
}

it("rebuilds the same commit from empty after a stop, and runs grep and read in it", { timeout: 300_000 }, async () => {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const r = await post("prepare", { repo: REPO, headSha: HEAD, baseSha: BASE });
    expect(r.head).toBe(HEAD);
    expect(r.mergeBase).toBe(BASE);
    // Fetched at depth 1, then deepened once because the base is not the head's parent.
    expect(r.deepenSteps).toBe(1);
    expect(r.leftover).toBe(false);
    expect(r.coldStartMs).not.toBeNull();
    runs.push(r);

    const grep = await post("grep", { pattern: "Contributing" });
    expect(grep.stdout).toBe("CONTRIBUTING.md:1:## Contributing\n");
    const read = await fetch(`${dev.url}/ws/spike-1/read?path=CONTRIBUTING.md`).then((x) => x.text());
    expect(read.startsWith("## Contributing")).toBe(true);
    await post("stop");
    expect(((await fetch(`${dev.url}/ws/spike-1/running`).then((x) => x.json())) as { running: boolean }).running).toBe(false);
  }
  console.log("sandbox timings (local Docker):", JSON.stringify(runs.map(({ coldStartMs, fetchCheckoutMs, rebuildMs }) => ({ coldStartMs, fetchCheckoutMs, rebuildMs }))));
});

it("lets git reach only this repo on github.com through the Worker", { timeout: 120_000 }, async () => {
  await post("prepare", { repo: REPO, headSha: HEAD, baseSha: HEAD });
  const otherRepo = await post("probe", { url: "https://github.com/cloudflare/sandbox-sdk.git" });
  expect(otherRepo.exitCode).not.toBe(0);
  expect(otherRepo.stderr).toContain("denied: https://github.com/cloudflare/sandbox-sdk.git");
  const otherHost = await post("probe", { url: "https://gitlab.com/gitlab-org/gitlab.git" });
  expect(otherHost.stderr).toContain("denied: https://gitlab.com/");
  const plainHttp = await post("probe", { url: "http://github.com/octocat/Hello-World.git" });
  expect(plainHttp.stderr).toContain("denied: http://github.com/");
  const same = await post("probe", { url: `https://github.com/${REPO}.git` });
  expect(same.exitCode).toBe(0);
  expect(same.stdout).toContain("refs/heads/master");
});
