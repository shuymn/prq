import * as v from "valibot";

// A pull request. GitHub names are case-insensitive, so a reference is accepted in any case and canonicalized before
// it addresses anything.
export const PrRef = v.object({
  owner: v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)),
  repo: v.pipe(v.string(), v.regex(/^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/)),
  number: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
export type PrRef = v.InferOutput<typeof PrRef>;

// A repository as owner/name, each part as PrRef takes it, in any case.
export const RepoName = v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/));
export type RepoName = v.InferOutput<typeof RepoName>;

// Owner and repository lowercased, so one pull request has one session.
export function canonicalPrRef(ref: PrRef): PrRef {
  return { owner: ref.owner.toLowerCase(), repo: ref.repo.toLowerCase(), number: ref.number };
}

// The PrSession name of a pull request: `owner~repo~number` of the canonical reference. Neither part can contain `~`.
export function sessionName(ref: PrRef): string {
  const { owner, repo, number } = canonicalPrRef(ref);
  return `${owner}~${repo}~${number}`;
}

// The pull request a session name addresses, or null unless the name is exactly the canonical one: no case variants,
// no leading zeros, no other separators or encodings.
export function parseSessionName(name: string): PrRef | null {
  const [owner, repo, number, ...rest] = name.split("~");
  if (owner === undefined || repo === undefined || number === undefined || rest.length > 0) {
    return null;
  }
  const parsed = v.safeParse(PrRef, { owner, repo, number: Number(number) });
  return parsed.success && sessionName(parsed.output) === name ? parsed.output : null;
}

// The name of the one Hub.
export const HUB_NAME = "hub";

// A commit SHA as GitHub sends it: 40 lowercase hex digits.
export const Sha = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/));

// The longest details prq keeps, in UTF-16 code units, at or above what GitHub sends: a title has at most 256
// characters, a full name is an owner of up to 39 and a repository of up to 100, and a pull request's URL on
// github.com is under 200. They bound what a context response carries around its messages.
export const MAX_FULL_NAME_CHARS = 140;
export const MAX_TITLE_CHARS = 1024;
export const MAX_URL_CHARS = 2048;

// A pull request as its webhooks describe it, in GitHub's display case. The head is the current head, which only a push
// moves; the other fields follow the latest webhook.
export const PrDetails = v.object({
  fullName: v.pipe(v.string(), v.maxLength(MAX_FULL_NAME_CHARS)),
  title: v.pipe(v.string(), v.maxLength(MAX_TITLE_CHARS)),
  state: v.picklist(["open", "closed", "merged"]),
  url: v.pipe(v.string(), v.maxLength(MAX_URL_CHARS)),
  headSha: Sha,
  baseSha: Sha,
});
export type PrDetails = v.InferOutput<typeof PrDetails>;

// A conversation message's ID.
export const MessageId = v.pipe(v.string(), v.minLength(1), v.maxLength(256));

// A local agent's self-declared ID (`--agent-id`, the host name by default): printable ASCII without spaces.
export const MAX_AGENT_ID_CHARS = 128;
export const AgentId = v.pipe(v.string(), v.regex(new RegExp(`^[\\x21-\\x7e]{1,${MAX_AGENT_ID_CHARS}}$`)));
