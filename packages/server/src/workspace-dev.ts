// Spike entry for the Sandbox workspace (wrangler.sandbox.jsonc). Local only; it has no auth.
import { GitOutbound, Workspace, type WorkspaceEnv } from "./workspace.ts";

export { GitOutbound, Workspace };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const m = /^\/ws\/([a-z0-9-]{1,63})\/(prepare|grep|read|probe|stop|running)$/.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    const ws = env.Workspace.getByName(m[1]!);
    const body = (await request.json().catch(() => ({}))) as Record<string, string>;
    try {
      switch (m[2]) {
        case "prepare":
          return Response.json(
            await ws.prepare({ repo: body["repo"]!, headSha: body["headSha"]!, baseSha: body["baseSha"]! }),
          );
        case "grep":
          return Response.json(await ws.grep(body["pattern"]!));
        case "read":
          return new Response(await ws.read(url.searchParams.get("path")!));
        case "probe":
          return Response.json(await ws.probe(body["url"]!));
        case "stop":
          await ws.stop();
          return Response.json({ stopped: true });
        default:
          return Response.json({ running: await ws.running() });
      }
    } catch (e) {
      return Response.json({ error: String((e as Error).stack ?? e) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<WorkspaceEnv>;
