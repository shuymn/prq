// The real Worker (packages/server/wrangler.jsonc) in a local runtime through wrangler's test harness, with the secrets
// it reads passed in. Its fetch of Access's key set is served here: the harness sends the Worker's outbound requests to
// this process's globalThis.fetch, which a wrapper answers for the key set URL and passes on for anything else, its
// response decoded once.
// The harness also loads packages/server/.dev.vars, which may hold a model provider's or the GitHub App's settings for a
// manual check: the Worker gets a model or the App only when the caller passes one, so the tests never reach a provider
// or GitHub.

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { createTestHarness, experimental_readRawConfig } from "wrangler";

// .example never resolves, so a key set fetch the wrapper does not answer cannot reach the network.
const TEAM_DOMAIN = "https://team.prq.example";
const AUDIENCE = "prq-test-audience";
const KEY_ID = "test-key";
export const WEBHOOK_SECRET = "prq-test-webhook-secret";
export const HOST_ID = 1001;

const CERTS_URL = `${TEAM_DOMAIN}/cdn-cgi/access/certs`;
const SERVER_DIR = fileURLToPath(new URL("../../../server", import.meta.url));

type Stub = Record<string, (...args: unknown[]) => Promise<unknown>>;
type Namespace = { getByName(name: string): Stub };

export type Worker = {
  // The Worker's current origin; reset() changes it.
  url(): string;
  // The version the Worker sends in Prq-Version.
  version: string;
  // Fresh storage and a fresh runtime (Access's key set no longer cached), before each test.
  reset(): Promise<void>;
  close(): Promise<void>;
  // A token as Access issues it for the application, signed by the key the key set serves; expired one an hour ago.
  token(options?: { expired?: boolean }): Promise<string>;
  // Fetches of the key set since the last reset; failKeys(n) answers the next n with 500.
  keyFetches(): number;
  failKeys(times: number): void;
  // A Durable Object of the Worker by name, its RPC methods called from here.
  durableObject(binding: "Hub" | "PrSession", name: string): Promise<Stub>;
  // SQL in a Durable Object's storage, for test setup.
  sql(className: "Hub" | "PrSession", name: string, query: string, ...bindings: unknown[]): Promise<unknown[]>;
  // The Worker's log lines since it started or was last reset.
  logs(): string[];
  // The bodies of the requests the Worker sent to the model provider (MODEL_BASE_URL) since it started or was last
  // reset, in order, for the checks that read what the model was given. Their headers, which hold the API key, are
  // not kept, and no check prints a body.
  modelRequests(): readonly string[];
};

// The content codings Node's fetch decodes. Their responses arrive decoded with the content-encoding header kept, and
// the harness hands them to the Worker as they are, so workerd would decode the body again and fail (a Brotli stream:
// "Brotli decompression failed."). At this Node-to-workerd boundary, a body Node decoded is passed on without the
// header, so it is decoded once; a response without a body is passed on unchanged.
const DECODED_CODINGS = new Set(["gzip", "x-gzip", "deflate", "br", "zstd"]);

