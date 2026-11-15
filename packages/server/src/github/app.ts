// GitHub App auth inside workerd: the App JWT and installation tokens. Both candidates are here so the spike can
// compare them; the product keeps one.
import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";
import githubAppJwt from "universal-github-app-jwt";

/** universal-github-app-jwt directly: an App JWT (RS256, iss = App ID, 10 minutes with 30 s clock drift). */
export async function appJwt(appId: string, privateKey: string): Promise<string> {
  const { token } = await githubAppJwt({ id: appId, privateKey });
  return token;
}

/**
 * @octokit/auth-app: App JWT and installation tokens (it uses universal-github-app-jwt for the JWT). `fetch` is
 * injectable so the spike can answer for api.github.com locally.
 */
export function appAuth(appId: string, privateKey: string, fetch: typeof globalThis.fetch = globalThis.fetch) {
  return createAppAuth({ appId, privateKey, request: request.defaults({ request: { fetch } }) });
}
