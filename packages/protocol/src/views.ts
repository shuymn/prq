import * as v from "valibot";

// Sent on every WebSocket connection to the Hub and to a PrSession: a browser cannot read the Prq-Version header of a
// WebSocket response, so the UI learns the server's version from this message (docs/design.md, Versions).
export const ServerVersionMessage = v.object({ type: v.literal("prq:version"), version: v.string() });
export type ServerVersionMessage = v.InferOutput<typeof ServerVersionMessage>;
