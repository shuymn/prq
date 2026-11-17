import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { checkReconcile, type GithubApp } from "./reconcile.ts";

// The manual reconcile check (reconcile-check.ts) against GitHub's API served from this process: the Worker's outbound
// requests reach this process's globalThis.fetch, which answers GitHub's API here; any other GitHub request fails.

const PR = { owner: "acme", repo: "widgets", number: 7 };
const INSTALLATION = 4321;
const TOKEN = "ghs_servedInstallationToken0123456789";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const UPDATED_AT = "2026-11-02T03:04:05Z";

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
});

async function app(): Promise<GithubApp> {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return {
    settings: { GITHUB_APP_ID: "4242", GITHUB_APP_PRIVATE_KEY: await exportPKCS8(privateKey) },
    installationId: INSTALLATION,
  };
}

// Answers GitHub's API: the installation token and the pull request (or the given reply); other requests go on as
// before.
function serveGithub(pull: () => Response): { paths: string[]; authorizations: string[] } {
  const paths: string[] = [];
  const authorizations: string[] = [];
  const before = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.github.com") {
      return before(input, init);
    }
    paths.push(`${request.method} ${url.pathname}`);
    authorizations.push(request.headers.get("authorization") ?? "");
    if (request.method === "POST" && url.pathname === `/app/installations/${INSTALLATION}/access_tokens`) {
      return Response.json({ token: TOKEN, expires_at: "2099-01-01T00:00:00Z" }, { status: 201 });
    }
    if (request.method === "GET" && url.pathname === `/repos/${PR.owner}/${PR.repo}/pulls/${PR.number}`) {
      return pull();
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
  return { paths, authorizations };
}

describe("reconcile check", () => {
  it("ends the tied session at GitHub's head, read with one token", { timeout: 60_000 }, async () => {
    const github = serveGithub(() => Response.json({ head: { sha: HEAD }, updated_at: UPDATED_AT }));
    const lines: string[] = [];

    const ok = await checkReconcile(await app(), PR, (line) => lines.push(line));

    const report = lines.join("\n");
    expect(report).toContain(`  POST /app/installations/${INSTALLATION}/access_tokens: 201`);
    expect(report).toContain(`  GET /repos/acme/widgets/pulls/7: 200`);
    expect(report).toContain(`GitHub's answer: head ${HEAD}, updated_at ${UPDATED_AT}`);
    expect(report).toContain(`session: head ${HEAD}, head_at ${UPDATED_AT}, mark none, tries 0`);
    expect(report).toMatch(/prq\.head\.reconciled/);
    expect(report).toContain("token requests: 1");
    expect(ok).toBe(true);
    expect(github.paths).toEqual([
      `POST /app/installations/${INSTALLATION}/access_tokens`,
      "GET /repos/acme/widgets/pulls/7",
    ]);
    // The token request carries the App's JWT, the read the token; the report shows neither.
    expect(github.authorizations[0]).toMatch(/^bearer eyJ/);
    expect(github.authorizations[1]).toBe(`token ${TOKEN}`);
    expect(report).not.toContain(TOKEN);
    expect(report).not.toMatch(/eyJ/);
  });

  it("fails when GitHub refuses the read, and says so", { timeout: 60_000 }, async () => {
    serveGithub(() => Response.json({ message: "Not Found" }, { status: 404 }));
    const lines: string[] = [];

    const ok = await checkReconcile(await app(), PR, (line) => lines.push(line));

    const report = lines.join("\n");
    expect(report).toContain(`  GET /repos/acme/widgets/pulls/7: 404`);
    expect(report).toContain("GitHub's answer: none");
    expect(report).toMatch(/prq\.head\.reconcile_failed/);
    expect(report).toContain("NOT as expected");
    expect(ok).toBe(false);
  });
});
