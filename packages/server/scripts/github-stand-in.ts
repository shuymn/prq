// A stand-in for GitHub in the setup's tests: its REST API under /api (the manifest conversion, the App's own reads with
// its token, an installation's repositories), its web pages under /web (the manifest form's target, which redirects as
// GitHub does), and the programs the setup runs in place of gh and of the browser's opener, which ask this server what
// to answer. The opener plays the browser: on the setup's form it posts the manifest and follows (or keeps, for the
// test to paste) the redirect; on the App's installation page it installs the App as the test set. Every secret it hands
// out is a sentinel no output may hold.

import { generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import { decodeJwt, jwtVerify } from "jose";
import * as v from "valibot";

type Account = { login: string; id: number };
type Repository = { full_name: string; private: boolean };
type StandInApp = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  owner: Account;
  createdAt: string;
  publicKey: KeyObject;
  permissions: Record<string, string>;
  events: string[];
  hookUrl: string | null;
};
type Installation = { id: number; appId: number; account: Account; repositories: Repository[] };

export type GitHub = {
  // gh's account, and the one the browser is logged in as.
  user: Account;
  browserAccount: Account;
  apps: StandInApp[];
  installations: Installation[];
  // What the browser does on the setup's form: follow the redirect, keep it for the test to paste, call back with a
  // wrong state first, or nothing.
  browser: "follow" | "paste" | "wrong-state" | "none";
  // A name the owner types over the manifest's on GitHub's page.
  rename: string | null;
  // Whether the conversion answers a webhook secret, and the status it answers (201 unless set).
  webhookSecret: boolean;
  conversionStatus: number;
  // What the installation page installs when opened: the repositories, or nothing.
  installOnOpen: Repository[] | null;
  // An ID GET /app answers in place of the App's own, how long the opener takes to return, and whether the browser
  // is done with the setup's form before it returns.
  appIdOverride: number | null;
  openDelayMs: number;
  browseBeforeReturn: boolean;
  // What happened: gh's and the opener's argument lists, the manifests posted, the callback statuses, the redirect
  // for a paste, and the conversions.
  ghCalls: string[][];
  opened: string[];
  manifests: unknown[];
  callbacks: number[];
  redirect: string | null;
  conversions: number;
  // Every secret handed out or seen: keys' lines, codes, states, client and webhook secrets, installation tokens.
  sentinels: string[];
};

const keyLines = (pem: string) => pem.split("\n").filter((line) => line !== "" && !line.startsWith("-----"));

