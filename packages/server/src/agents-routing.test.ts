import { ErrorResponse } from "@prq/protocol";
import type { Agent } from "agents";
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import app from "./index.ts";
import { hubStub, prSessionStub } from "./names.ts";
import { captureLogs, request } from "./test/access.ts";
import { type AgentSocket, connect, hostToken } from "./test/chat.ts";

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

async function ids(namespace: DurableObjectNamespace): Promise<string[]> {
  return (await listDurableObjectIds(namespace)).map((id) => id.toString()).toSorted();
}

// The Durable Object instances that exist: the plugin lists every ID with stored state, and every class writes its
// schema version in its constructor.
async function instances(): Promise<{ hub: string[]; prSession: string[]; workspace: string[] }> {
  return { hub: await ids(env.Hub), prSession: await ids(env.PrSession), workspace: await ids(env.Workspace) };
}

function upgrade(path: string, token: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(request(path, token, { headers: { Upgrade: "websocket", ...headers } }));
}

const OCTO_DEMO_1 = { owner: "octo", repo: "demo", number: 1 };

describe("routes only canonical names", () => {
  const refused = [
    "/agents/hub/other",
    "/agents/hub/Hub",
    "/agents/hub/HUB",
    "/agents/pr-session/OCTO~demo~1",
    "/agents/pr-session/octo~Demo~1",
    "/agents/pr-session/octo~demo~01",
    "/agents/pr-session/octo~demo~1~2",
    "/agents/pr-session/octo%7Edemo%7E1",
    "/agents/pr-session/octo~demo",
    "/agents/pr-session/octo~demo~0",
    "/agents/pr-session/-octo~demo~1",
    "/agents/pr-session/octo~..~1",
    "/agents/Hub/hub",
    "/agents/unknown/hub",
    "/agents/constructor/hub",
    "/agents/__proto__/hub",
    "/agents/toString/hub",
    "/agents/hub",
    // The Workspace is no Agent: only its session reaches it.
    "/agents/workspace/octo~demo~1",
    "/agents/Workspace/octo~demo~1",
  ];

  it.for(refused)("refuses %s over HTTP and WebSocket, creating no instance", async (path) => {
    captureLogs();
    const token = await hostToken();
    const before = await instances();

    const res = await exports.default.fetch(request(path, token));
    const socket = await upgrade(path, token);
    socket.webSocket?.accept();
    socket.webSocket?.close();

    expect(await instances()).toEqual(before);
    expect({ http: res.status, webSocket: socket.status }).toEqual({ http: 404, webSocket: 404 });
    expect(v.parse(ErrorResponse, await res.json()).error).toBe("not_found");
    expect(v.parse(ErrorResponse, await socket.json()).error).toBe("not_found");
  });

  it("routes the hub and a canonical session name to their instances", async () => {
    captureLogs();
    const token = await hostToken();
    for (const path of ["/agents/hub/hub", "/agents/pr-session/octo~demo~1"]) {
      sockets.push(await connect(path, token));
    }

    const after = await instances();
    expect(after.hub).toContain((await hubStub(env)).id.toString());
    expect(after.prSession).toContain((await prSessionStub(env, OCTO_DEMO_1)).id.toString());
  });
});

