import pkg from "../package.json" with { type: "json" };

// The CLI's version, `v` + packages/cli/package.json `version`, compared with the server's Prq-Version header
// (docs/design.md, Versions).
export const CLI_VERSION = `v${pkg.version}`;
