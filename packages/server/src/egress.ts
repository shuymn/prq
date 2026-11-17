import { WorkerEntrypoint } from "cloudflare:workers";

import { readGithubAppConfig } from "./config.ts";
import { type GithubClient, githubFor } from "./github.ts";
import { errorName, log } from "./log.ts";

// The workspace container's only way out (docs/design.md, Workspace (cloud)): the Workspace sends every HTTP and HTTPS
// request of its container here. Only a git fetch from a repository on github.com passes: its two smart-HTTP
// requests, the ref advertisement (GET …/info/refs?service=git-upload-pack) and the fetch itself (POST
// …/git-upload-pack). The installation token is added here, in place of any credentials the container sent, so it
// never enters the container; which repositories it reaches follows the token's scope. A redirect is handed back to
// git, never followed here, so it leads back through this check. Everything else gets 403 and reaches no upstream.

// What the Workspace binds the egress with: the installation whose token a fetch gets.
export type EgressProps = { installationId: number };

// An owner and a repository name as GitHub allows them, with or without the .git suffix git adds.
const REPOSITORY = "/[A-Za-z0-9](?:[A-Za-z0-9-]*)/[A-Za-z0-9._-]+?(?:\\.git)?";
const REF_ADVERTISEMENT = new RegExp(`^${REPOSITORY}/info/refs$`);
const UPLOAD_PACK = new RegExp(`^${REPOSITORY}/git-upload-pack$`);

// Whether a request is one of a git fetch's from github.com.
function isGitFetch(request: Request): boolean {
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.host !== "github.com" || url.username !== "" || url.password !== "") {
    return false;
  }
  if (request.method === "GET") {
    return REF_ADVERTISEMENT.test(url.pathname) && url.search === "?service=git-upload-pack";
  }
  return request.method === "POST" && UPLOAD_PACK.test(url.pathname) && url.search === "";
}

export class GitEgress extends WorkerEntrypoint<Env, EgressProps> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!isGitFetch(request)) {
      log("prq.egress.denied", { host: url.host, method: request.method, path: url.pathname }, "warn");
      return new Response("prq: only git fetches from github.com leave the workspace\n", { status: 403 });
    }
    let token: string;
    try {
      const github = this.github();
      if (github === undefined) {
        throw new Error("the GitHub App is not configured");
      }
      token = await github.installationToken(this.ctx.props.installationId);
    } catch (error) {
      log("prq.egress.token_failed", { error: errorName(error) }, "error");
      return new Response("prq: no installation token for this fetch\n", { status: 502 });
    }
    // set replaces whatever Authorization the container sent.
    const headers = new Headers(request.headers);
    headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
    return fetch(url, { method: request.method, headers, body: request.body, redirect: "manual" });
  }

  // The GitHub App's client (spied on in tests): none while the App is not configured or misconfigured.
  protected github(): GithubClient | undefined {
    const config = readGithubAppConfig(this.env);
    return config?.ok === true ? githubFor(this.env, config.config) : undefined;
  }
}
