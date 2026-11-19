// What a deployed check run records (deployed-check.ts): one observation per assertion, printed as it is made, with
// what was observed and, for a response, its correlation data (time, path, cf-ray). A verdict is pass or fail only on
// evidence: an Access denial that the command cannot attribute (a bare 401 or 403, which the owner correlates in
// Access's logs) is unattributed, and an assertion whose event did not happen (a poll answered at once, a reset not
// observed) is unexercised, never passed.
//
// What a run says of an upstream answer is built only from fields the check names, by the helpers below: a status, a
// header it reads reduced to what its verdict needs (a media type, a version, the sign-in path or the origin's root),
// an ID of a known shape, a failure's category, an error's code, sizes and times, and the check's own words. No header
// value, body, upstream text or child output is copied in free form. Every string then still goes through the
// redactor before it is printed or serialized, so neither the lines nor the saved run hold the hostname, the team
// domain or the service token, and the saved run is always JSON.

import { writeFile } from "node:fs/promises";

import type { Answer } from "./origin.ts";

export type Verdict = "pass" | "fail" | "unattributed" | "unexercised";

export type Observation = {
  id: string;
  what: string;
  verdict: Verdict;
  observed: string;
  evidence?: Record<string, unknown>;
};

const LABELS: Record<Verdict, string> = {
  pass: "pass",
  fail: "FAIL",
  unattributed: "unattributed",
  unexercised: "unexercised",
};

// The values no output may hold, and what stands in for each.
export type Withheld = {
  host?: string;
  teamDomain?: string;
  clientId?: string;
  clientSecret?: string;
  // The account's workers.dev subdomain.
  subdomain?: string;
};

// Replaces each withheld value in a string with its placeholder; a string that still holds the start of the secret is
// withheld whole.
function redactor({ host, teamDomain, clientId, clientSecret, subdomain }: Withheld): (text: string) => string {
  const teamHost = teamDomain === undefined ? undefined : URL.parse(teamDomain)?.host;
  const pairs: [string, string][] = [];
  for (const [value, placeholder] of [
    [clientSecret, "<client-secret>"],
    [clientId, "<client-id>"],
    [teamDomain, "<team-domain>"],
    [teamHost, "<team-domain>"],
    [host, "<host>"],
    [subdomain === undefined ? undefined : `${subdomain}.workers.dev`, "<subdomain>.workers.dev"],
  ] as const) {
    if (value !== undefined && value !== "") {
      pairs.push([value, placeholder]);
    }
  }
  const secretStart = clientSecret !== undefined && clientSecret.length >= 8 ? clientSecret.slice(0, 8) : undefined;
  return (text) => {
    let redacted = text;
    for (const [value, placeholder] of pairs) {
      redacted = redacted.replaceAll(value, placeholder);
    }
    if (secretStart !== undefined && redacted.includes(secretStart)) {
      return "[withheld: it held part of the client secret]";
    }
    return redacted;
  };
}

// Every string in a JSON value, redacted; the rest as it is.
function redactedValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactedValue(entry, redact));
  }
  if (value !== null && typeof value === "object") {
    return redactedRecord(Object.fromEntries(Object.entries(value)), redact);
  }
  return value;
}

function redactedRecord(record: Record<string, unknown>, redact: (text: string) => string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, redactedValue(entry, redact)]));
}

// --- What a line may say of an upstream answer ---

// The media types the checks expect: the web UI's files as the build emits them, the API's JSON, an error page's text.
const MEDIA_TYPES = new Set([
  "text/html",
  "application/json",
  "text/javascript",
  "application/javascript",
  "text/css",
  "font/woff2",
  "font/woff",
  "image/svg+xml",
  "image/png",
  "text/plain",
]);

// A media type's essence (type/subtype, lower case, no parameters) when it is one the checks expect, else a label.
export function mediaType(value: string | undefined): string {
  if (value === undefined) {
    return "no content-type";
  }
  const essence = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return MEDIA_TYPES.has(essence) ? essence : "another content-type";
}

