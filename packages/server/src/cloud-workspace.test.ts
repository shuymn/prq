import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GithubClient } from "./github.ts";
import { PrSession, RELEASE_MS } from "./pr-session/index.ts";
import {
  CLEANUP_FAILED,
  WORKSPACE_LOST,
  workspaceClient,
  WorkspaceLost,
  type WorkspaceTarget,
} from "./pr-session/workspace.ts";
import { captureLogs, events } from "./test/access.ts";
import type { AgentSocket } from "./test/chat.ts";
import { cloudSession, untilEnded } from "./test/cloud.ts";
import { type FakeContainer, untilHeld, useFakeContainers, workspaceSeams } from "./test/container.ts";
import {
  answerScript,
  type CallOptions,
  finish,
  ScriptedModel,
  toolCall,
  useCloudModel,
  useWorkspace,
} from "./test/model.ts";
import { advance, until } from "./test/provider.ts";
import { jobRows, prSessionSeams } from "./test/session.ts";
import { BASE, push, sha } from "./test/webhook.ts";
import { FakeWorkspace } from "./test/workspace.ts";
import type { Workspace, WorkspaceFailure } from "./workspace.ts";

// Cloud turns through the session's own Workspace (the production workspaceFor), whose container is a fake.

const sockets: AgentSocket[] = [];
let containerOf: (name: string) => FakeContainer;

beforeEach(() => {
  containerOf = useFakeContainers();
  // The App is configured: the session has a workspace. Its calls to GitHub are the egress's, which these tests do
  // not reach.
  const github: GithubClient = {
    pullRequest: () => Promise.reject(new Error("not served")),
    installationToken: () => Promise.reject(new Error("not served")),
  };
  vi.spyOn(prSessionSeams(PrSession.prototype), "github").mockReturnValue(github);
});

afterEach(() => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

// A turn that reads README.md twice, then answers.
function readTwice(model: ScriptedModel): void {
  model.add(
    [toolCall("read_file", { path: "README.md" }, "call-1"), finish("tool-calls")],
    [toolCall("read_file", { path: "README.md" }, "call-2"), finish("tool-calls")],
    answerScript("the summary"),
  );
}

// The text of each tool result a model call was sent.
function toolResults(call: CallOptions | undefined): string[] {
  return (call?.prompt ?? []).flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" && part.output.type === "text" ? [part.output.value] : [],
        )
      : [],
  );
}

// The container's checkout serves README.md; the first read stops the container after it answers, as a crash or an
// eviction between two tool calls would.
function stopAfterFirstRead(container: FakeContainer): void {
  container.mergeBase = BASE;
  let reads = 0;
  container.on = (argv) => {
    if (!argv.includes("show")) {
      return undefined;
    }
    reads += 1;
    if (reads === 1) {
      container.stop();
    }
    return { stdout: "# demo\n" };
  };
}

describe("a container lost mid-turn", () => {
  it("prepares the same commit again before the next tool call, and the turn goes on", async () => {
    captureLogs();
    const { stub, ref, name } = await cloudSession("workspace", sockets);
    const model = new ScriptedModel();
    readTwice(model);
    useCloudModel(model);
    const container = containerOf(name);
    stopAfterFirstRead(container);

    await push(ref, "a");

    expect(await untilEnded(stub, sha("a"))).toEqual({ state: "done", failure: null });
    expect(model.calls).toHaveLength(3);
    expect(toolResults(model.calls[2])).toEqual(["1\t# demo", "1\t# demo"]);
    const second = container.log.slice(container.log.findIndex((entry) => entry.includes(" show ")) + 1);
    expect(second[0]).toBe("start");
    expect(second.filter((entry) => entry.includes(" fetch "))).toEqual([
      `git -C /workspace/repo -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 fetch --quiet --depth=1 --no-tags --end-of-options origin ${sha("a")} ${BASE}`,
    ]);
    expect(second.at(-1)).toBe(`git -C /workspace/repo show --end-of-options ${sha("a")}:README.md`);
  });

  it("fails the job when the rebuild fails, without calling the model again", async () => {
    captureLogs();
    const { stub, ref, name } = await cloudSession("workspace", sockets);
    const model = new ScriptedModel();
    readTwice(model);
    useCloudModel(model);
    const container = containerOf(name);
    stopAfterFirstRead(container);
    const serve = container.on;
    let fetches = 0;
    container.on = (argv) => {
      if (argv.includes("fetch")) {
        fetches += 1;
        return fetches === 1 ? undefined : { exitCode: 128, stderr: "fatal: unable to access the repository\n" };
      }
      return serve(argv);
    };

    await push(ref, "a");

    expect(await untilEnded(stub, sha("a"))).toEqual({
      state: "failed",
      failure: `${WORKSPACE_LOST}: fetching the commits failed: fatal: unable to access the repository`,
    });
    expect(model.calls).toHaveLength(2);
  });
});

