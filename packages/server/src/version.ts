import { version } from "../package.json";

// The server's version, `v` + packages/server/package.json `version`. The Worker and the UI it serves share it; it
// goes out in the Prq-Version header (docs/design.md, Versions).
export const SERVER_VERSION = `v${version}`;