// A prq version (Prq-Version, prq:version) when it has a version's shape.
export function versionOf(value: unknown): string {
  if (value === undefined) {
    return "none";
  }
  return typeof value === "string" && /^v\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?$/.test(value)
    ? value
    : "one of another shape";
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// A job's ID as the Worker makes it (a UUID), else a marker.
export function jobIdOf(value: string): string {
  return new RegExp(`^${UUID}$`).test(value) ? value : "[a job ID of another form]";
}

// A message's ID as its producer makes it: a question's as the web UI (a UUID) or this check (check-<UUID>) does, a
// result's as the Worker does (<kind>-<job ID>, and -r<run>-incomplete after it for a failed run's text). Else a marker.
export function messageIdOf(value: string): string {
  return new RegExp(`^(?:(?:check-)?${UUID}|(?:analysis|answer)-${UUID}(?:-r[0-9]+-incomplete)?)$`).test(value)
    ? value
    : "[a message ID of another form]";
}

// An agent by its ID when the edge check made it; another agent's ID is its owner's choice or its host name, which the
// web UI shows.
export function agentOf(value: string): string {
  return /^edge-(?:poll|cli|(?:keep|cut)-[0-9a-f]{6})$/.test(value) ? value : "an agent (the web UI names it)";
}

// A job's failure by its category, the words before its first colon or parenthesis (workspace, instructions, a
// provider error): the rest may quote what a provider or GitHub said. The web UI shows it whole. A failure of plain
// words alone is kept whole.
export function failureOf(failure: string | null): string {
  if (failure === null) {
    return "no reason";
  }
  if (/^[a-z][a-z' ]{0,80}$/.test(failure)) {
    return failure;
  }
  const category = /^([a-z][a-z' ]{0,60}?)\s*[:(]/.exec(failure)?.[1];
  return category === undefined ? "a reason the web UI shows" : `${category} (the rest in the web UI)`;
}

// A Ray ID as Cloudflare gives one: 16 hex digits and the data center's code.
const RAY = /^[0-9a-f]{16}-[A-Z]{3}$/;

// A response's correlation data: when it was sent, its path, its status, and its cf-ray (Cloudflare's request ID,
// which Access's logs show) when it is a Ray ID.
export function correlation(path: string, answer: Pick<Answer, "at" | "status" | "headers">): Record<string, unknown> {
  const ray = answer.headers["cf-ray"];
  return { at: answer.at, path, status: answer.status, cfRay: ray !== undefined && RAY.test(ray) ? ray : null };
}

export class Report {
  readonly #write: (line: string) => void;
  readonly #redact: (text: string) => string;
  readonly observations: Observation[] = [];
  readonly notes: string[] = [];

  constructor(write: (line: string) => void, withheld: Withheld) {
    this.#write = write;
    this.#redact = redactor(withheld);
  }

  // A line that is no assertion: what the check does next, or what the owner reads elsewhere.
  note(line: string): void {
    const redacted = this.#redact(line);
    this.notes.push(redacted);
    this.#write(`  ${redacted}`);
  }

  add(observation: Observation): void {
    const redact = this.#redact;
    const redacted: Observation = {
      id: redact(observation.id),
      what: redact(observation.what),
      verdict: observation.verdict,
      observed: redact(observation.observed),
      ...(observation.evidence === undefined ? {} : { evidence: redactedRecord(observation.evidence, redact) }),
    };
    this.observations.push(redacted);
    const ray = redacted.evidence?.["cfRay"];
    const at = redacted.evidence?.["at"];
    const where = typeof at === "string" ? ` [${at}${typeof ray === "string" ? ` cf-ray ${ray}` : ""}]` : "";
    this.#write(`${LABELS[redacted.verdict]} ${redacted.id} ${redacted.what}: ${redacted.observed}${where}`);
  }

  failed(): boolean {
    return this.observations.some((observation) => observation.verdict === "fail");
  }

  // The run as JSON, written to a new file readable by its owner alone; an existing file is never replaced.
  async save(path: string, run: Record<string, unknown>): Promise<void> {
    const document = {
      ...redactedRecord(run, this.#redact),
      observations: this.observations,
      notes: this.notes,
    };
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
}