describe("an aborted turn's rebuild", () => {
  it("is released: the session stops waiting at once, and the Workspace stops the fetch and clears it", async () => {
    captureLogs();
    const { stub, ref, name } = await cloudSession("workspace", sockets);
    useCloudModel(new ScriptedModel());
    const container = containerOf(name);
    const fetch = container.holdNext((argv) => argv.includes("fetch"));

    await push(ref, "a");
    await untilHeld(fetch);
    // As a client's cancel aborts it.
    await runInDurableObject(stub, (instance) => prSessionSeams(instance).abortAllRequests());

    expect(await untilEnded(stub, sha("a"))).toEqual({ state: "failed", failure: "the turn was cancelled" });
    const workspace = env.Workspace.getByName(name);
    await vi.waitFor(
      async () => {
        const held = container.execs.find((exec) => exec.argv.includes("fetch"));
        expect(held?.signal?.aborted).toBe(true);
        expect(held?.kills).toEqual([9]);
      },
      { timeout: 3000, interval: 20 },
    );
    const seq = (await jobRows(stub))[0]?.turn_seq;
    expect(await released(workspace)).toBe(seq);
    expect(await runInDurableObject(workspace, (instance) => workspaceSeams(instance).inFlight())).toBeNull();
  });
});

describe("the release at a turn's end", () => {
  it("is waited for at most 10 s, and the commit does not wait for it", async () => {
    const logs = captureLogs();
    const { stub, ref } = await cloudSession("workspace", sockets);
    useCloudModel(new ScriptedModel().add(answerScript("the summary")));
    const workspace = new FakeWorkspace();
    const release = vi.spyOn(workspace, "release").mockReturnValue(new Promise<void>(() => undefined));
    useWorkspace(workspace);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await push(ref, "a");
    await until(async () => (await jobRows(stub))[0]?.state === "done", "the commit");
    expect(release.mock.calls).toEqual([[(await jobRows(stub))[0]?.turn_seq]]);
    await advance(stub, RELEASE_MS - 1);
    expect(events(logs, "prq.workspace.release_failed")).toEqual([]);
    await advance(stub, 1);

    expect(events(logs, "prq.workspace.release_failed")).toHaveLength(1);
  });
});

async function released(workspace: DurableObjectStub<Workspace>): Promise<number> {
  return runInDurableObject(
    workspace,
    (_, state) =>
      state.storage.sql
        .exec<{ released_through: number }>("SELECT released_through FROM prq_workspace WHERE id = 1")
        .one().released_through,
  );
}

// The session's client over a Workspace whose every call fails as given.
function client(reply: WorkspaceFailure) {
  return workspaceClient({ prepare: async () => reply, run: async () => reply, release: async () => undefined });
}

describe("the session's client", () => {
  const target: WorkspaceTarget = { fullName: "octo/demo", installationId: 7, sha: sha("a"), baseSha: BASE, seq: 1 };
  const command = { argv: ["show"], page: { start: { line: 1, char: 0 }, capChars: 1000 } };

  it("ends the turn when the checkout was lost or the cleanup failed, and returns any other failure as an error", async () => {
    const signal = new AbortController().signal;
    await expect(client({ ok: false, kind: "failed", reason: "x" }).run(target, command, signal)).rejects.toEqual(
      new WorkspaceLost(`${WORKSPACE_LOST}: x`),
    );
    await expect(client({ ok: false, kind: "cleanup", reason: "x" }).run(target, command, signal)).rejects.toEqual(
      new WorkspaceLost(`workspace: ${CLEANUP_FAILED}: x`),
    );
    for (const kind of ["refused", "command"] as const) {
      const failure = await client({ ok: false, kind, reason: "x" })
        .run(target, command, signal)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(WorkspaceLost);
    }
    await expect(client({ ok: false, kind: "cleanup", reason: "x" }).prepare(target, signal)).rejects.toThrow(
      `${CLEANUP_FAILED}: x`,
    );
  });
});
