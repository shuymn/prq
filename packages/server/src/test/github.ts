// GitHub's API for the GitHub App's calls: a globalThis.fetch spy answers the installation token request, the pull
// request reads with what a test queues, and the reads a skill's registration makes from an in-memory model of
// repositories (refs, commits and their trees, blobs) and of the App's installations. It records each request with its
// signal, and a test can answer any request itself first (intercept). Any other GitHub URL fails the request; other
// fetches keep the implementation installed before. Sessions read the App's configuration from env, which a test sets
// on the live instance; routes take it with the env they are called with.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";

import type { PrSession } from "../pr-session/index.ts";

const API = "https://api.github.com";

// The App as a test configures it: its ID and the run's PKCS#8 key (vitest.config.ts).
export function appEnv(): { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: string } {
  const key: unknown = Reflect.get(env, "TEST_GITHUB_APP_KEY");
  if (typeof key !== "string") {
    throw new TypeError("TEST_GITHUB_APP_KEY is not set (vitest.config.ts)");
  }
  return { GITHUB_APP_ID: "4242", GITHUB_APP_PRIVATE_KEY: key };
}

// The start of every installation token the served API mints.
export const TEST_TOKEN = "installation-token-for-tests";

// The token the served API mints for an installation.
export function tokenFor(installationId: number): string {
  return `${TEST_TOKEN}-${installationId}`;
}

// The session reads the App's configuration from now on. The instance keeps it until it is reset.
export async function useGithubApp(stub: DurableObjectStub<PrSession>): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    Reflect.set(instance, "env", { ...env, ...appEnv() });
  });
}

export type GithubReply = (signal: AbortSignal | undefined) => Promise<Response>;

export type GithubRequest = {
  method: string;
  // The path as sent (percent-encoded), and the query.
  path: string;
  search: string;
  authorization: string | null;
  accept: string | null;
  signal: AbortSignal | undefined;
};

// A file of a fake commit: its bytes (a string as UTF-8) and git mode; a symlink's bytes are its target, a submodule's
// are ignored. size, when given, is what the tree lists in place of the bytes' length.
export type FakeFile =
  | string
  | Uint8Array
  | { bytes: string | Uint8Array; mode: "100644" | "100755" | "120000" | "160000"; size?: number };

type Entry = { mode: string; bytes: Uint8Array; size: number; sha: string };

export type FakeRepository = {
  // Branch and tag names to commit SHAs; a tag in `annotated` is served as an annotated tag (its own object).
  readonly heads: Map<string, string>;
  readonly tags: Map<string, string>;
  readonly annotated: Set<string>;
  // Whether trees are served as truncated.
  truncated: boolean;
  // A commit of the files (path → file); its SHA.
  commit(files: Record<string, FakeFile>): Promise<string>;
  // The blob SHA of the file at path in the commit.
  blobOf(commit: string, path: string): string;
  // The SHA of the tree object of a directory of the commit, which the trees endpoint reads as GitHub does.
  treeOf(commit: string, dir: string): Promise<string>;
};

// A reply a test gives to the requests that match, before the model is consulted; serve() is the model's answer.
export type Intercept = (request: GithubRequest, serve: () => Promise<Response>) => Promise<Response>;

export type GithubApi = {
  // Every request served, in order.
  readonly requests: GithubRequest[];
  // The token requests and the pull request reads among them.
  tokens(): GithubRequest[];
  reads(): GithubRequest[];
  // Replies for the next pull request reads, in order.
  reply(...replies: GithubReply[]): void;
  // The reply to token requests from now on (a minted token unless set).
  tokenReply(reply: GithubReply): void;
  // A repository of the model, created empty on first use.
  repository(owner: string, repo: string): FakeRepository;
  // The App's installations, in the order its list gives them, and the repositories it is installed on.
  installations(list: { id: number; suspended?: boolean }[]): void;
  install(owner: string, repo: string, id: number): void;
  // Answers the next `times` requests that match with `reply` (every one when times is omitted).
  intercept(match: (request: GithubRequest) => boolean, reply: Intercept, times?: number): void;
};

