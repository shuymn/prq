// The server's test projects and type checks as they resolve: the Worker's tests never collect the web UI's files, the
// workerd project stops without the UI's build, and `pnpm run typecheck` covers the UI and its build configuration.

import { execFile } from "node:child_process";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createVitest, type TestProject, type Vitest } from "vitest/node";

const SERVER = fileURLToPath(new URL("..", import.meta.url));

// The TypeScript compiler `pnpm run typecheck` runs.
const TSC = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

function listFiles(project: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [TSC, "-p", project, "--listFilesOnly"],
      { cwd: SERVER, timeout: 60_000 },
      (error, stdout) =>
        error === null ? resolve(stdout.split("\n").map((line) => relative(SERVER, line))) : reject(error),
    );
  });
}

describe("the server's test projects", () => {
  let vitest: Vitest;
  let workerd: TestProject;

  beforeAll(async () => {
    vitest = await createVitest("test", { root: SERVER, watch: false }, {}, {});
    const found = vitest.projects.find((project) => project.name === "workerd");
    if (found === undefined) {
      throw new Error("no workerd project");
    }
    workerd = found;
  });
  afterAll(async () => {
    await vitest.close();
  });

  test("the workerd project collects the Worker's tests and none of the web UI's", () => {
    expect(workerd.matchesTestGlob(`${SERVER}src/names.test.ts`)).toBe(true);
    expect(workerd.matchesTestGlob(`${SERVER}src/client/components/AppHeader.test.ts`)).toBe(false);
  });

  test("the workerd project's global setup is the client build's guard", () => {
    const guard = fileURLToPath(new URL("../../cli/src/test/client-build.ts", import.meta.url));
    expect(workerd.config.globalSetup).toContain(guard);
  });
});

describe("the type checks", () => {
  test("cover the web UI and its build", async () => {
    const [worker, node, client] = await Promise.all(
      ["tsconfig.json", "tsconfig.node.json", "tsconfig.client.json"].map(listFiles),
    );
    expect(client).toContain("src/client/main.tsx");
    expect(client).toContain("src/client/components/BrandMark.tsx");
    expect(node).toContain("vite.config.ts");
    expect(node).toContain("build/tokens.ts");
    expect(worker?.filter((file) => file.startsWith("src/client/"))).toEqual([]);
  });

  test("are what `pnpm run typecheck` runs", async () => {
    const { scripts } = (await import("../package.json", { with: { type: "json" } })).default;
    expect(scripts.typecheck).toBe("tsc && tsc -p tsconfig.node.json && tsc -p tsconfig.client.json");
  });
});
