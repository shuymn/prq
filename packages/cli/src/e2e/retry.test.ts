import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { RETRY_WINDOW_MS } from "../retry.ts";
import { result, stderrLines } from "../test/cli.ts";
import { push, sha } from "../test/pr.ts";
import { useStack } from "../test/stack.ts";

const stack = useStack();
const pr = { owner: "acme", repo: "widgets", number: 7 };

describe("retries", () => {
  it("a 503 to the first wait and the first claim is retried: exit 0, one retry line each", async () => {
    // The agent is present (its wait was a contact), so the pull request's job is local.
    expect((await stack.run(["wait", "--agent-id", "laptop", "--timeout", "0"])).code).toBe(2);
    await push(stack.worker(), pr, sha("h1"));
    stack.access().plan("/cli/wait", { kind: "reply", status: 503 });
    stack.access().plan("/cli/claim", { kind: "reply", status: 503 });

    const waited = await stack.run(["wait", "--agent-id", "laptop", "--timeout", "30"]);
    expect(waited.code).toBe(0);
    expect(result(waited)).toEqual({ status: "ready", next: "claim" });
    expect(stderrLines(waited)).toEqual(["prq: /cli/wait is unavailable (HTTP 503); retrying"]);

    const claimed = await stack.run(["claim", "--agent-id", "laptop"]);
    expect(claimed.code).toBe(0);
    expect(result(claimed)).toMatchObject({ job: { target: { kind: "analysis", headSha: sha("h1") } } });
    expect(stderrLines(claimed)).toEqual(["prq: /cli/claim is unavailable (HTTP 503); retrying"]);
  });

  it("a 503 to the first context and the first submit is retried: exit 0, one retry line each", async () => {
    expect((await stack.run(["wait", "--agent-id", "laptop", "--timeout", "0"])).code).toBe(2);
    await push(stack.worker(), pr, sha("h1"));
    const claimed = await stack.run(["claim", "--agent-id", "laptop"]);
    expect(claimed.code).toBe(0);
    stack.access().plan("/cli/context", { kind: "reply", status: 503 });
    stack.access().plan("/cli/submit", { kind: "reply", status: 503 });

    const context = await stack.run(["context", "--agent-id", "laptop"]);
    expect(context.code).toBe(0);
    expect(result(context)).toMatchObject({ next: "checkout" });
    expect(stderrLines(context)).toEqual(["prq: /cli/context is unavailable (HTTP 503); retrying"]);

    const { dir } = v.parse(v.object({ dir: v.string() }), result(claimed));
    await writeFile(join(dir, "answer.md"), "the summary\n");
    const submitted = await stack.run(["submit", "--agent-id", "laptop"]);
    expect(submitted.code).toBe(0);
    expect(result(submitted)).toMatchObject({ status: "accepted" });
    expect(stderrLines(submitted)).toEqual(["prq: /cli/submit is unavailable (HTTP 503); retrying"]);
  });

  it(
    "a claim answered 503 every time ends with exit 1, no attempt later than the window",
    async () => {
      stack.access().always("/cli/claim", { kind: "reply", status: 503 });
      const exit = await stack.run(["claim", "--agent-id", "laptop"]);
      expect(exit.code).toBe(1);
      expect(exit.stdout).toBe("");
      expect(stderrLines(exit)).toEqual([
        "prq: /cli/claim is unavailable (HTTP 503); retrying",
        "prq: the server is unavailable (HTTP 503); try again",
      ]);
      const starts = stack.access().log.map((entry) => entry.at);
      const first = starts[0] ?? 0;
      const last = starts.at(-1) ?? 0;
      expect(starts.length).toBeGreaterThan(2);
      expect(last - first).toBeLessThanOrEqual(RETRY_WINDOW_MS);
    },
    RETRY_WINDOW_MS + 30_000,
  );
});
