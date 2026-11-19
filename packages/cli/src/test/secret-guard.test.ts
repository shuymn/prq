import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The repository's Claude Code hook (.claude/hooks/secret-guard.ts) run as Claude Code runs it: the hook's JSON on
// stdin, a deny decision or nothing on stdout. Every path below is a name only; no file is read.

const HOOK = fileURLToPath(new URL("../../../../.claude/hooks/secret-guard.ts", import.meta.url));
const DEV_VARS = "packages/server/.dev.vars";
const SECRETS = ".config/prq";
const DENY = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } };

// The hook's decision: its parsed output, or undefined when it printed nothing.
async function decide(tool_name: string, tool_input: Record<string, unknown>): Promise<unknown> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(HOOK, (error, out) => (error ? reject(error) : resolve(out)));
    child.stdin?.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }));
  });
  return stdout === "" ? undefined : JSON.parse(stdout);
}

describe("secret-guard hook", () => {
  it.each([
    `cat ${DEV_VARS}`,
    `cut -d= -f1 ${DEV_VARS}`,
    "cd packages/server && grep KEY .dev.vars",
    `cat ~/${SECRETS}/model.env`,
    `cat $HOME/${SECRETS}/github-app/app.json`,
    `cat "\${HOME}/${SECRETS}/model.env"`,
    `ls ${homedir()}/${SECRETS}/github-app`,
    `cd ~/${SECRETS} && cat model.env`,
    `echo "$(cat ~/${SECRETS}/model.env)" && cat ~/${SECRETS}/model.env`,
  ])("refuses the command %s", async (command) => {
    expect(await decide("Bash", { command })).toMatchObject(DENY);
  });

  it.each([
    `curl -H "Authorization: $(cat ~/${SECRETS}/token)" https://example.com`,
    `some-tool --key "$(< $HOME/${SECRETS}/key.pem)"`,
    "pnpm run dev-vars write --window 20000",
    "pnpm run dev-vars status",
    "pnpm run dev-vars remove",
    `cat ${DEV_VARS}.example`,
    `ls ~/.config/prq-other`,
    "git status",
  ])("lets the command %s through", async (command) => {
    expect(await decide("Bash", { command })).toBeUndefined();
  });

  it.each([
    ["Read", { file_path: `/repo/${DEV_VARS}` }],
    ["Read", { file_path: `${homedir()}/${SECRETS}/model.env` }],
    ["Grep", { pattern: "KEY", path: `/repo/${DEV_VARS}` }],
    ["Grep", { pattern: "KEY", path: `${homedir()}/${SECRETS}` }],
    ["Glob", { pattern: "*", path: `${homedir()}/${SECRETS}/github-app` }],
  ])("refuses %s of %o", async (tool, input) => {
    expect(await decide(tool, input)).toMatchObject(DENY);
  });

  it.each([
    ["Read", { file_path: "/repo/packages/cli/src/test/dev-vars.ts" }],
    ["Grep", { pattern: "dev.vars", path: "/repo/packages" }],
    ["Glob", { pattern: "**/*.ts", path: "/repo" }],
  ])("lets %s of %o through", async (tool, input) => {
    expect(await decide(tool, input)).toBeUndefined();
  });
});
