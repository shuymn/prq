// Doc check 5, inside workerd: App JWT generation and webhook signature verification with the candidate libraries.
import { env } from "cloudflare:workers";
import { sign, verify } from "@octokit/webhooks-methods";
import { importSPKI, jwtVerify, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";

import { appAuth, appJwt } from "../../src/github/app.ts";

const APP_ID = "123456";

async function verifyAppJwt(token: string) {
  const key = await importSPKI(env.TEST_APP_PUBLIC_KEY, "RS256");
  const { payload } = await jwtVerify(token, key, { issuer: APP_ID, algorithms: ["RS256"] });
  return { payload, header: decodeProtectedHeader(token) };
}

describe("App JWT in workerd", () => {
  // workerd resolves the package's "#crypto" import to its WebCrypto build, which takes PKCS#8 only. GitHub issues App
  // keys as PKCS#1, so the key is converted once before it is stored as a secret:
  //   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.private-key.pem
  it("universal-github-app-jwt rejects the PKCS#1 key GitHub issues", async () => {
    await expect(appJwt(APP_ID, env.TEST_APP_KEY_PKCS1)).rejects.toThrow(/PKCS#1 format, but only PKCS#8 is supported/);
    await expect(appAuth(APP_ID, env.TEST_APP_KEY_PKCS1)({ type: "app" })).rejects.toThrow(/only PKCS#8 is supported/);
  });

  it("universal-github-app-jwt signs a JWT that verifies with the public key (PKCS#8 key)", async () => {
    const token = await appJwt(APP_ID, env.TEST_APP_KEY_PKCS8);
    const { payload, header } = await verifyAppJwt(token);
    expect(header.alg).toBe("RS256");
    const now = Math.floor(Date.now() / 1000);
    // GitHub: iat backdated for clock drift, exp at most 10 minutes ahead.
    expect(payload.iat!).toBeLessThanOrEqual(now);
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(600 + 60);
  });

  it("@octokit/auth-app returns an app JWT that verifies (PKCS#8 key)", async () => {
    const res = await appAuth(APP_ID, env.TEST_APP_KEY_PKCS8)({ type: "app" });
    await verifyAppJwt(res.token);
  });

  it("@octokit/auth-app gets an installation token, authenticating to the API with the App JWT", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const fakeGitHub: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      seen.push({ url: req.url, authorization: req.headers.get("authorization") });
      return Response.json(
        {
          token: "ghs_test_installation_token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { contents: "read", pull_requests: "read" },
          repository_selection: "selected",
        },
        { status: 201 },
      );
    };
    const auth = appAuth(APP_ID, env.TEST_APP_KEY_PKCS8, fakeGitHub);
    const res = await auth({ type: "installation", installationId: 42 });
    expect(res.token).toBe("ghs_test_installation_token");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.github.com/app/installations/42/access_tokens");
    const bearer = seen[0]!.authorization!.replace(/^bearer /i, "");
    await verifyAppJwt(bearer);
    // Cached: a second call does not hit the API.
    await auth({ type: "installation", installationId: 42 });
    expect(seen).toHaveLength(1);
  });
});

describe("webhook signature in workerd", () => {
  // From GitHub's "Validating webhook deliveries" docs.
  const secret = "It's a Secret to Everybody";
  const payload = "Hello, World!";
  const expected = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  it("@octokit/webhooks-methods verifies GitHub's documented test vector", async () => {
    expect(await sign(secret, payload)).toBe(expected);
    expect(await verify(secret, payload, expected)).toBe(true);
  });

  it("@octokit/webhooks-methods rejects a wrong signature, secret or payload", async () => {
    expect(await verify(secret, payload, expected.replace(/.$/, "0"))).toBe(false);
    expect(await verify("other", payload, expected)).toBe(false);
    expect(await verify(secret, `${payload} `, expected)).toBe(false);
    expect(await verify(secret, payload, "sha1=0123")).toBe(false);
  });
});
