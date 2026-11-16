// Access tokens and a stubbed key set endpoint. The Worker runs in the tests' isolate, so a fetch spy serves its key
// set requests; nothing reaches the network.
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, importJWK, type JWK, type JWTPayload, SignJWT } from "jose";
import { vi } from "vitest";

export type SigningKey = { kid: string; privateKey: CryptoKey; publicJwk: JWK };

// The run's key, made in vitest.config.ts, so every test file serves the same keys for the configured team domain.
export async function runKey(): Promise<SigningKey> {
  const binding: unknown = Reflect.get(env, "TEST_ACCESS_JWK");
  if (typeof binding !== "string") {
    throw new TypeError("TEST_ACCESS_JWK is not set (vitest.config.ts)");
  }
  const jwk: JWK = JSON.parse(binding);
  const privateKey = await importJWK(jwk, "RS256");
  if (!(privateKey instanceof CryptoKey) || jwk.n === undefined || jwk.e === undefined) {
    throw new TypeError("TEST_ACCESS_JWK is not an RSA private key");
  }
  return { kid: "run-key", privateKey, publicJwk: { kty: "RSA", n: jwk.n, e: jwk.e } };
}

export async function newKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  return { kid, privateKey, publicJwk: await exportJWK(publicKey) };
}

// A team domain no other test uses, so the isolate's key set for it starts empty.
export function freshTeamDomain(): string {
  return `https://${crypto.randomUUID()}.prq.example`;
}

export function envFor(teamDomain: string): Env {
  return { ...env, ACCESS_TEAM_DOMAIN: teamDomain };
}

// A token as Access issues it for the configured application; claims override it, and those in `without` are left out.
export async function accessToken(
  key: SigningKey,
  claims: JWTPayload = {},
  without: readonly string[] = [],
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = { iss: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, iat: now, exp: now + 300, ...claims };
  for (const claim of without) {
    delete payload[claim];
  }
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: key.kid }).sign(key.privateKey);
}

export function request(path: string, token?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token !== undefined) {
    headers.set("Cf-Access-Jwt-Assertion", token);
  }
  return new Request(new URL(path, "https://prq.example"), { ...init, headers });
}

type KeyResponse = (signal: AbortSignal | undefined) => Promise<Response>;

export type KeyServer = {
  // Key set fetches made since the stub was installed.
  fetches(): number;
  serve(...keys: SigningKey[]): void;
  // The next fetches answer with `response` until serve is called again.
  fail(response: KeyResponse): void;
};

// Serves `teamDomain`'s key set through a fetch spy; any other fetch fails the request that made it.
export function serveKeys(teamDomain: string, ...keys: SigningKey[]): KeyServer {
  const certs = `${teamDomain}/cdn-cgi/access/certs`;
  let fetches = 0;
  let respond: KeyResponse;
  const server: KeyServer = {
    fetches: () => fetches,
    serve(...served) {
      const body = { keys: served.map((key) => ({ ...key.publicJwk, kid: key.kid, alg: "RS256", use: "sig" })) };
      respond = async () => Response.json(body);
    },
    fail(response) {
      respond = response;
    },
  };
  server.serve(...keys);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new Request(input).url;
    if (url !== certs) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    fetches += 1;
    return respond(init?.signal ?? undefined);
  });
  return server;
}

// Key set answers that are not a usable key set.
export const keyFailures: Record<string, KeyResponse> = {
  "a network error": async () => {
    throw new TypeError("Network connection lost.");
  },
  "a 500": async () => new Response("unavailable", { status: 500 }),
  "a body that is not JSON": async () => new Response("<html>", { status: 200 }),
  "a malformed key set": async () => Response.json({ keys: "none" }),
};

// A fetch that settles only when its signal aborts it, as jose's timeout does.
export const hangingKeyFetch: KeyResponse = (signal) =>
  new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });

export type LogEntry = { level: "log" | "warn" | "error"; entry: Record<string, unknown> };

// Captures console output as log.ts writes it.
export function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((entry: Record<string, unknown>) => {
      entries.push({ level, entry });
    });
  }
  return entries;
}
