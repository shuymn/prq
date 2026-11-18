import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unstable_getVarsForDev } from "wrangler";

import { FixtureGit, fixtureRoot } from "./git.ts";

// The dev-vars script (dev-vars.ts) run as the package script runs it, on a secrets directory and a repository in the
// OS temp directory, the repository ignoring what this one's .gitignore does. Every value below is a sentinel no
// command may print, nor any line of the private key.

const SCRIPT = fileURLToPath(new URL("dev-vars.ts", import.meta.url));
const GITIGNORE = fileURLToPath(new URL("../../../../.gitignore", import.meta.url));

const { privateKey: PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const MODEL = {
  MODEL_BASE_URL: "https://sentinel-base.example/v1",
  MODEL_API_KEY: "sk-sentinel-api-key-0f9e8d7c6b5a4938",
  MODEL_ID: "sentinel/model-id:7741",
  MODEL_CONTEXT_TOKENS: "200000",
  // Passed through as it is: what a parser could take for a quote, a comment, an escape or an expansion.
  MODEL_NOTE: '  sentinel "quoted" `tick` # not a comment $HOME ${HOME} \\n = end  ',
};
const APP_ID = "918273645";
const INSTALLATION_ID = "5647382910";
const APP_JSON = {
  id: Number(APP_ID),
  client_id: "Iv1.sentinelclientid",
  client_secret: "sentinel-client-secret",
  installation_id: Number(INSTALLATION_ID),
};
const WEBHOOK_SECRET = "sentinel-webhook-secret";
const EXPECTED = {
  ...MODEL,
  GITHUB_APP_ID: APP_ID,
  GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY,
  GITHUB_INSTALLATION_ID: INSTALLATION_ID,
};
// model.env's names as Node's parseEnv gives them (sorted), then the App's.
const WRITTEN = [...Object.keys(MODEL).toSorted(), "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_INSTALLATION_ID"];
// The names the checks read, as status lists them.
const CHECKED = [
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_ID",
  "MODEL_CONTEXT_TOKENS",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_INSTALLATION_ID",
];
// What no output holds: every value but the window, which write prints, and each line of the key.
const SECRETS = [
  ...Object.values(MODEL).filter((value) => value !== MODEL.MODEL_CONTEXT_TOKENS),
  APP_ID,
  INSTALLATION_ID,
  ...PRIVATE_KEY.split("\n").filter((line) => line !== "" && !line.startsWith("-----")),
];

let root: string;
let repo: string;
let secrets: string;
let target: string;
let env: Record<string, string>;

function modelEnv(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => `${name}='${value}'\n`)
    .join("");
}

beforeEach(async () => {
  root = await fixtureRoot("prq-dev-vars-");
  const fixture = await FixtureGit.create(root);
  repo = (await fixture.init("repo")).path;
  await copyFile(GITIGNORE, join(repo, ".gitignore"));
  await mkdir(join(repo, "packages", "server"), { recursive: true });
  target = join(repo, "packages", "server", ".dev.vars");

  secrets = join(root, "secrets");
  await mkdir(join(secrets, "github-app"), { recursive: true });
  await writeFile(join(secrets, "model.env"), modelEnv(MODEL));
  await writeFile(join(secrets, "github-app", "app.json"), JSON.stringify(APP_JSON));
  await writeFile(join(secrets, "github-app", "private-key.pk8.pem"), PRIVATE_KEY);
  await writeFile(join(secrets, "github-app", "webhook-secret"), WEBHOOK_SECRET);

  env = { ...fixture.env, PRQ_DEV_VARS_SECRETS: secrets, PRQ_DEV_VARS_REPOSITORY: repo };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// The script with these arguments: its exit code and output, which holds no secret.
async function devVars(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr });
    });
  });
  const output = result.stdout + result.stderr;
  expect(output).not.toMatch(/sentinel/i);
  for (const secret of [...SECRETS, WEBHOOK_SECRET]) {
    expect(output).not.toContain(secret);
  }
  return result;
}

// The file as wrangler reads it for the Worker (dotenv's parse) and as the checks do (Node's parseEnv), each.
async function written(): Promise<{ wrangler: Record<string, unknown>; node: NodeJS.Dict<string> }> {
  const vars = unstable_getVarsForDev(
    join(repo, "packages", "server", "wrangler.jsonc"),
    undefined,
    {},
    undefined,
    true,
  );
  return {
    wrangler: Object.fromEntries(Object.entries(vars).map(([name, binding]) => [name, binding.value])),
    node: parseEnv(await readFile(target, "utf8")),
  };
}