export function rsaKey(): { pkcs1: string; pkcs8: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    pkcs1: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

function sentinel(kind: string): string {
  return `sentinel-${kind}-${randomBytes(8).toString("hex")}`;
}

function freshGitHub(): GitHub {
  return {
    user: { login: "octo-host", id: 7340021 },
    browserAccount: { login: "octo-host", id: 7340021 },
    apps: [],
    installations: [],
    browser: "follow",
    rename: null,
    webhookSecret: true,
    conversionStatus: 201,
    installOnOpen: [
      { full_name: "octo-host/work", private: false },
      { full_name: "octo-host/prq-test", private: true },
    ],
    appIdOverride: null,
    openDelayMs: 0,
    browseBeforeReturn: false,
    ghCalls: [],
    opened: [],
    manifests: [],
    callbacks: [],
    redirect: null,
    conversions: 0,
    sentinels: [],
  };
}

function appJson(app: StandInApp): Record<string, unknown> {
  return {
    id: app.id,
    slug: app.slug,
    node_id: `A_${app.id}`,
    client_id: `Iv1.${app.id}`,
    owner: { ...app.owner, type: "User" },
    name: app.name,
    description: app.description,
    external_url: "https://example.invalid",
    html_url: `https://github.invalid/apps/${app.slug}`,
    created_at: app.createdAt,
    updated_at: app.createdAt,
    permissions: app.permissions,
    events: app.events,
  };
}

// The manifest as the stand-in reads it, and gh's or the opener's arguments.
const Manifest = v.object({
  name: v.string(),
  description: v.optional(v.string()),
  default_permissions: v.record(v.string(), v.string()),
  default_events: v.array(v.string()),
  hook_attributes: v.object({ url: v.string() }),
  redirect_url: v.string(),
});
const Args = v.array(v.string());

// A program that asks this server, at the origin in its environment, what to answer: gh's output and exit code; the
// opener's nothing.
function program(path: string): string {
  return [
    `#!${process.execPath}`,
    `const response = await fetch(process.env.PRQ_GITHUB_STAND_IN + "${path}", { method: "POST", body: JSON.stringify(process.argv.slice(2)) });`,
    path === "/gh"
      ? "const { code, stdout, stderr } = await response.json(); process.stdout.write(stdout); process.stderr.write(stderr); process.exitCode = code;"
      : "",
  ].join("\n");
}

function unescapeHtml(text: string): string {
  return text.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

async function body(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
  }
  return text;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

export type StandIn = {
  origin: string;
  state: () => GitHub;
  reset: () => void;
  // An App the test made, with its key; installed on the user's account when repositories are given.
  addApp: (app: Partial<StandInApp> & { id: number; name: string }, repositories?: Repository[]) => StandInApp;
  deleteApp: (slug: string) => void;
  // Writes the gh and opener programs into a directory: their paths.
  programs: (directory: string) => Promise<{ gh: string; open: string }>;
  // Waits for the browser's work an opener started.
  settled: () => Promise<void>;
  close: () => Promise<void>;
};

export async function startGitHub(): Promise<StandIn> {
  let github = freshGitHub();
  let nextId = 1000;
  const codes = new Map<string, StandInApp>();
  const tokens = new Map<string, Installation>();
  const work: Promise<unknown>[] = [];
  let origin = "";

  const appOf = async (request: IncomingMessage): Promise<StandInApp | null> => {
    const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    try {
      const app = github.apps.find((each) => String(each.id) === String(decodeJwt(token).iss));
      if (app === undefined) {
        return null;
      }
      await jwtVerify(token, app.publicKey, { algorithms: ["RS256"] });
      return app;
    } catch {
      return null;
    }
  };

  const createApp = (manifest: v.InferOutput<typeof Manifest>): StandInApp => {
    const name = github.rename ?? manifest.name;
    const app: StandInApp = {
      id: nextId++,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name,
      description: manifest.description ?? null,
      owner: github.browserAccount,
      createdAt: new Date().toISOString(),
      publicKey: rsaKey().publicKey,
      permissions: { ...manifest.default_permissions },
      events: [...manifest.default_events],
      hookUrl: manifest.hook_attributes.url,
    };
    github.apps.push(app);
    return app;
  };

  // The browser on the setup's form page: the manifest posted to the form's target, as GitHub's page would on Create.
  const browse = async (url: string): Promise<void> => {
    const page = await (await fetch(url)).text();
    const action = unescapeHtml(/action="([^"]*)"/.exec(page)?.[1] ?? "");
    const manifest = unescapeHtml(/name="manifest" value="([^"]*)"/.exec(page)?.[1] ?? "");
    github.sentinels.push(new URL(action).searchParams.get("state") ?? "");
    const posted = await fetch(action, {
      method: "POST",
      body: new URLSearchParams({ manifest }),
      redirect: "manual",
    });
    const location = posted.headers.get("location");
    if (location === null) {
      return;
    }
    github.redirect = location;
    if (github.browser === "wrong-state") {
      const wrong = new URL(location);
      wrong.searchParams.set("state", "0".repeat(64));
      github.callbacks.push((await fetch(wrong)).status);
    }
    if (github.browser === "follow" || github.browser === "wrong-state") {
      github.callbacks.push((await fetch(location)).status);
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", origin);
    const route = `${request.method ?? ""} ${url.pathname}`;
    if (route === "POST /gh") {
      const args = v.parse(Args, JSON.parse(await body(request)));
      github.ghCalls.push(args);
      if (args[0] === "api" && args[1] === "user") {
        json(response, 200, { code: 0, stdout: JSON.stringify(github.user), stderr: "" });
        return;
      }
      const slug = /^apps\/(.+)$/.exec(args[1] ?? "")?.[1];
      if (args[0] === "api" && slug !== undefined) {
        const app = github.apps.find((each) => each.slug === slug);
        json(
          response,
          200,
          app === undefined
            ? { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" }
            : { code: 0, stdout: JSON.stringify(appJson(app)), stderr: "" },
        );
        return;
      }
      json(response, 200, { code: 1, stdout: "", stderr: "unknown command\n" });
      return;
    }
    if (route === "POST /open") {
      const [target = ""] = v.parse(Args, JSON.parse(await body(request)));
      github.opened.push(target);
      await new Promise((resolve) => setTimeout(resolve, github.openDelayMs));
      if (target.startsWith("http://127.0.0.1:") && github.browser !== "none") {
        const browsing = browse(target).catch(() => {});
        work.push(browsing);
        if (github.browseBeforeReturn) {
          await browsing;
        }
      }
      response.writeHead(200).end();
      const installing = /\/web\/apps\/([^/]+)\/installations\/new$/.exec(target)?.[1];
      const app = github.apps.find((each) => each.slug === installing);
      if (app !== undefined && github.installOnOpen !== null) {
        github.installations.push({
          id: nextId++,
          appId: app.id,
          account: github.browserAccount,
          repositories: github.installOnOpen,
        });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/web/settings/apps/new") {
      const posted: unknown = JSON.parse(new URLSearchParams(await body(request)).get("manifest") ?? "{}");
      github.manifests.push(posted);
      const manifest = v.parse(Manifest, posted);
      const app = createApp(manifest);
      const code = randomBytes(20).toString("hex");
      github.sentinels.push(code);
      codes.set(code, app);
      const redirect = new URL(manifest.redirect_url);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: redirect.toString() }).end();
      return;
    }
    const conversion = /^\/api\/app-manifests\/([^/]+)\/conversions$/.exec(url.pathname)?.[1];
    if (request.method === "POST" && conversion !== undefined) {
      github.conversions += 1;
      const app = codes.get(conversion);
      if (app === undefined || github.conversionStatus !== 201) {
        json(response, app === undefined ? 404 : github.conversionStatus, { message: "Not Found" });
        return;
      }
      codes.delete(conversion);
      const key = rsaKey();
      app.publicKey = key.publicKey;
      const clientSecret = sentinel("client-secret");
      const webhookSecret = github.webhookSecret ? sentinel("webhook-secret") : null;
      github.sentinels.push(...keyLines(key.pkcs1), ...keyLines(key.pkcs8), clientSecret);
      if (webhookSecret !== null) {
        github.sentinels.push(webhookSecret);
      }
      json(response, 201, {
        ...appJson(app),
        client_secret: clientSecret,
        webhook_secret: webhookSecret,
        pem: key.pkcs1,
      });
      return;
    }
    if (url.pathname === "/api/installation/repositories") {
      const installation = tokens.get((request.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (installation === undefined) {
        json(response, 401, { message: "Bad credentials" });
        return;
      }
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const page = Number(url.searchParams.get("page") ?? "1");
      json(response, 200, {
        total_count: installation.repositories.length,
        repositories: installation.repositories.slice((page - 1) * perPage, page * perPage),
      });
      return;
    }
    if (url.pathname.startsWith("/api/app")) {
      const app = await appOf(request);
      if (app === null) {
        json(response, 401, { message: "A JSON web token could not be decoded" });
        return;
      }
      const installed = github.installations.filter((each) => each.appId === app.id);
      if (route === "GET /api/app") {
        json(response, 200, { ...appJson(app), id: github.appIdOverride ?? app.id });
        return;
      }
      if (route === "GET /api/app/installations") {
        const perPage = Number(url.searchParams.get("per_page") ?? "30");
        const page = Number(url.searchParams.get("page") ?? "1");
        json(
          response,
          200,
          installed.slice((page - 1) * perPage, page * perPage).map((each) => ({ id: each.id, account: each.account })),
        );
        return;
      }
      const tokenFor = /^\/api\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname)?.[1];
      const installation = installed.find((each) => String(each.id) === tokenFor);
      if (request.method === "POST" && installation !== undefined) {
        const token = sentinel("installation-token");
        github.sentinels.push(token);
        tokens.set(token, installation);
        json(response, 201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
        return;
      }
      if (route === "GET /api/app/hook/config") {
        json(response, 200, { url: app.hookUrl, content_type: "form", insecure_ssl: "0", secret: "********" });
        return;
      }
    }
    json(response, 404, { message: "Not Found" });
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  return {
    origin,
    state: () => github,
    reset: () => {
      github = freshGitHub();
      codes.clear();
      tokens.clear();
    },
    addApp: (partial, repositories) => {
      const app: StandInApp = {
        slug: partial.name.toLowerCase(),
        owner: github.user,
        description: null,
        createdAt: new Date(Date.now() - 86_400_000).toISOString(),
        permissions: { contents: "read", issues: "read", metadata: "read", pull_requests: "read" },
        events: [],
        hookUrl: null,
        ...partial,
        publicKey: partial.publicKey ?? rsaKey().publicKey,
      };
      github.apps.push(app);
      if (repositories !== undefined) {
        github.installations.push({ id: nextId++, appId: app.id, account: app.owner, repositories });
      }
      return app;
    },
    deleteApp: (slug) => {
      github.apps = github.apps.filter((each) => each.slug !== slug);
    },
    programs: async (directory) => {
      const gh = join(directory, "gh.mjs");
      const open = join(directory, "open.mjs");
      await writeFile(gh, program("/gh"));
      await writeFile(open, program("/open"));
      await chmod(gh, 0o755);
      await chmod(open, 0o755);
      return { gh, open };
    },
    settled: async () => {
      await Promise.all(work.splice(0));
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
