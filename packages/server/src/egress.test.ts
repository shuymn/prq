import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitEgress } from "./egress.ts";
import type { GithubClient } from "./github.ts";
import { captureLogs, events } from "./test/access.ts";

const TOKEN = "ghs_installation-token-for-tests";
const INSTALLATION = 7;

type Upstream = {
  url: string;
  method: string;
  authorization: string | null;
  redirect: string | undefined;
  body: string;
};

let upstream: Upstream[];
let tokens: number[];
let reply: () => Response;

beforeEach(() => {
  upstream = [];
  tokens = [];
  reply = () => new Response("served", { status: 200 });
  const github: GithubClient = {
    pullRequest: () => Promise.reject(new Error("not served")),
    appToken: () => Promise.reject(new Error("not served")),
    installationToken: async (installationId) => {
      tokens.push(installationId);
      return TOKEN;
    },
  };
  vi.spyOn(egressSeams(GitEgress.prototype), "github").mockReturnValue(github);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    upstream.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      redirect: init?.redirect,
      body: await request.text(),
    });
    return reply();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// GitEgress's protected seam, through a type guard that fails at once when it is renamed.
type EgressSeams = { github(): GithubClient | undefined };

function hasEgressSeams(instance: object): instance is EgressSeams {
  return typeof Reflect.get(instance, "github") === "function";
}

function egressSeams(instance: object): EgressSeams {
  if (!hasEgressSeams(instance)) {
    throw new TypeError("GitEgress lacks its github seam");
  }
  return instance;
}

// A request from the container, as the Workspace's interception hands it to the egress.
function send(url: string, init: RequestInit = {}): Promise<Response> {
  const egress = exports.GitEgress({ props: { installationId: INSTALLATION } });
  return egress.fetch(new Request(url, init));
}

const BASIC = `Basic ${btoa(`x-access-token:${TOKEN}`)}`;

