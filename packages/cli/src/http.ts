// HTTP client for /cli/*. Every request has a deadline; 401/403 become AuthError so callers can exit distinctly.
import * as v from "valibot";

export class AuthError extends Error {}
export class ConflictError extends Error {
  readonly body: unknown;
  constructor(body: unknown) {
    super(JSON.stringify(body));
    this.body = body;
  }
}

export type Config = { baseUrl: string; token: string; agentId: string };

export async function post<S extends v.GenericSchema>(
  config: Config,
  path: string,
  body: unknown,
  schema: S,
  timeoutMs: number,
): Promise<v.InferOutput<S>> {
  const res = await fetch(new URL(path, config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "cf-access-jwt-assertion": config.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) throw new AuthError(`${res.status} ${await res.text()}`);
  if (res.status === 409 || res.status === 404) throw new ConflictError(await res.json());
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return v.parse(schema, await res.json());
}
