import { describe, expect, it } from "vitest";

import type { Mode } from "../test/access.ts";
import { result, stderrLines } from "../test/cli.ts";
import { useStack } from "../test/stack.ts";

const stack = useStack();

const AUTH_LINE =
  /^prq: authentication failed \(HTTP (302|401|403) from \/cli\/(wait|claim)\); check PRQ_ACCESS_CLIENT_ID and PRQ_ACCESS_CLIENT_SECRET$/;

const failures: { mode: Exclude<Mode, "forward">; status: number }[] = [
  // What Access may answer for a bad service token.
  { mode: "forbid", status: 403 },
  { mode: "redirect", status: 302 },
  // A token the Worker refuses itself.
  { mode: "expired", status: 401 },
];

describe("authentication failures", () => {
  for (const command of [["wait", "--timeout", "30"], ["claim"]]) {
    for (const { mode, status } of failures) {
      it(`prq ${command[0]}: ${status} is exit 3 with one stderr line, not retried`, async () => {
        stack.access().mode = mode;
        const exit = await stack.run([...command, "--agent-id", "laptop"]);
        expect(exit.code).toBe(3);
        expect(exit.stdout).toBe("");
        expect(stderrLines(exit)).toHaveLength(1);
        expect(stderrLines(exit)[0]).toMatch(AUTH_LINE);
        expect(stderrLines(exit)[0]).toContain(`HTTP ${status}`);
        expect(stack.access().log.map((entry) => entry.status)).toEqual([status]);
      });
    }

    it(`prq ${command[0]}: no service token is exit 3 before any request`, async () => {
      const exit = await stack.run([...command, "--agent-id", "laptop"], { PRQ_ACCESS_CLIENT_SECRET: undefined });
      expect(exit.code).toBe(3);
      expect(exit.stdout).toBe("");
      expect(stderrLines(exit)).toEqual([
        "prq: no service token: set PRQ_ACCESS_CLIENT_ID and PRQ_ACCESS_CLIENT_SECRET",
      ]);
      expect(stack.access().log).toEqual([]);
    });
  }

  it("the Worker's 401 with another version: the version notice, then the one authentication line", async () => {
    stack.access().mode = "expired";
    stack.access().serverVersion = "v9.9.9";
    const exit = await stack.run(["claim", "--agent-id", "laptop"]);
    expect(exit.code).toBe(3);
    expect(exit.stdout).toBe("");
    expect(stderrLines(exit)).toEqual([
      `prq: prq ${stack.worker().version} talks to a v9.9.9 server; update prq if a command fails`,
      "prq: authentication failed (HTTP 401 from /cli/claim); check PRQ_ACCESS_CLIENT_ID and PRQ_ACCESS_CLIENT_SECRET",
    ]);
  });

  it("keys unavailable: the Worker's 503 is retried, not exit 3", async () => {
    stack.worker().failKeys(2);
    const exit = await stack.run(["claim", "--agent-id", "laptop"]);
    expect(exit.code).toBe(0);
    expect(result(exit)).toEqual({ job: null, next: "wait" });
    expect(stack.access().log.map((entry) => entry.status)).toEqual([503, 503, 200]);
    expect(stack.worker().keyFetches()).toBe(3);
    expect(stderrLines(exit)).toEqual(["prq: /cli/claim is unavailable (HTTP 503); retrying"]);
  });
});