describe("allowed: a git fetch from github.com", () => {
  it.for([
    "https://github.com/octo/demo.git/info/refs?service=git-upload-pack",
    "https://github.com/octo/demo/info/refs?service=git-upload-pack",
  ])("passes the ref advertisement %s with the installation token", async (url) => {
    captureLogs();
    const res = await send(url, {
      headers: { Authorization: "Basic container-credentials", "Git-Protocol": "version=2" },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("served");
    expect(upstream).toEqual([{ url, method: "GET", authorization: BASIC, redirect: "manual", body: "" }]);
    expect(tokens).toEqual([INSTALLATION]);
  });

  it("passes the fetch itself, its body included", async () => {
    captureLogs();
    const url = "https://github.com/octo/demo.git/git-upload-pack";
    const res = await send(url, { method: "POST", body: "0011command=fetch0000" });

    expect(res.status).toBe(200);
    expect(upstream).toEqual([
      { url, method: "POST", authorization: BASIC, redirect: "manual", body: "0011command=fetch0000" },
    ]);
  });

  it("hands a redirect back to git, never following it; followed, it comes back here and is refused", async () => {
    captureLogs();
    reply = () => new Response(null, { status: 302, headers: { Location: "https://example.com/octo/demo.git" } });
    const url = "https://github.com/octo/demo.git/info/refs?service=git-upload-pack";

    const res = await send(url, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/octo/demo.git");
    expect(upstream).toHaveLength(1);
    expect(upstream[0]?.redirect).toBe("manual");

    // A client that follows it sends the next request to the egress as well.
    const followed = await send(url);
    expect(followed.status).toBe(403);
    expect(upstream).toHaveLength(2);
    expect(upstream.map((request) => request.url)).toEqual([url, url]);
  });
});

describe("URL forms the parser normalizes", () => {
  it.for([
    {
      name: "a host in mixed case on the default port",
      url: "https://GitHub.COM:443/octo/demo.git/info/refs?service=git-upload-pack",
    },
    { name: "dot segments", url: "https://github.com/octo/x/../demo.git/info/refs?service=git-upload-pack" },
  ])("passes $name as the URL it stands for, and fetches only that", async ({ url }) => {
    captureLogs();
    const res = await send(url);

    expect(res.status).toBe(200);
    expect(upstream.map((request) => request.url)).toEqual([
      "https://github.com/octo/demo.git/info/refs?service=git-upload-pack",
    ]);
  });

  // The credentials do not reach the egress (the request it is handed has none); were they there, it would refuse
  // the request (isGitFetch).
  it("passes a URL with credentials in it as the URL without them, with only the installation token", async () => {
    captureLogs();
    const url = new URL("https://github.com/octo/demo.git/info/refs?service=git-upload-pack");
    url.username = "container";
    const res = await send(url.href);

    expect(res.status).toBe(200);
    expect(upstream).toEqual([
      {
        url: "https://github.com/octo/demo.git/info/refs?service=git-upload-pack",
        method: "GET",
        authorization: BASIC,
        redirect: "manual",
        body: "",
      },
    ]);
  });
});

describe("denied: everything else", () => {
  it.for([
    { name: "another host", url: "https://example.com/octo/demo.git/info/refs?service=git-upload-pack" },
    { name: "GitHub's API", url: "https://api.github.com/repos/octo/demo" },
    { name: "plain http", url: "http://github.com/octo/demo.git/info/refs?service=git-upload-pack" },
    { name: "another port", url: "https://github.com:8443/octo/demo.git/info/refs?service=git-upload-pack" },
    { name: "another path", url: "https://github.com/octo/demo/archive/refs/heads/main.zip" },
    { name: "a raw file", url: "https://github.com/octo/demo/raw/main/README.md" },
    { name: "a push's ref advertisement", url: "https://github.com/octo/demo.git/info/refs?service=git-receive-pack" },
    { name: "another query", url: "https://github.com/octo/demo.git/info/refs?service=git-upload-pack&x=1" },
    { name: "a nested path", url: "https://github.com/octo/demo/sub/info/refs?service=git-upload-pack" },
    { name: "port 80 over https", url: "https://github.com:80/octo/demo.git/info/refs?service=git-upload-pack" },
    { name: "an encoded slash", url: "https://github.com/octo%2Fdemo.git/info/refs?service=git-upload-pack" },
    { name: "an encoded segment", url: "https://github.com/octo/demo.git/info/%72efs?service=git-upload-pack" },
    { name: "a trailing slash", url: "https://github.com/octo/demo.git/info/refs/?service=git-upload-pack" },
  ])("refuses $name with 403, reaching no upstream", async ({ url }) => {
    const logs = captureLogs();
    const res = await send(url);

    expect(res.status).toBe(403);
    expect(upstream).toEqual([]);
    expect(tokens).toEqual([]);
    const denied = events(logs, "prq.egress.denied");
    expect(denied).toHaveLength(1);
    // Host, method and path; never the query or a header.
    const { host, pathname } = new URL(url);
    expect(denied[0]).toMatchObject({ host, method: "GET", path: pathname });
    expect(JSON.stringify(denied[0])).not.toContain("?");
  });

  it.for([
    { name: "a push", url: "https://github.com/octo/demo.git/git-receive-pack", method: "POST" },
    { name: "a GET of the fetch endpoint", url: "https://github.com/octo/demo.git/git-upload-pack", method: "GET" },
    {
      name: "a POST of the ref advertisement",
      url: "https://github.com/octo/demo.git/info/refs?service=git-upload-pack",
      method: "POST",
    },
    { name: "a PUT", url: "https://github.com/octo/demo.git/git-upload-pack", method: "PUT" },
  ])("refuses $name with 403, reaching no upstream", async ({ url, method }) => {
    captureLogs();
    const res = await send(url, { method, ...(method === "GET" ? {} : { body: "0000" }) });

    expect(res.status).toBe(403);
    expect(upstream).toEqual([]);
  });

  it("answers 502 when no installation token can be had, reaching no upstream", async () => {
    captureLogs();
    vi.spyOn(egressSeams(GitEgress.prototype), "github").mockReturnValue(undefined);
    const res = await send("https://github.com/octo/demo.git/info/refs?service=git-upload-pack");

    expect(res.status).toBe(502);
    expect(upstream).toEqual([]);
  });
});
