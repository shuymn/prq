import { describe, expect, it } from "vitest";

import { result, stderrLines } from "../test/cli.ts";
import { latch } from "../test/latch.ts";
import { push, sha } from "../test/pr.ts";
import { useStack } from "../test/stack.ts";

const stack = useStack();
const pr = { owner: "acme", repo: "widgets", number: 7 };

describe("prq wait", () => {
  it("interrupted after the notify: the next wait is ready and the claim returns the job", async () => {
    const answered = latch();
    const release = latch();
    stack.access().plan("/cli/wait", { kind: "hold", answered, release });
    const first = stack.start(["wait", "--agent-id", "laptop", "--timeout", "60"]);
    await stack.waiting("laptop");

    // The job notifies the Hub, which answers the wait in flight; the stand-in holds that answer from the CLI.
    await push(stack.worker(), pr, sha("h1"));
    await answered.promise;
    const killed = await first.kill();
    expect(killed.signal).toBe("SIGKILL");
    expect(killed.stdout).toBe("");
    release.open();

    const next = await stack.run(["wait", "--agent-id", "laptop", "--timeout", "5"]);
    expect(next.code).toBe(0);
    expect(result(next)).toEqual({ status: "ready", next: "claim" });
    const claimed = await stack.run(["claim", "--agent-id", "laptop"]);
    expect(claimed.code).toBe(0);
    expect(result(claimed)).toMatchObject({
      job: { pr, run: 1, target: { kind: "analysis", headSha: sha("h1") }, workspaceSha: sha("h1") },
      resumed: false,
    });
  });

  it("killed before the notify: the next wait is ready and the claim returns the job", async () => {
    const first = stack.start(["wait", "--agent-id", "laptop", "--timeout", "60"]);
    await stack.waiting("laptop");
    await first.kill();

    await push(stack.worker(), pr, sha("h1"));
    const next = await stack.run(["wait", "--agent-id", "laptop", "--timeout", "5"]);
    expect(next.code).toBe(0);
    expect(result(next)).toEqual({ status: "ready", next: "claim" });
    const claimed = await stack.run(["claim", "--agent-id", "laptop"]);
    expect(result(claimed)).toMatchObject({ job: { target: { kind: "analysis", headSha: sha("h1") } } });
  });

  it("reconnects after a drop: a new wait answers ready in the same process", async () => {
    stack.access().plan("/cli/wait", { kind: "drop" });
    const run = stack.start(["wait", "--agent-id", "laptop", "--timeout", "60"]);
    await stack.waiting("laptop");
    await push(stack.worker(), pr, sha("h1"));

    const exit = await run.exited;
    expect(exit.code).toBe(0);
    expect(result(exit)).toEqual({ status: "ready", next: "claim" });
    const waits = stack.access().log.filter((entry) => entry.route === "/cli/wait");
    expect(waits.map((entry) => entry.status)).toEqual([200, 200]);
  });

  it("times out after an answered poll: exit 2, and only /cli/wait was called", async () => {
    const exit = await stack.run(["wait", "--agent-id", "laptop", "--timeout", "1"]);
    expect(exit.code).toBe(2);
    expect(result(exit)).toEqual({ status: "timeout", next: "wait" });
    expect(exit.stderr).toBe("");
    expect(new Set(stack.access().log.map((entry) => entry.route))).toEqual(new Set(["/cli/wait"]));
  });

  it("unavailable until the deadline: exit 1, nothing on stdout", async () => {
    stack.access().always("/cli/wait", { kind: "reply", status: 503 });
    const exit = await stack.run(["wait", "--agent-id", "laptop", "--timeout", "3"]);
    expect(exit.code).toBe(1);
    expect(exit.stdout).toBe("");
    expect(stderrLines(exit).at(-1)).toMatch(/^prq: the server was unavailable until the wait's deadline/);
    expect(stack.access().log.length).toBeGreaterThan(1);
  });

  it("rejects a malformed answer: exit 1 naming the route, nothing on stdout", async () => {
    stack.access().plan("/cli/wait", { kind: "body", body: '{"status":"maybe"}' });
    const exit = await stack.run(["wait", "--agent-id", "laptop", "--timeout", "1"]);
    expect(exit.code).toBe(1);
    expect(exit.stdout).toBe("");
    expect(stderrLines(exit)).toEqual(["prq: /cli/wait answered 200 with a body that is not its answer"]);
  });
});
