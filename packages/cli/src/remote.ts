import type { PrRef } from "@prq/protocol";

// The GitHub repository a remote URL names: https://github.com/<owner>/<repo>, git@github.com:<owner>/<repo> or
// ssh://git@github.com/<owner>/<repo>, each with or without .git; null for anything else.
const FORMS = [
  /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
];

export function githubRepository(url: string): { owner: string; repo: string } | null {
  for (const form of FORMS) {
    const match = form.exec(url);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { owner: match[1], repo: match[2] };
    }
  }
  return null;
}

// The remote of a clone that names the pull request's repository, compared without case as GitHub does: origin when it
// does, else the first by name. remotes: `git config --get-regexp` output for remote.<name>.url, the URLs as
// configured (not rewritten by insteadOf).
export function matchingRemote(remotes: string, pr: PrRef): string | null {
  const names: string[] = [];
  for (const line of remotes.split("\n")) {
    const match = /^remote\.(.+)\.url (.+)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    const repository = githubRepository(match[2]);
    if (
      repository !== null &&
      repository.owner.toLowerCase() === pr.owner.toLowerCase() &&
      repository.repo.toLowerCase() === pr.repo.toLowerCase()
    ) {
      names.push(match[1]);
    }
  }
  return names.includes("origin") ? "origin" : (names.toSorted()[0] ?? null);
}
