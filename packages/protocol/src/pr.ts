import * as v from "valibot";

// A pull request. GitHub names are case-insensitive, so a reference is accepted in any case and canonicalized before
// it addresses anything.
export const PrRef = v.object({
  owner: v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)),
  repo: v.pipe(v.string(), v.regex(/^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/)),
  number: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
export type PrRef = v.InferOutput<typeof PrRef>;

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
