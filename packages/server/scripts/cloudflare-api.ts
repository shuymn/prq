// Cloudflare's API as the operations commands call it: with wrangler's login (wranglerHeaders(), the deploy's reads and
// the setup's zone list), or with a token the owner pasted (setup cloudflare). Either credential stays in this process:
// in no argument, other process's environment, file or line printed (each is hidden from output before it is used).
//
// Every call has a bound on its time. A 403 names the permission the call needed, never "missing". A write the API
// did not acknowledge (no answer, or a server error) is Unconfirmed: its effect is not known.

import * as v from "valibot";

import { fixture } from "./fixture.ts";
import { API, exited, hide, Refusal, succeeded, TOP_LEVEL, Unconfirmed, waitMs, wrangler } from "./operations.ts";

// Only the tests' fixture sets another API (a stand-in).
export const apiOrigin = fixture.api ?? API;
// The most pages a list is read for.
const MAX_PAGES = 100;
const PER_PAGE = 50;

// `auth token --json`: wrangler's credentials, an OAuth or API token, or a global API key with its email.
const AuthAnswer = v.variant("type", [
  v.object({ type: v.picklist(["oauth", "api_token"]), token: v.string() }),
  v.object({ type: v.literal("api_key"), key: v.string(), email: v.string() }),
]);

let credentials: Promise<Record<string, string>> | null = null;

// The headers of a call with wrangler's login, from `wrangler auth token --json`, read once until forgotten.
export function wranglerHeaders(accountId: string): Promise<Record<string, string>> {
  credentials ??= (async () => {
    // No log file: its output is the credentials.
    const outcome = await wrangler(["auth", "token", "--json", ...TOP_LEVEL], accountId, {
      env: { WRANGLER_WRITE_LOGS: "false" },
    });
    if (!succeeded(outcome)) {
      // Its output is not shown: it can hold the credentials.
      throw new Refusal(
        `wrangler auth token ${outcome.timedOut ? "did not finish" : `failed (${exited(outcome)})`}: log wrangler in (docs/operations.md, Cloudflare account)`,
      );
    }
    const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), AuthAnswer), outcome.stdout);
    if (!parsed.success) {
      throw new Refusal("wrangler auth token did not answer in the shape this command reads");
    }
    const auth = parsed.output;
    if (auth.type === "api_key") {
      hide([auth.key, auth.email]);
      return { "X-Auth-Key": auth.key, "X-Auth-Email": auth.email };
    }
    hide([auth.token]);
    return { Authorization: `Bearer ${auth.token}` };
  })();
  return credentials;
}

// wrangler's login is read again on the next call (it can have expired, and wrangler refreshes it when asked).
export function forgetWranglerHeaders(): void {
  credentials = null;
}

const Envelope = v.object({
  success: v.boolean(),
  // Web Analytics' list answers a success with errors and messages null.
  errors: v.pipe(
    v.nullish(v.array(v.object({ code: v.number() }))),
    v.transform((errors) => errors ?? []),
  ),
  result: v.optional(v.unknown()),
  // Any of its counts can be missing or null (Web Analytics' total_pages is documented nullable).
  result_info: v.nullish(
    v.object({
      page: v.nullish(v.number()),
      per_page: v.nullish(v.number()),
      total_pages: v.nullish(v.number()),
      total_count: v.nullish(v.number()),
    }),
  ),
});

type Method = "GET" | "POST" | "PUT" | "PATCH";
// A call: what it reads or changes (for messages), the permission it needs (named on a 403), and a body for a write.
type Call = { what: string; permission: string; body?: unknown };

// Cloudflare's API with the given headers.
export class CloudflareApi {
  readonly #headers: Record<string, string>;

  constructor(headers: Record<string, string>) {
    this.#headers = headers;
  }

