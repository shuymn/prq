// The header that carries the server's version (`vX.Y.Z`) on every /cli/* response, errors included. The CLI compares
// it with its own version as plain strings (docs/design.md, Versions).
export const PRQ_VERSION_HEADER = "Prq-Version";
