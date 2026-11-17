import { afterEach, describe, expect, it, vi } from "vitest";

import { OUTPUT_STALL_MS, OUTPUT_STALLED } from "./pr-session/model.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question, storedMessages } from "./test/chat.ts";
import { cloudSession, streamsText, textOf } from "./test/cloud.ts";
import { ScriptedModel, type StreamPart, useCloudModel } from "./test/model.ts";
import { advance, until } from "./test/provider.ts";
import { gate, jobOf } from "./test/session.ts";

// A stream that stops sending output ends at the AI SDK's bound, before its first chunk or between chunks, and the
// job fails saying so. The clock is vitest's fake one, advanced inside the session.

const sockets: AgentSocket[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q1 = question("q1");

describe("output stall", () => {
  it.for([
    ["before its first chunk", [], ""],
    [
      "after a chunk",
      [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "partial answer" },
      ],
      "partial answer",
    ],
  ] satisfies [string, StreamPart[], string][])(
    "fails a job whose stream stops %s for the bound, and not a tick sooner",
    async ([, parts, kept]) => {
      captureLogs();
      const session = await cloudSession("stall", sockets);
      const { stub, client } = session;
      const held = await gate(stub);
      useCloudModel(new ScriptedModel().add([...parts, { hold: held }]));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      await client.chat([Q1]);
      await until(() => held.isReached(), "the stall");
      // The chunk before the stall has reached the client, so its bound was set before the clock moves.
      await until(() => kept === "" || streamsText(client.frames), "the chunk");

      await advance(stub, OUTPUT_STALL_MS - 1);
      expect((await jobOf(stub, "q1")).state).toBe("running");
      await advance(stub, 1);
      await until(async () => (await jobOf(stub, "q1")).state === "failed", "the failure");

      const job = await jobOf(stub, "q1");
      expect(job.failure).toBe(OUTPUT_STALLED);
      const incomplete = (await storedMessages(session.path, session.token)).find(
        (message) => message.id === `answer-${job.job_id}-r1-incomplete`,
      );
      expect(textOf(incomplete)).toBe(kept);
    },
  );
});