  // A call's envelope, or null on a 404 for a read.
  async #call(method: Method, path: string, call: Call): Promise<v.InferOutput<typeof Envelope> | null> {
    const write = method !== "GET";
    let response: Response;
    try {
      response = await fetch(`${apiOrigin}${path}`, {
        method,
        headers: {
          ...this.#headers,
          accept: "application/json",
          ...(call.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(waitMs),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "no answer in time" : "no connection";
      const line = `Cloudflare's API did not answer for ${call.what} (${reason})`;
      throw write ? new Unconfirmed(`${line}: whether it changed is not known; run the step again`) : new Refusal(line);
    }
    const parsed = v.safeParse(Envelope, await response.json().catch(() => null));
    const codes = parsed.success ? parsed.output.errors.map((each) => each.code) : [];
    const coded = codes.length > 0 ? ` (error ${codes.join(", ")})` : "";
    if (response.status === 403) {
      throw new Refusal(`Cloudflare's API denied ${call.what}: the token needs ${call.permission}${coded}`);
    }
    if (response.status === 401) {
      throw new Refusal(`Cloudflare's API did not accept the credentials for ${call.what}${coded}`);
    }
    if (response.status === 404 && !write) {
      return null;
    }
    // A write answered 200 whose answer cannot be read may have taken effect.
    if (write && (response.status >= 500 || (response.ok && !parsed.success))) {
      throw new Unconfirmed(
        `Cloudflare's API answered HTTP ${response.status} for ${call.what}${coded}: whether it changed is not known; run the step again`,
      );
    }
    if (!response.ok || !parsed.success || !parsed.output.success) {
      throw new Refusal(`Cloudflare's API answered HTTP ${response.status} for ${call.what}${coded}`);
    }
    return parsed.output;
  }

  #result<S extends v.GenericSchema>(call: Call, schema: S, result: unknown): v.InferOutput<S> {
    const parsed = v.safeParse(schema, result);
    if (!parsed.success) {
      throw new Refusal(`Cloudflare's API answered ${call.what} in another shape than this command reads`);
    }
    return parsed.output;
  }

  // A read's result, or null when the API answers 404.
  async get<S extends v.GenericSchema>(path: string, call: Call, schema: S): Promise<v.InferOutput<S> | null> {
    const envelope = await this.#call("GET", path, call);
    return envelope === null ? null : this.#result(call, schema, envelope.result);
  }

  // Every page of a list (an empty list on a 404).
  async list<S extends v.GenericSchema>(path: string, call: Call, item: S): Promise<v.InferOutput<S>[]> {
    const items: v.InferOutput<S>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = new URL(path, "http://path.invalid");
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", String(PER_PAGE));
      const envelope = await this.#call("GET", `${url.pathname}${url.search}`, call);
      if (envelope === null) {
        return items;
      }
      const found = this.#result(call, v.nullable(v.array(item)), envelope.result) ?? [];
      items.push(...found);
      const info = envelope.result_info;
      // Without a page count, the item count against the items read so far, then a short page (the API can answer
      // fewer than it was asked for, so the page size is the last resort).
      const last =
        typeof info?.total_pages === "number"
          ? (info.page ?? page) >= info.total_pages
          : found.length === 0 ||
            (typeof info?.total_count === "number"
              ? items.length >= info.total_count
              : found.length < (info?.per_page ?? PER_PAGE));
      if (last) {
        return items;
      }
    }
    throw new Refusal(`Cloudflare's API listed more than ${MAX_PAGES} pages for ${call.what}`);
  }

  // A write's result.
  async send<S extends v.GenericSchema>(
    method: Exclude<Method, "GET">,
    path: string,
    call: Call,
    schema: S,
  ): Promise<v.InferOutput<S>> {
    const envelope = await this.#call(method, path, call);
    const parsed = v.safeParse(schema, envelope?.result);
    if (!parsed.success) {
      throw new Unconfirmed(
        `Cloudflare's API answered ${call.what} in another shape than this command reads: whether it changed is not known; run the step again`,
      );
    }
    return parsed.output;
  }
}
