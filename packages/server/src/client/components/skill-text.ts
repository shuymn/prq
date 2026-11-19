// How the settings name a skill's source and ref (design/components.md, Settings): the repository as a GitHub address,
// the skill's directory after it ("github.com/shuymn/kopje · skills/review"), and a ref by its name, a commit's by
// its first seven digits.

import type { SkillRef, SkillSource } from "@prq/protocol";

import { shortSha } from "./Sha.tsx";

export const sourceText = (source: SkillSource) =>
  `github.com/${source.owner}/${source.repo}${source.path === "" ? "" : ` · ${source.path}`}`;

export const refText = (ref: SkillRef) => (ref.kind === "commit" ? shortSha(ref.name) : ref.name);
