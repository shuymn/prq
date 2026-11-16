import * as v from "valibot";

// Sent on every WebSocket connection to the Hub and to a PrSession: a browser cannot read the Prq-Version header of a
// WebSocket response, so the UI learns the server's version from this message (docs/design.md, Versions).
export const ServerVersionMessage = v.object({ type: v.literal("prq:version"), version: v.string() });
export type ServerVersionMessage = v.InferOutput<typeof ServerVersionMessage>;

// Sent to every connection to a PrSession after a write, in place of the stored history when that is longer than one
// list the server sends: the UI reloads the history through get-messages, which streams all of it.
export const HistoryChangedMessage = v.object({ type: v.literal("prq:history-changed") });
export type HistoryChangedMessage = v.InferOutput<typeof HistoryChangedMessage>;
