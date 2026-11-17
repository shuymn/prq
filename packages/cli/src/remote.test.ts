import { describe, expect, it } from "vitest";

import { githubRepository, matchingRemote } from "./remote.ts";

describe("githubRepository", () => {
  it.each([
    ["https://github.com/acme/widgets.git", { owner: "acme", repo: "widgets" }],
    ["https://github.com/acme/widgets", { owner: "acme", repo: "widgets" }],
    ["https://github.com/acme/widgets/", { owner: "acme", repo: "widgets" }],
    ["git@github.com:acme/widgets.git", { owner: "acme", repo: "widgets" }],
    ["git@github.com:Acme/Widgets", { owner: "Acme", repo: "Widgets" }],
    ["ssh://git@github.com/acme/widgets.git", { owner: "acme", repo: "widgets" }],
    ["HTTPS://GitHub.com/acme/widgets.js.git", { owner: "acme", repo: "widgets.js" }],
  ])("%s", (url, repository) => {
    expect(githubRepository(url)).toEqual(repository);
  });

  it.each([
    "https://gitlab.com/acme/widgets.git",
    "https://github.com/acme",
    "https://github.com/acme/widgets/tree/main",
    "https://github.com.evil.example/acme/widgets",
    "git@github.com:acme/widgets/extra.git",
    "file:///srv/acme/widgets.git",
    "/srv/acme/widgets.git",
  ])("not a GitHub repository: %s", (url) => {
    expect(githubRepository(url)).toBeNull();
  });
});

describe("matchingRemote", () => {
  const pr = { owner: "acme", repo: "widgets", number: 7 };

  it("prefers origin, compares without case", () => {
    const remotes = [
      "remote.backup.url https://github.com/acme/widgets.git",
      "remote.origin.url git@github.com:ACME/Widgets.git",
    ].join("\n");
    expect(matchingRemote(remotes, pr)).toBe("origin");
  });

  it("else the first matching remote by name: a fork whose origin is the fork", () => {
    const remotes = [
      "remote.origin.url git@github.com:someone/widgets.git",
      "remote.zeta.url https://github.com/acme/widgets",
      "remote.upstream.url https://github.com/acme/widgets.git",
    ].join("\n");
    expect(matchingRemote(remotes, pr)).toBe("upstream");
  });

  it("null when no remote names the repository", () => {
    expect(matchingRemote("remote.origin.url https://github.com/acme/gadgets.git\n", pr)).toBeNull();
    expect(matchingRemote("", pr)).toBeNull();
  });
});
