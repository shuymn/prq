import { type ErrorCode, ErrorResponse, PRQ_VERSION_HEADER } from "@prq/protocol";
import * as v from "valibot";

import type { Config } from "./config.ts";
import { CliError, EXIT } from "./errors.ts";
import { CALL_TIMEOUT_MS, type Clock, Retryable, RetryWindow, withRetry } from "./retry.ts";

export type Route = "/cli/wait" | "/cli/claim" | "/cli/context" | "/cli/submit";

// A route's refusal: a status other than 2xx, 503 or an authentication failure. It ends the command with exit 1 unless
// the command handles its code (a claim mismatch).
export class Refused extends CliError {
  readonly code: ErrorCode | null;

  constructor(message: string, code: ErrorCode | null) {
    super(EXIT.error, message);
    this.code = code;
  }
}

type Stderr = (line: string) => void;

// The version notice (docs/design.md, Versions): one line per process at the first response whose Prq-Version differs
// from the CLI's, however many requests the command makes. A response without the header (from Access or an edge) is
// not compared. The notice never changes stdout or the exit code.
export class VersionNotice {
  readonly #own: string;
  readonly #enabled: boolean;
  readonly #write: Stderr;
  #shown = false;

  constructor(own: string, enabled: boolean, write: Stderr) {
    this.#own = own;
    this.#enabled = enabled;
    this.#write = write;
  }

  check(headers: Headers): void {
    const server = headers.get(PRQ_VERSION_HEADER);
    if (!this.#enabled || this.#shown || server === null || server === this.#own) {
      return;
    }
    this.#shown = true;
    this.#write(`prq ${this.#own} talks to a ${printable(server)} server; update prq if a command fails`);
  }
}

// Text from a response as a stderr line may carry it: printable ASCII, bounded.
function printable(value: string, max = 64): string {
  return value.replaceAll(/[^\x20-\x7e]/g, "?").slice(0, max);
}

// The Worker's /cli/* routes over HTTP (docs/design.md, Local CLI). Every request is a JSON POST with the Access
// service token, follows no redirect and has a timeout; every answer is validated before it is used.
export class Client {
  readonly #config: Config;
  readonly #notice: VersionNotice;
  readonly #stderr: Stderr;
  // One client serves one command, so its requests share one retry window.
  readonly #window: RetryWindow;

  constructor(config: Config, notice: VersionNotice, stderr: Stderr, clock: Clock) {
    this.#config = config;
    this.#notice = notice;
    this.#stderr = stderr;
    this.#window = new RetryWindow(clock);
  }

  // One request, retried on 503 and network failures within the command's retry window.
  call<S extends v.GenericSchema>(route: Route, body: unknown, schema: S): Promise<v.InferOutput<S>> {
    return withRetry(
      () => this.attempt(route, body, schema, CALL_TIMEOUT_MS),
      this.#window,
      (failure) => this.retrying(route, failure),
    );
  }

  // The stderr line that starts a retry streak.
  retrying(route: Route, failure: Retryable): void {
    this.#stderr(`${route} is unavailable (${failure.reason}); retrying`);
  }

  // One request: the route's answer parsed with its schema, or Retryable. Authentication failures (any 3xx, 401, 403)
  // end the command, and so does every other failure, a refusal as Refused.
  async attempt<S extends v.GenericSchema>(
    route: Route,
    body: unknown,
    schema: S,
    timeoutMs: number,
  ): Promise<v.InferOutput<S> | Retryable> {
    let res: Response;
    try {
      res = await fetch(new URL(route, this.#config.url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Access-Client-Id": this.#config.clientId,
          "CF-Access-Client-Secret": this.#config.clientSecret,
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return new Retryable(failureName(error));
    }
    this.#notice.check(res.headers);
    if ((res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) {
      await discard(res);
      throw new CliError(
        EXIT.setup,
        `authentication failed (HTTP ${res.status} from ${route}); check PRQ_ACCESS_CLIENT_ID and PRQ_ACCESS_CLIENT_SECRET`,
      );
    }
    if (res.status === 503) {
      await discard(res);
      return new Retryable("HTTP 503");
    }
    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      return new Retryable(failureName(error));
    }
    if (res.ok) {
      const parsed = v.safeParse(schema, parseJson(text));
      if (!parsed.success) {
        throw new CliError(EXIT.error, `${route} answered ${res.status} with a body that is not its answer`);
      }
      return parsed.output;
    }
    const error = v.safeParse(ErrorResponse, parseJson(text));
    const code = error.success ? ` ${error.output.error}${error.output.detail ? `: ${error.output.detail}` : ""}` : "";
    throw new Refused(
      `${route} answered ${res.status}${printable(code, 200)}`,
      error.success ? error.output.error : null,
    );
  }
}

// What a failed request says about itself, without its URL or headers: the timeout, or the network error's cause.
function failureName(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "timed out";
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const code = cause instanceof Error ? Reflect.get(cause, "code") : undefined;
  return typeof code === "string" ? `network error ${code}` : "network error";
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // The body is not used; a stream that already failed has nothing to release.
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
