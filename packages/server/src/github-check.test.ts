import { afterEach, describe, expect, it, vi } from "vitest";

import { checkGithub } from "../scripts/github-report.ts";
import { readGithubAppConfig } from "./config.ts";
import { appEnv, failure, pull, serveGithub, TEST_TOKEN } from "./test/github.ts";
import { sha } from "./test/webhook.ts";

// The manual GitHub App check (scripts/github-check.ts) against the served API: what it reports, and that it never
// prints the key or a token.

afterEach(() => {
  vi.restoreAllMocks();
});

const PR = { owner: "octo", repo: "widgets", number: 9 };
const AT = Date.UTC(2026, 10, 1, 0, 0, 1);

function config() {
  const result = readGithubAppConfig(appEnv());
  if (result?.ok !== true) {
    throw new Error("appEnv() is not a valid configuration");
  }
  return result.config;
}

async function check(): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const ok = await checkGithub(config(), 21, PR, (line) => lines.push(line));
  return { ok, lines };
}

// No line holds the key (any of its lines) or a token.
function expectNoSecret(lines: string[]): void {
  const output = lines.join("\n");
  for (const keyLine of appEnv()
    .GITHUB_APP_PRIVATE_KEY.split("\n")
    .filter((line) => line.length > 20)) {
    expect(output).not.toContain(keyLine);
  }
  expect(output).not.toContain(TEST_TOKEN);
  expect(output).not.toMatch(/gh[opsur]_[A-Za-z0-9]/);
}

describe("check:github", () => {
  it("mints one token for two reads and reports both heads", async () => {
    const api = serveGithub();
    api.reply(pull(sha("A"), AT), pull(sha("A"), AT));

    const { ok, lines } = await check();
    expect(ok).toBe(true);
    expect(lines).toEqual([
      "App 4242, installation 21, octo/widgets#9",
      "  POST /app/installations/21/access_tokens: 201",
      "  GET /repos/octo/widgets/pulls/9: 200",
      expect.stringMatching(
        new RegExp(`^read 1: head ${sha("A")}, updated_at 2026-11-01T00:00:01.000Z \\(\\d+ ms\\)$`),
      ),
      "  GET /repos/octo/widgets/pulls/9: 200",
      expect.stringMatching(/^read 2: head /),
      "token requests: 1 (the second read reuses the first read's token)",
      "as expected",
    ]);
    expectNoSecret(lines);
  });

  it("reports a refused token without the key, the JWT or a token GitHub echoes", async () => {
    const api = serveGithub();
    const key = appEnv().GITHUB_APP_PRIVATE_KEY;
    api.tokenReply(failure(401, `Bad credentials for ghs_echoed0123456789 and ${key}`));

    const { ok, lines } = await check();
    expect(ok).toBe(false);
    expect(lines).toContain("  POST /app/installations/21/access_tokens: 401");
    expect(lines.at(-2)).toMatch(
      /^read 1: failed \(HTTP 401, HttpError: Bad credentials for \[redacted\] and \[redacted\]\)$/,
    );
    expect(lines.at(-1)).toBe("NOT as expected");
    expectNoSecret(lines);
  });

  it("reports a refused token without the App's JWT, which GitHub echoes", async () => {
    const api = serveGithub();
    const jwt = () =>
      api
        .tokens()
        .at(-1)
        ?.authorization?.replace(/^bearer /, "") ?? "";
    api.tokenReply(async () => failure(401, `Bad credentials for ${jwt()}`)(undefined));

    const { ok, lines } = await check();
    expect(ok).toBe(false);
    expect(jwt()).toMatch(/^eyJ/);
    expect(lines.at(-2)).toBe("read 1: failed (HTTP 401, HttpError: Bad credentials for [redacted])");
    expect(lines.join("\n")).not.toContain(jwt());
  });
});
