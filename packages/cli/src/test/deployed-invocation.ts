// The deployed checks' command line (deployed-check.ts): the mode, its arguments and options. A usage error names the
// argument it refuses by its place, never by its value, which may be a value no output holds.

import { parseArgs } from "node:util";

import { PrRef, RepoName } from "@prq/protocol";
import * as v from "valibot";

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export type Invocation =
  | { mode: "endpoints"; subdomain: string | null; version: string | undefined; json: string | undefined }
  | { mode: "edge"; teamDomain: string; pr: PrRef | undefined; json: string | undefined }
  | { mode: "pool"; json: string | undefined }
  | { mode: "summary"; repo: string; json: string | undefined }
  | { mode: "ask"; pr: PrRef; text: string; json: string | undefined }
  | { mode: "jobs"; pr: PrRef; json: string | undefined }
  | { mode: "retry"; pr: PrRef; jobId: string; json: string | undefined };

// <owner>/<repo>#<number>.
export function prRef(text: string): PrRef {
  const match = /^([^/#]+)\/([^/#]+)#([1-9][0-9]*)$/.exec(text);
  const parsed = v.safeParse(PrRef, { owner: match?.[1], repo: match?.[2], number: Number(match?.[3]) });
  if (match === null || !parsed.success) {
    throw new UsageError("the pull request is not <owner>/<repo>#<number>");
  }
  return parsed.output;
}

// The team domain as Access gives it: https://<team>.cloudflareaccess.com, an origin.
function teamDomain(text: string | undefined): string {
  const url = text === undefined ? null : URL.parse(text);
  if (url === null || url.protocol !== "https:" || url.origin !== text) {
    throw new UsageError("--team-domain takes the Access team domain, https://<team>.cloudflareaccess.com");
  }
  return url.origin;
}

export function parseInvocation(argv: readonly string[]): Invocation {
  let parsed;
  try {
    parsed = parseArgs({
      // A "--" before the arguments (as some package managers pass it) is not an argument.
      args: argv.filter((arg, index) => !(index === 0 && arg === "--")),
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "string" },
        version: { type: "string" },
        "team-domain": { type: "string" },
        pr: { type: "string" },
      },
    });
  } catch {
    throw new UsageError("an option this command does not take, or an option without its value");
  }
  const { values, positionals } = parsed;
  const [mode, ...rest] = positionals;
  const json = values.json;
  const only = (allowed: string[]) => {
    for (const option of ["version", "team-domain", "pr"] as const) {
      if (values[option] !== undefined && !allowed.includes(option)) {
        throw new UsageError(`--${option} does not apply to ${mode}`);
      }
    }
  };
  const count = (n: number, usage: string) => {
    if (rest.length !== n) {
      throw new UsageError(`usage: check:deployed ${mode} ${usage}`);
    }
  };
  switch (mode) {
    case "endpoints": {
      only(["version"]);
      count(1, "<subdomain|none> [--version <id>]");
      const subdomain = rest[0] ?? "";
      if (subdomain !== "none" && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
        throw new UsageError("the workers.dev subdomain is a DNS label, or none");
      }
      if (values.version !== undefined && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(values.version)) {
        throw new UsageError("--version takes the version ID the bootstrap reported");
      }
      if (subdomain === "none" && values.version !== undefined) {
        throw new UsageError("--version needs the subdomain");
      }
      return { mode, subdomain: subdomain === "none" ? null : subdomain, version: values.version, json };
    }
    case "edge":
      only(["team-domain", "pr"]);
      count(0, "--team-domain <url> [--pr <owner>/<repo>#<number>]");
      return {
        mode,
        teamDomain: teamDomain(values["team-domain"]),
        pr: values.pr === undefined ? undefined : prRef(values.pr),
        json,
      };
    case "pool":
      only([]);
      count(0, "");
      return { mode, json };
    case "summary": {
      only([]);
      count(1, "<owner>/<repo>");
      const repo = rest[0] ?? "";
      if (!v.is(RepoName, repo)) {
        throw new UsageError("the repository is not <owner>/<repo>");
      }
      return { mode, repo, json };
    }
    case "ask":
      only([]);
      count(2, "<owner>/<repo>#<number> <text>");
      if ((rest[1] ?? "").trim() === "") {
        throw new UsageError("the question is empty");
      }
      return { mode, pr: prRef(rest[0] ?? ""), text: rest[1] ?? "", json };
    case "jobs":
      only([]);
      count(1, "<owner>/<repo>#<number>");
      return { mode, pr: prRef(rest[0] ?? ""), json };
    case "retry":
      only([]);
      count(2, "<owner>/<repo>#<number> <jobId>");
      return { mode, pr: prRef(rest[0] ?? ""), jobId: rest[1] ?? "", json };
    default:
      throw new UsageError("usage: check:deployed <endpoints|edge|pool|summary|ask|jobs|retry> ...");
  }
}