describe("dev-vars write", () => {
  it("writes what both parsers read back as the secrets, the key byte for byte, and prints only names", async () => {
    const result = await devVars("write");

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe(
      [
        "wrote packages/server/.dev.vars (mode 0600)",
        `variables: ${WRITTEN.join(", ")}`,
        "window: 200000 tokens (model.env)",
        "",
      ].join("\n"),
    );
    const { wrangler, node } = await written();
    expect(wrangler).toStrictEqual(EXPECTED);
    expect(node).toStrictEqual(EXPECTED);
    expect(Buffer.from(String(wrangler["GITHUB_APP_PRIVATE_KEY"]))).toStrictEqual(Buffer.from(PRIVATE_KEY));
  });

  it("leaves only the file, readable by the owner alone, in place of one that was not", async () => {
    await writeFile(target, "STALE=1\n");
    await chmod(target, 0o644);

    expect((await devVars("write")).code).toBe(0);

    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(repo, "packages", "server"))).toStrictEqual([".dev.vars"]);
    expect((await written()).node["STALE"]).toBeUndefined();
  });

  it("takes the window from --window over model.env's, or in place of it", async () => {
    const result = await devVars("write", "--window", "20000");
    expect(result.stdout).toContain("window: 20000 tokens (--window)\n");
    expect((await written()).wrangler["MODEL_CONTEXT_TOKENS"]).toBe("20000");

    const { MODEL_CONTEXT_TOKENS: _window, ...withoutWindow } = MODEL;
    await writeFile(join(secrets, "model.env"), modelEnv(withoutWindow));
    expect(await devVars("write")).toMatchObject({
      code: 1,
      stderr: "dev-vars: model.env does not set MODEL_CONTEXT_TOKENS\n",
    });
    expect((await devVars("write", "--window", "30000")).code).toBe(0);
    expect((await written()).node["MODEL_CONTEXT_TOKENS"]).toBe("30000");
  });

  it.each(["model.env", "github-app/app.json", "github-app/private-key.pk8.pem"])(
    "names a missing %s and writes nothing",
    async (name) => {
      await rm(join(secrets, name));

      expect(await devVars("write")).toMatchObject({
        code: 1,
        stdout: "",
        stderr: `dev-vars: the secrets directory has no ${name}\n`,
      });
      expect(await readdir(join(repo, "packages", "server"))).toStrictEqual([]);
    },
  );

  it("names a variable model.env does not set, and an app.json it cannot read, without their content", async () => {
    const { MODEL_API_KEY: _key, ...withoutKey } = MODEL;
    await writeFile(join(secrets, "model.env"), modelEnv(withoutKey));
    expect(await devVars("write")).toMatchObject({
      code: 1,
      stderr: "dev-vars: model.env does not set MODEL_API_KEY\n",
    });

    await writeFile(join(secrets, "model.env"), modelEnv(MODEL));
    await writeFile(join(secrets, "github-app", "app.json"), "sentinel-client-secret, not JSON");
    expect(await devVars("write")).toMatchObject({ code: 1, stderr: "dev-vars: github-app/app.json is not JSON\n" });
    expect(await readdir(join(repo, "packages", "server"))).toStrictEqual([]);
  });

  it("refuses a value no quoting carries as it is, naming its variable", async () => {
    await writeFile(join(secrets, "model.env"), `${modelEnv(MODEL)}MODEL_ID="sentinel'quote"\n`);
    expect(await devVars("write")).toMatchObject({
      code: 1,
      stderr:
        "dev-vars: MODEL_ID holds a single quote or a carriage return, which packages/server/.dev.vars cannot hold as " +
        "it is\n",
    });

    await writeFile(join(secrets, "model.env"), modelEnv(MODEL));
    await writeFile(join(secrets, "github-app", "private-key.pk8.pem"), PRIVATE_KEY.replaceAll("\n", "\r\n"));
    expect(await devVars("write")).toMatchObject({
      code: 1,
      stderr:
        "dev-vars: GITHUB_APP_PRIVATE_KEY holds a single quote or a carriage return, which packages/server/.dev.vars " +
        "cannot hold as it is\n",
    });
    expect(await readdir(join(repo, "packages", "server"))).toStrictEqual([]);
  });

  it("refuses a target git does not ignore", async () => {
    await writeFile(join(repo, ".gitignore"), "");

    expect(await devVars("write")).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "dev-vars: git does not ignore packages/server/.dev.vars, so it is not written\n",
    });
    expect(await readdir(join(repo, "packages", "server"))).toStrictEqual([]);
  });
});

describe("dev-vars status", () => {
  it("names the expected variables the file sets, and those it does not", async () => {
    expect(await devVars("status")).toMatchObject({ code: 0, stdout: "no packages/server/.dev.vars\n" });

    await devVars("write");
    expect((await devVars("status")).stdout).toBe(`packages/server/.dev.vars exists\nsets: ${CHECKED.join(", ")}\n`);

    await writeFile(target, `MODEL_API_KEY='${MODEL.MODEL_API_KEY}'\nGITHUB_APP_PRIVATE_KEY='${PRIVATE_KEY}'\n`);
    expect((await devVars("status")).stdout).toBe(
      [
        "packages/server/.dev.vars exists",
        "sets: MODEL_API_KEY, GITHUB_APP_PRIVATE_KEY",
        "does not set: MODEL_BASE_URL, MODEL_ID, MODEL_CONTEXT_TOKENS, GITHUB_APP_ID, GITHUB_INSTALLATION_ID",
        "",
      ].join("\n"),
    );
  });
});

describe("dev-vars remove", () => {
  it("deletes the file and an unfinished write's, and says whether the file was there", async () => {
    await devVars("write");
    await writeFile(join(repo, "packages", "server", ".dev.vars.tmp-0123456789abcdef"), modelEnv(MODEL));

    expect(await devVars("remove")).toMatchObject({
      code: 0,
      stdout:
        "removed packages/server/.dev.vars\n" +
        "removed an unfinished write, packages/server/.dev.vars.tmp-0123456789abcdef\n",
    });
    expect(await readdir(join(repo, "packages", "server"))).toStrictEqual([]);

    expect(await devVars("remove")).toMatchObject({ code: 0, stdout: "no packages/server/.dev.vars to remove\n" });
  });
});
