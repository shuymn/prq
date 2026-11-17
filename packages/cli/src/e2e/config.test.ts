import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { startCli, stderrLines } from "../test/cli.ts";

// The build turns off what a Bun-compiled binary would otherwise load from the directory it runs in: the variables in
// a .env file, and a bunfig.toml, whose preload runs code before prq's own. The .env names a URL nothing listens on, so
// a binary that read it would try to connect instead of stopping at its configuration; the deadline of 0 ends that try.
describe("configuration", () => {
  it("comes only from flags and the environment, not from files in the working directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "prq-cli-"));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(join(cwd, ".env"), "PRQ_URL=http://127.0.0.1:1\n");
    await writeFile(join(cwd, "bunfig.toml"), 'preload = ["./preload.js"]\n');
    await writeFile(
      join(cwd, "preload.js"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("marker", "");\n',
    );
    const env = { HOME: cwd, PRQ_ACCESS_CLIENT_ID: "prq-test-id", PRQ_ACCESS_CLIENT_SECRET: "prq-test-secret" };
    const run = startCli(["wait", "--agent-id", "laptop", "--timeout", "0"], env, cwd);
    onTestFinished(async () => {
      await run.kill();
    });
    const exit = await run.exited;
    expect(exit.code).toBe(1);
    expect(exit.stdout).toBe("");
    expect(stderrLines(exit)).toEqual(["prq: PRQ_URL is not set: set it to the Worker's origin (https://<host>)"]);
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });
});
