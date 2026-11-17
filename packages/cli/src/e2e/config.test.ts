import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stderrLines } from "../test/cli.ts";
import { useStack } from "../test/stack.ts";

const stack = useStack();

// The build turns off what a Bun-compiled binary would otherwise load from the directory it runs in: the variables in
// a .env file, and a bunfig.toml, whose preload runs code before prq's own.
describe("configuration", () => {
  it("comes only from flags and the environment, not from files in the working directory", async () => {
    const cwd = stack.cwd();
    await writeFile(join(cwd, ".env"), `PRQ_URL=${stack.access().url}\n`);
    await writeFile(join(cwd, "bunfig.toml"), 'preload = ["./preload.js"]\n');
    await writeFile(
      join(cwd, "preload.js"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("marker", "");\n',
    );
    const exit = await stack.run(["claim", "--agent-id", "laptop"], { PRQ_URL: undefined });
    expect(exit.code).toBe(1);
    expect(exit.stdout).toBe("");
    expect(stderrLines(exit)).toEqual(["prq: PRQ_URL is not set: set it to the Worker's origin (https://<host>)"]);
    expect(stack.access().log).toEqual([]);
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });
});
