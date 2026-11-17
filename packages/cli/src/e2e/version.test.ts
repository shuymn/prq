import { describe, expect, it } from "vitest";

import { stderrLines } from "../test/cli.ts";
import { useStack } from "../test/stack.ts";

const stack = useStack();

const NOTICE = /talks to a .* server; update prq if a command fails$/;

function notices(stderr: string[]): string[] {
  return stderr.filter((line) => NOTICE.test(line));
}

// Three responses to one wait: two 503s, then the timeout of the poll the backoff left room for.
async function waitThroughTwo503s(env: Record<string, string> = {}) {
  stack.access().log.length = 0;
  stack.access().plan("/cli/wait", { kind: "reply", status: 503 }, { kind: "reply", status: 503 });
  const exit = await stack.run(["wait", "--agent-id", "laptop", "--timeout", "4"], env);
  expect(stack.access().log.map((entry) => entry.status)).toEqual([503, 503, 200]);
  return exit;
}

describe("the version notice", () => {
  it("one line per invocation however many responses differ, stdout and exit unchanged", async () => {
    const plain = await waitThroughTwo503s();
    expect(notices(stderrLines(plain))).toEqual([]);

    stack.access().serverVersion = "v9.9.9";
    const differing = await waitThroughTwo503s();
    expect(notices(stderrLines(differing))).toEqual([
      `prq: prq ${stack.worker().version} talks to a v9.9.9 server; update prq if a command fails`,
    ]);
    expect(differing.stdout).toBe(plain.stdout);
    expect(differing.code).toBe(plain.code);
  });

  it("none with PRQ_VERSION_NOTICE=0", async () => {
    stack.access().serverVersion = "v9.9.9";
    const exit = await waitThroughTwo503s({ PRQ_VERSION_NOTICE: "0" });
    expect(notices(stderrLines(exit))).toEqual([]);
    expect(exit.code).toBe(2);
  });

  it("none for a response without the header", async () => {
    stack.access().serverVersion = "v9.9.9";
    stack.access().mode = "forbid";
    const exit = await stack.run(["claim", "--agent-id", "laptop"]);
    expect(exit.code).toBe(3);
    expect(notices(stderrLines(exit))).toEqual([]);
  });
});
