import { PrRef } from "@prq/protocol";
import * as v from "valibot";

// The GitHub link to a skill's SKILL.md (docs/design.md, Instructions and skills):
// https://github.com/<owner>/<repo>/blob/<ref…>/<path…>/SKILL.md, the query and fragment ignored (?plain=1, #L1).

// A link read: the repository and the segments between blob/ and the final SKILL.md, percent-decoded. The ref is the
// longest leading run of them that names a branch or tag, or the first when it is a commit SHA; the rest is the skill's
// directory, empty for a skill at the repository's root.
export type SkillLink = { owner: string; repo: string; segments: string[] };

// The link's path, taken from the text as written: URL parsing would resolve `.` and `..` segments (`%2e%2e`
// included) before they could be refused. The host is exactly github.com: no credentials, no port.
const LINK = /^https:\/\/github\.com(\/[^?#]*)(?:[?#].*)?$/i;

const NOT_A_LINK = "not a GitHub link to a SKILL.md (https://github.com/<owner>/<repo>/blob/<ref>/<path>/SKILL.md)";

// The link's parts, or why it is refused.
export function parseSkillLink(text: string): SkillLink | { issue: string } {
  const path = LINK.exec(text.trim())?.[1];
  if (path === undefined) {
    return { issue: NOT_A_LINK };
  }
  const segments: string[] = [];
  for (const raw of path.slice(1).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return { issue: `${NOT_A_LINK}: a segment is not percent-encoded UTF-8` };
    }
    if (segment === "" || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\0")) {
      return { issue: `${NOT_A_LINK}: an empty, ., .. or encoded / segment` };
    }
    segments.push(segment);
  }
  const [owner = "", repo = "", blob, ...rest] = segments;
  if (blob !== "blob" || rest.length < 2 || rest.at(-1) !== "SKILL.md") {
    return { issue: NOT_A_LINK };
  }
  if (!v.is(PrRef.entries.owner, owner) || !v.is(PrRef.entries.repo, repo)) {
    return { issue: `${NOT_A_LINK}: not a repository name` };
  }
  return { owner, repo, segments: rest.slice(0, -1) };
}