// A pull request as GitHub answers it: its head and the time of the state the answer shows.
export function pull(headSha: string, updatedAt: number): GithubReply {
  const body = {
    number: 1,
    head: { sha: headSha },
    updated_at: new Date(updatedAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  return async () => Response.json(body);
}

export function failure(status: number, message = "failure"): GithubReply {
  return async () => Response.json({ message }, { status });
}

// A reply that settles only when its signal aborts it.
export const hanging: GithubReply = (signal) =>
  new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });

function minted(installationId: number): GithubReply {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  return async () =>
    Response.json(
      {
        token: tokenFor(installationId),
        expires_at: expiresAt,
        permissions: { pull_requests: "read" },
        repository_selection: "all",
      },
      { status: 201 },
    );
}

const utf8 = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A blob's git ID, computed as git does: SHA-1 of "blob <size>\0" and the bytes.
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = utf8.encode(`blob ${bytes.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + bytes.byteLength);
  object.set(header);
  object.set(bytes, header.byteLength);
  return hex(await crypto.subtle.digest("SHA-1", object));
}

function bytesOf(file: FakeFile): { bytes: Uint8Array; mode: string; size?: number } {
  if (typeof file === "string") {
    return { bytes: utf8.encode(file), mode: "100644" };
  }
  if (file instanceof Uint8Array) {
    return { bytes: file, mode: "100644" };
  }
  const bytes = typeof file.bytes === "string" ? utf8.encode(file.bytes) : file.bytes;
  return { bytes, mode: file.mode, ...(file.size === undefined ? {} : { size: file.size }) };
}

// Whether GitHub serves the raw blob as text: UTF-8 without a NUL.
function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) {
    return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function notFound(): Response {
  return Response.json({ message: "Not Found" }, { status: 404 });
}

type Repository = FakeRepository & {
  trees: Map<string, Map<string, Entry>>;
  // Tree object SHAs to the commit and directory they list.
  treeObjects: Map<string, { commit: string; dir: string }>;
};

function createRepository(): Repository {
  const trees = new Map<string, Map<string, Entry>>();
  const treeObjects = new Map<string, { commit: string; dir: string }>();
  let commits = 0;
  return {
    heads: new Map(),
    tags: new Map(),
    annotated: new Set(),
    truncated: false,
    trees,
    treeObjects,
    async commit(files) {
      const tree = new Map<string, Entry>();
      for (const [path, file] of Object.entries(files)) {
        const { bytes, mode, size = bytes.byteLength } = bytesOf(file);
        tree.set(path, { mode, bytes, size, sha: mode === "160000" ? "a".repeat(40) : await gitBlobSha(bytes) });
      }
      commits += 1;
      const sha = hex(
        await crypto.subtle.digest(
          "SHA-1",
          utf8.encode(JSON.stringify([commits, ...[...tree].map(([p, e]) => [p, e.sha])])),
        ),
      );
      trees.set(sha, tree);
      return sha;
    },
    blobOf(commit, path) {
      const entry = trees.get(commit)?.get(path);
      if (entry === undefined) {
        throw new Error(`no ${path} in ${commit}`);
      }
      return entry.sha;
    },
    async treeOf(commit, dir) {
      const sha = hex(await crypto.subtle.digest("SHA-1", utf8.encode(`tree ${commit}:${dir}`)));
      treeObjects.set(sha, { commit, dir });
      return sha;
    },
  };
}

// The tree GitHub answers for a directory of a commit (recursive): every entry under it, directories included, with
// paths relative to it. null when the directory holds nothing.
function subtree(tree: Map<string, Entry>, dir: string, truncated: boolean) {
  const prefix = dir === "" ? "" : `${dir}/`;
  const entries: Record<string, unknown>[] = [];
  const dirs = new Set<string>();
  for (const [path, entry] of tree) {
    if (!path.startsWith(prefix)) {
      continue;
    }
    const relative = path.slice(prefix.length);
    const parts = relative.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      dirs.add(parts.slice(0, depth).join("/"));
    }
    const type = entry.mode === "160000" ? "commit" : "blob";
    entries.push({
      path: relative,
      mode: entry.mode,
      type,
      sha: entry.sha,
      ...(type === "blob" ? { size: entry.size } : {}),
    });
  }
  if (entries.length === 0) {
    return null;
  }
  for (const path of dirs) {
    entries.push({ path, mode: "040000", type: "tree", sha: "b".repeat(40) });
  }
  return { sha: "c".repeat(40), tree: entries, truncated };
}

const TOKEN_PATH = /^\/app\/installations\/[0-9]+\/access_tokens$/;
const PULL_PATH = /^\/repos\/[^/]+\/[^/]+\/pulls\/[0-9]+$/;
const REPO_PATH = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/;

export function serveGithub(): GithubApi {
  const requests: GithubRequest[] = [];
  const replies: GithubReply[] = [];
  let tokenReply: GithubReply | undefined;
  const repositories = new Map<string, Repository>();
  let installations: { id: number; suspended?: boolean }[] = [];
  const installed = new Map<string, number>();
  const intercepts: { match: (request: GithubRequest) => boolean; reply: Intercept; times: number }[] = [];

  // The installation whose token reads a repository: the App's on it, else the first active one.
  const selected = (owner: string, repo: string) =>
    installed.get(`${owner}/${repo}`.toLowerCase()) ??
    installations.find((installation) => !installation.suspended)?.id;

  const repositoryOf = (owner: string, repo: string) => {
    const key = `${owner}/${repo}`.toLowerCase();
    let repository = repositories.get(key);
    if (repository === undefined) {
      repository = createRepository();
      repositories.set(key, repository);
    }
    return repository;
  };

  // The model's answer to a repository's read. The installation lookup takes the App's JWT; every other read takes the
  // token of the installation selected for the repository, and an empty repository answers 409 as GitHub's does.
  const serveRepository = (owner: string, repo: string, rest: string, request: GithubRequest): Response => {
    if (rest === "installation") {
      const id = installed.get(`${owner}/${repo}`.toLowerCase());
      return id === undefined ? notFound() : Response.json({ id });
    }
    const installation = selected(owner, repo);
    if (installation === undefined || request.authorization !== `token ${tokenFor(installation)}`) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    const repository = repositories.get(`${owner}/${repo}`.toLowerCase());
    if (repository === undefined) {
      return notFound();
    }
    if (repository.trees.size === 0) {
      return Response.json({ message: "Git Repository is empty." }, { status: 409 });
    }
    const segments = rest.split("/").map(decodeURIComponent);
    const [area, kind, ...name] = segments;
    if (area === "git" && kind === "matching-refs") {
      const [refKind, ...prefixParts] = name;
      const prefix = prefixParts.join("/");
      const refs = refKind === "heads" ? repository.heads : refKind === "tags" ? repository.tags : null;
      if (refs === null) {
        return notFound();
      }
      return Response.json(
        [...refs]
          .filter(([ref]) => ref.startsWith(prefix))
          .map(([ref, sha]) => ({
            ref: `refs/${refKind}/${ref}`,
            object: {
              sha,
              type: refKind === "tags" && repository.annotated.has(ref) ? "tag" : "commit",
            },
          })),
      );
    }
    if (area === "commits" && kind === "refs") {
      const [refKind, ...nameParts] = name;
      const refs = refKind === "heads" ? repository.heads : refKind === "tags" ? repository.tags : null;
      const sha = refs?.get(nameParts.join("/"));
      return sha === undefined
        ? Response.json({ message: `No commit found for SHA: ${nameParts.join("/")}` }, { status: 422 })
        : new Response(sha, { headers: { "content-type": "application/vnd.github.sha; charset=utf-8" } });
    }
    if (area === "git" && kind === "commits" && name.length === 1) {
      const [sha = ""] = name;
      return repository.trees.has(sha) ? Response.json({ sha, tree: { sha: "d".repeat(40) } }) : notFound();
    }
    if (area === "git" && kind === "trees") {
      const treeish = rest.slice("git/trees/".length);
      const colon = treeish.indexOf(":");
      const commit = colon === -1 ? treeish : treeish.slice(0, colon);
      const dir =
        colon === -1
          ? ""
          : treeish
              .slice(colon + 1)
              .split("/")
              .map(decodeURIComponent)
              .join("/");
      // A tree-ish names a commit, or a branch or tag as GitHub resolves it, or a tree object, which lists its
      // directory.
      const object = repository.treeObjects.get(commit);
      const tree =
        repository.trees.get(object?.commit ?? commit) ??
        repository.trees.get(repository.heads.get(commit) ?? repository.tags.get(commit) ?? "");
      const within = object === undefined ? dir : [object.dir, dir].filter((part) => part !== "").join("/");
      const listed = tree === undefined ? null : subtree(tree, within, repository.truncated);
      return listed === null ? notFound() : Response.json(listed);
    }
    if (area === "git" && kind === "blobs" && name.length === 1) {
      for (const tree of repository.trees.values()) {
        for (const entry of tree.values()) {
          if (entry.sha === name[0]) {
            // The bytes for the raw media type only; any other gets GitHub's JSON, the content in base64.
            if (request.accept !== "application/vnd.github.raw") {
              const content = btoa(Array.from(entry.bytes, (byte) => String.fromCodePoint(byte)).join(""));
              return Response.json({ sha: entry.sha, size: entry.bytes.byteLength, content, encoding: "base64" });
            }
            const type = isText(entry.bytes) ? "text/plain; charset=utf-8" : "application/octet-stream";
            return new Response(entry.bytes, { headers: { "content-type": type } });
          }
        }
      }
      return notFound();
    }
    return notFound();
  };

  const spy = vi.isMockFunction(globalThis.fetch) ? vi.mocked(globalThis.fetch) : vi.spyOn(globalThis, "fetch");
  const earlier = spy.getMockImplementation();
  spy.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== API) {
      if (earlier === undefined) {
        throw new Error(`unexpected fetch: ${request.url}`);
      }
      return earlier(input, init);
    }
    const signal = init?.signal ?? undefined;
    const served: GithubRequest = {
      method: request.method,
      path: url.pathname,
      search: url.search,
      authorization: request.headers.get("authorization"),
      accept: request.headers.get("accept"),
      signal,
    };
    if (request.method === "POST" && TOKEN_PATH.test(url.pathname)) {
      requests.push(served);
      return (tokenReply ?? minted(Number(/[0-9]+/.exec(url.pathname)?.[0])))(signal);
    }
    if (request.method === "GET" && PULL_PATH.test(url.pathname)) {
      requests.push(served);
      const reply = replies.shift();
      if (reply === undefined) {
        throw new Error("no reply left for this pull request read");
      }
      return reply(signal);
    }
    const repoPath = REPO_PATH.exec(url.pathname);
    let serve: (() => Promise<Response>) | null = null;
    if (request.method === "GET" && url.pathname === "/app/installations") {
      serve = async () =>
        Response.json(
          installations.map(({ id, suspended }) => ({ id, suspended_at: suspended ? "2026-01-01T00:00:00Z" : null })),
        );
    } else if (request.method === "GET" && repoPath !== null) {
      const [, owner = "", repo = "", rest = ""] = repoPath;
      serve = async () => serveRepository(owner, repo, rest, served);
    }
    if (serve === null) {
      throw new Error(`unexpected GitHub request: ${request.method} ${request.url}`);
    }
    requests.push(served);
    const intercept = intercepts.find((candidate) => candidate.times > 0 && candidate.match(served));
    if (intercept !== undefined) {
      intercept.times -= 1;
      return intercept.reply(served, serve);
    }
    return serve();
  });
  return {
    requests,
    tokens: () => requests.filter((request) => request.method === "POST"),
    reads: () => requests.filter((request) => request.method === "GET" && PULL_PATH.test(request.path)),
    reply: (...added) => {
      replies.push(...added);
    },
    tokenReply: (reply) => {
      tokenReply = reply;
    },
    repository: repositoryOf,
    installations: (list) => {
      installations = list;
    },
    install: (owner, repo, id) => {
      installed.set(`${owner}/${repo}`.toLowerCase(), id);
    },
    intercept: (match, reply, times = Number.POSITIVE_INFINITY) => {
      intercepts.push({ match, reply, times });
    },
  };
}