describe("serves only a WebSocket to an instance and a session's stored history", () => {
  // Each on a session that does not exist yet: the refusal must come before the SDK router creates it.
  const refusedBoth = [
    "/agents/pr-session/octo~fresh~1/sub/hub/typo",
    "/agents/pr-session/octo~fresh~2/extra",
    "/agents/pr-session/octo~fresh~3/get-messages/extra",
    "/agents/hub/hub/sub/pr-session/typo",
  ];

  it.for(refusedBoth)("refuses %s over HTTP and WebSocket, creating no instance", async (path) => {
    captureLogs();
    const token = await hostToken();
    const before = await instances();

    const res = await exports.default.fetch(request(path, token));
    const socket = await upgrade(path, token);
    socket.webSocket?.accept();
    socket.webSocket?.close();

    expect(await instances()).toEqual(before);
    expect({ http: res.status, webSocket: socket.status }).toEqual({ http: 404, webSocket: 404 });
    expect(v.parse(ErrorResponse, await res.json()).error).toBe("not_found");
    expect(v.parse(ErrorResponse, await socket.json()).error).toBe("not_found");
  });

  const refusedRequests = [
    { name: "a plain GET of a session", path: "/agents/pr-session/octo~fresh~4", init: {} },
    { name: "a plain GET of the Hub", path: "/agents/hub/hub", init: {} },
    { name: "a POST of get-messages", path: "/agents/pr-session/octo~fresh~5/get-messages", init: { method: "POST" } },
    {
      name: "a WebSocket to get-messages",
      path: "/agents/pr-session/octo~fresh~6/get-messages",
      init: { headers: { Upgrade: "websocket" } },
    },
  ];

  it.for(refusedRequests)("refuses $name, creating no instance", async ({ path, init }) => {
    captureLogs();
    const token = await hostToken();
    const before = await instances();

    const res = await exports.default.fetch(request(path, token, init));

    expect(await instances()).toEqual(before);
    expect(res.status).toBe(404);
    expect(v.parse(ErrorResponse, await res.json()).error).toBe("not_found");
  });
});

describe("no sub-agents", () => {
  // The Worker never routes a sub-agent path; an instance still refuses one that reaches it directly.
  const routes = [
    { path: "/agents/hub/hub/sub/pr-session/evil", stub: () => hubStub(env), child: "PrSession" },
    { path: "/agents/pr-session/octo~demo~1/sub/hub/evil", stub: () => prSessionStub(env, OCTO_DEMO_1), child: "Hub" },
  ];

  it.for(routes)("an instance refuses $path and creates no child", async ({ path, stub, child }) => {
    captureLogs();
    const instance = await stub();
    const children = () =>
      runInDurableObject(instance, (agent: Agent<Env>) => ({
        all: agent.listSubAgents(),
        evil: agent.hasSubAgent(child, "evil"),
      }));

    const res = await instance.fetch(`https://prq.example${path}`);
    expect(await children()).toEqual({ all: [], evil: false });
    expect(res.status).toBe(404);
    expect(v.parse(ErrorResponse, await res.json()).error).toBe("not_found");
  });

  it("ignores a client's sub-agent URL header, which would skip the refusal", async () => {
    captureLogs();
    const token = await hostToken();
    const path = "/agents/pr-session/octo~demo~1";
    const socket = await connect(path, token, {
      "x-cf-agents-subagent-url": `https://prq.example${path}/sub/hub/evil`,
    });
    sockets.push(socket);
    // Sent at the end of setting up the connection, by the session or by a child it was handed to.
    await socket.next((frame) => frame["type"] === "prq:version");

    const instance = await prSessionStub(env, OCTO_DEMO_1);
    expect(await runInDurableObject(instance, (agent) => agent.listSubAgents())).toEqual([]);
  });
});

// A namespace that records the request its instance would receive.
function recordingNamespace(seen: Request[]) {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (forwarded: Request) => {
        seen.push(forwarded);
        return new Response(null, { status: 204 });
      },
    }),
  };
}

describe("internal headers", () => {
  const internal = {
    "x-agents-lifecycle-props": "eyJvd25lciI6ImNsb3VkIn0",
    "x-cf-agents-subagent-url": "https://prq.example/agents/hub/hub/sub/pr-session/evil",
  };

  const served = [
    { path: "/agents/pr-session/octo~demo~1/get-messages", headers: {} },
    { path: "/agents/hub/hub", headers: { Upgrade: "websocket" } },
  ];

  it.for(served)(
    "strips the SDK's internal headers before an instance sees them ($path)",
    async ({ path, headers: routeHeaders }) => {
      captureLogs();
      const token = await hostToken();
      const seen: Request[] = [];
      const namespace = recordingNamespace(seen);
      const headers = { ...internal, ...routeHeaders, "x-other": "kept" };

      await app.fetch(request(path, token, { headers }), { ...env, Hub: namespace, PrSession: namespace });

      expect(seen).toHaveLength(1);
      expect(Object.fromEntries(seen[0]?.headers ?? [])).toMatchObject({ "x-other": "kept" });
      for (const name of Object.keys(internal)) {
        expect(seen[0]?.headers.has(name)).toBe(false);
      }
    },
  );
});