function decodedOnce(response: Response): Response {
  if (response.body === null) {
    return response;
  }
  const codings = (response.headers.get("content-encoding") ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "");
  if (codings.length === 0 || !codings.every((coding) => DECODED_CODINGS.has(coding))) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// The cloud agent's model settings (packages/server/src/env.d.ts).
export type ModelSettings = Record<"MODEL_BASE_URL" | "MODEL_API_KEY" | "MODEL_ID" | "MODEL_CONTEXT_TOKENS", string>;

// Empty settings override any the harness loaded from .dev.vars: the Worker reads them as no model configured.
const NO_MODEL: ModelSettings = { MODEL_BASE_URL: "", MODEL_API_KEY: "", MODEL_ID: "", MODEL_CONTEXT_TOKENS: "" };

// The GitHub App's settings (packages/server/src/env.d.ts).
export type GithubAppSettings = Record<"GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY", string>;

// Likewise no GitHub App, so no test reaches GitHub through credentials in .dev.vars.
const NO_GITHUB_APP: GithubAppSettings = { GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY: "" };

// The Worker as the harness runs it: from wrangler.jsonc with the secrets, or, with containers, from the same config
// with `dev.enable_containers` turned on. The harness reads that setting only from the config, and takes no secrets
// for an inline one, so they become its vars.
function workerInput(secrets: Record<string, string>, containers: boolean) {
  if (!containers) {
    return { configPath: "./wrangler.jsonc", secrets };
  }
  const { rawConfig } = experimental_readRawConfig({ config: join(SERVER_DIR, "wrangler.jsonc") });
  const { env: _environments, ...config } = rawConfig;
  return {
    config: { ...config, dev: { ...config.dev, enable_containers: true }, vars: { ...config.vars, ...secrets } },
  };
}

// containers: the Workspace runs its container in Docker (the manual workspace check only; tests run without Docker).
export async function startWorker({
  model = NO_MODEL,
  githubApp = NO_GITHUB_APP,
  containers = false,
}: { model?: ModelSettings; githubApp?: GithubAppSettings; containers?: boolean } = {}): Promise<Worker> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: "RS256", use: "sig" };
  let fetches = 0;
  let failures = 0;
  const recorded: string[] = [];
  const passThrough = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (model.MODEL_BASE_URL !== "" && url.startsWith(model.MODEL_BASE_URL)) {
      const request = new Request(input, init);
      recorded.push(await request.clone().text());
      return decodedOnce(await passThrough(request));
    }
    if (url !== CERTS_URL) {
      return decodedOnce(await passThrough(input, init));
    }
    fetches += 1;
    if (failures > 0) {
      failures -= 1;
      return new Response("unavailable", { status: 500 });
    }
    return Response.json({ keys: [jwk] });
  };

  const harness = createTestHarness({
    root: SERVER_DIR,
    workers: [
      workerInput(
        {
          ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
          ACCESS_AUD: AUDIENCE,
          WEBHOOK_SECRET,
          HOST_GITHUB_ID: String(HOST_ID),
          ...githubApp,
          ...model,
        },
        containers,
      ),
    ],
  });
  let url: string;
  try {
    url = (await harness.listen()).url.origin;
  } catch (error) {
    globalThis.fetch = passThrough;
    throw error;
  }
  // Every /cli/* response carries the server's version, a refused one included.
  const version = (await passThrough(new URL("/cli/claim", url), { method: "POST" })).headers.get("Prq-Version");
  if (version === null) {
    throw new Error("the Worker sent no Prq-Version");
  }

  const worker = harness.getWorker();
  return {
    url: () => url,
    version,
    async reset() {
      await harness.reset();
      url = (await harness.listen()).url.origin;
      fetches = 0;
      failures = 0;
      recorded.length = 0;
    },
    async close() {
      globalThis.fetch = passThrough;
      await harness.close();
    },
    token: ({ expired = false } = {}) => {
      const now = Math.floor(Date.now() / 1000);
      const exp = expired ? now - 3600 : now + 300;
      return new SignJWT({ iss: TEAM_DOMAIN, aud: AUDIENCE, iat: exp - 300, exp })
        .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
        .sign(privateKey);
    },
    keyFetches: () => fetches,
    failKeys(times) {
      failures = times;
    },
    async durableObject(binding, name) {
      const env: Record<string, Namespace> = await worker.getEnv();
      const namespace = env[binding];
      if (namespace === undefined) {
        throw new Error(`no binding ${binding}`);
      }
      const stub = namespace.getByName(name);
      // As the Agents SDK's getAgentByName does: the instance knows its name and has started.
      await stub["__unsafe_ensureInitialized"]?.();
      return stub;
    },
    async sql(className, name, query, ...bindings) {
      const storage = await worker.getDurableObjectStorage(className, { name });
      return storage.exec(query, ...bindings);
    },
    logs: () => harness.getLogs().map((entry) => entry.message),
    modelRequests: () => recorded,
  };
}
