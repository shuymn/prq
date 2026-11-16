import { ServerVersionMessage } from "@prq/protocol";
import * as v from "valibot";
import { afterEach, expect, it, vi } from "vitest";

import { captureLogs } from "./test/access.ts";
import { type AgentSocket, connect, hostToken } from "./test/chat.ts";
import { SERVER_VERSION } from "./version.ts";

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

it.for(["/agents/hub/hub", "/agents/pr-session/octo~demo~1"])(
  "every connection to %s receives the server version",
  async (path) => {
    captureLogs();
    const token = await hostToken();
    for (let i = 0; i < 2; i += 1) {
      const socket = await connect(path, token);
      sockets.push(socket);
      const frame = await socket.next((candidate) => candidate["type"] === "prq:version");
      expect(v.parse(ServerVersionMessage, frame)).toEqual({ type: "prq:version", version: SERVER_VERSION });
    }
  },
);
