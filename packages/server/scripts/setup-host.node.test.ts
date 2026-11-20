// The host's setup steps (setup-host.ts, run by setup.ts) through the tests' entry (test-entry.ts), whose fixture gives
// them a deploy directory in the OS temp directory, a local stand-in for DeepSeek's models list, and the GitHub stand-in
// (github-stand-in.ts) for the GitHub App step, which setup-github-app.node.test.ts tests on its own. Runs get a terminal
// from python3's pty module (as the deploy's tests get one), where the [y/N] questions and the key are answered. Every
// key below is a sentinel no output may hold. Nothing reaches the network.

import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type * as v from "valibot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fixtureRoot } from "../../cli/src/test/git.ts";
import type { Fixture } from "./fixture.ts";
import { type StandIn, startGitHub } from "./github-stand-in.ts";

const TEST_ENTRY = fileURLToPath(new URL("test-entry.ts", import.meta.url));
const MODEL_KEY = "sk-sentinel-deepseek-4b1d9e2a";
const NEW_KEY = "sk-sentinel-replacement-77aa1c";
const APP_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;
// worker.env's secrets other than the model's, each a sentinel.
const OTHERS = [
  "ACCESS_TEAM_DOMAIN=https://sentinel-team.example",
  "ACCESS_AUD=sentinel-aud-5e3c0b9a7d1f4e2a",
  "WEBHOOK_SECRET=sentinel-webhook-secret-81f2",
  "HOST_GITHUB_ID=7340021",
  "GITHUB_APP_ID=918273645",
];
const MODEL_LINES = (key: string) => [
  "MODEL_BASE_URL=https://api.deepseek.com",
  `MODEL_API_KEY=${key}`,
  "MODEL_ID=deepseek-flash",
  "MODEL_CONTEXT_TOKENS=1048576",
];
const TARGET = "CLOUDFLARE_ACCOUNT_ID=5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e\nPRQ_HOST=prq.example.com\n";
const ACCESS =
  "PRQ_URL=https://prq.example.com\nPRQ_ACCESS_CLIENT_ID=id.access\nPRQ_ACCESS_CLIENT_SECRET=sentinel-client-secret\n";
const keyLines = (key: string) => key.split("\n").filter((line) => line !== "" && !line.startsWith("-----"));
const SENTINELS = [
  "LSCAUSEDNOECHO",
  MODEL_KEY,
  NEW_KEY,
  ...OTHERS.map((line) => line.slice(line.indexOf("=") + 1)).filter((value) => value.includes("sentinel")),
  ...keyLines(APP_KEY),
  "sentinel-client-secret",
];
const KEY_PROMPT = "DeepSeek API key (not shown): ";
// A value pasted where a name goes, whose part before its padding reads as a name.
const PADDED = "LSCAUSEDNOECHO==";

// A pseudo-terminal for a run, from the machine's python3: the umask given first, then the command.
const IN_TERMINAL = [
  "import os, pty, sys",
  "os.umask(int(sys.argv[1], 8))",
  "code = os.waitstatus_to_exitcode(pty.spawn(sys.argv[2:]))",
  "sys.exit(code if code >= 0 else 128 - code)",
].join("\n");
// The command, then the terminal's settings as stty prints them, in the same terminal; the command's exit status.
const THEN_STTY = ['"$@"; status=$?; stty -a; exit $status', "sh"];

// DeepSeek's models list as the stand-in answers it: the keys it takes, the models it lists, and each request's
// Authorization header.
type DeepSeek = { keys: string[]; models: string[]; requests: string[] };
let deepseek: DeepSeek;
let server: Server;
let origin: string;
let root: string;
let directory: string;
let env: Record<string, string>;
let github: StandIn;
let programs: { gh: string; open: string };
const started: ChildProcess[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    deepseek.requests.push(request.headers.authorization ?? "");
    const key = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    if (request.url !== "/models") {
      response.writeHead(404).end();
    } else if (!deepseek.keys.includes(key)) {
      response.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"invalid key"}}');
    } else {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ object: "list", data: deepseek.models.map((id) => ({ id, object: "model" })) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  github = await startGitHub();
  // macOS checks python3 on its first run, which can take seconds.
  await new Promise<void>((resolve) => {
    execFile("python3", ["-I", "-S", "-c", "pass"], { timeout: 60_000 }, () => resolve());
  });
}, 120_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await github.close();
});

beforeEach(async () => {
  root = await fixtureRoot("prq-setup-host-");
  directory = join(root, "config", "deploy");
  deepseek = { keys: [MODEL_KEY, NEW_KEY], models: ["deepseek-flash", "deepseek-pro"], requests: [] };
  env = { PATH: process.env["PATH"] ?? "", HOME: root, TERM: "xterm" };
  github.reset();
  programs = await github.programs(root);
});

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await rm(root, { recursive: true, force: true });
});

type Result = { code: number | null; output: string };
type Run = {
  terminal?: boolean;
  // What to type once the output shows each prompt, in turn, as typed (a reply ends with "\r" to enter it).
  turns?: [string, string][];
  umask?: string;
  stty?: boolean;
  // A signal to the setup's own process once the output shows this prompt, or once the check holds.
  signalAt?: [string, NodeJS.Signals];
  signalWhen?: [() => Promise<boolean>, NodeJS.Signals];
  // How long a write holds its temporary file before the rename.
  holdMs?: number;
};

// The setup with these arguments, in a terminal unless told otherwise. Its output never holds a sentinel.
async function setup(
  args: string[],
  { terminal = true, turns = [], umask = "022", stty = false, signalAt, signalWhen, holdMs }: Run = {},
): Promise<Result> {
  const file = join(root, "fixture.json");
  // wrangler in place: a program that fails, so that the cloudflare step stops where it is not recorded (its own
  // tests, setup-cloudflare.node.test.ts, give it stand-ins).
  const settings: v.InferOutput<typeof Fixture> = {
    directory,
    modelApi: origin,
    waitMs: 15_000,
    stateDir: join(root, "state"),
    githubApi: `${github.origin}/api`,
    githubWeb: `${github.origin}/web`,
    gh: programs.gh,
    open: programs.open,
    childEnv: { PRQ_GITHUB_STAND_IN: github.origin },
    wrangler: "false",
    ...(holdMs === undefined ? {} : { holdMs }),
  };
  writeFileSync(file, JSON.stringify(settings));
  const command = [process.execPath, TEST_ENTRY, file, "setup", ...args];
  const inShell = stty ? ["/bin/sh", "-c", ...THEN_STTY, ...command] : command;
  const argv = terminal ? ["python3", "-I", "-S", "-c", IN_TERMINAL, umask, ...inShell] : command;
  const child = spawn(argv[0] ?? "", argv.slice(1), { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  started.push(child);
  let output = "";
  let from = 0;
  let turn = 0;
  let signalled = false;
  const read = (chunk: string) => {
    output += chunk;
    for (;;) {
      const next = turns[turn];
      const at = next === undefined ? -1 : output.indexOf(next[0], from);
      if (next === undefined || at === -1) {
        break;
      }
      from = at + next[0].length;
      turn += 1;
      child.stdin.write(next[1]);
    }
    if (signalAt !== undefined && !signalled && output.includes(signalAt[0])) {
      signalled = true;
      process.kill(setupPid(file), signalAt[1]);
    }
  };
  child.stdout.setEncoding("utf8").on("data", read);
  child.stderr.setEncoding("utf8").on("data", read);
  const poll =
    signalWhen === undefined
      ? undefined
      : setInterval(() => {
          void signalWhen[0]().then((holds) => {
            if (holds && !signalled) {
              signalled = true;
              process.kill(setupPid(file), signalWhen[1]);
            }
          });
        }, 20);
  const result = await new Promise<Result>((resolve) => {
    child.on("close", (code) => resolve({ code, output: output.replaceAll("\r\n", "\n") }));
  });
  clearInterval(poll);
  child.stdin.destroy();
  for (const sentinel of SENTINELS) {
    expect(result.output).not.toContain(sentinel);
  }
  return result;
}

// The setup's node process, found by its fixture file among its arguments.
function setupPid(file: string): number {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", timeout: 10_000 }).stdout ?? "";
  for (const line of listed.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match?.[2]?.startsWith(process.execPath) === true && match[2].includes(file)) {
      return Number(match[1]);
    }
  }
  throw new Error("the setup's process was not found");
}

async function writePrivateFile(name: string, text: string, mode = 0o600): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, name), text, { mode });
  await chmod(join(directory, name), mode);
}

async function readWorkerEnv(): Promise<string> {
  return readFile(join(directory, "worker.env"), "utf8");
}

// The App worker.env and the key file record, as GitHub's stand-in has it: installed on the test repository the setup's
// state file records.
async function recordedApp(): Promise<void> {
  await writePrivateFile("github-app.pk8.pem", APP_KEY);
  await writePrivateFile("target.env", TARGET);
  github.addApp({ id: 918273645, name: "octo-host-prq", publicKey: createPublicKey(APP_KEY) }, [
    { full_name: "octo-host/prq-test", private: true },
  ]);
  await mkdir(join(root, "state"), { mode: 0o700 });
  await writeFile(join(root, "state", "setup.json"), '{"githubApp":{"testRepository":"octo-host/prq-test"}}', {
    mode: 0o600,
  });
}

// A complete deploy directory but the model's lines (the cloudflare step's recorded).
async function completeButModel(): Promise<void> {
  await writePrivateFile("worker.env", `${OTHERS.join("\n")}\n`);
  await recordedApp();
  await writePrivateFile("access.env", ACCESS);
}

// Adds an access control list entry that grants nothing the mode shows: macOS's chmod +a, or setfacl elsewhere with a
// mask that keeps the group bits clear. False when the machine has neither.
function addAcl(path: string, isDirectory: boolean): boolean {
  if (process.platform === "darwin") {
    const entry = isDirectory ? "everyone allow list" : "everyone allow read";
    return spawnSync("chmod", ["+a", entry, path]).status === 0;
  }
  return spawnSync("setfacl", ["-m", "u:nobody:r,m::-", path]).status === 0;
}
const ACL_FIX = process.platform === "darwin" ? "chmod -N" : "setfacl -b";
const canAcl = process.platform === "darwin" || spawnSync("setfacl", ["--version"]).status === 0;

describe("setup without a step", () => {
  it("runs the host's steps in order and passes a complete directory, then does nothing on a re-run", async () => {
    await completeButModel();

    const first = await setup([], { turns: [[KEY_PROMPT, `${MODEL_KEY}\r`]] });

    expect(first.code).toBe(0);
    const lines = first.output.split("\n");
    const order = [
      "setup: the host's steps",
      "directory: done",
      "cloudflare: done (recorded",
      "github-app: done",
      "model: done",
      "check: done",
      "setup: done",
    ].map((text) => lines.findIndex((line) => line.startsWith(text)));
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(order).not.toContain(-1);
    expect(first.output).toContain(
      "setup: the publisher's steps run only when named: setup repository, setup rehearsal",
    );
    expect(first.output).toContain(
      "cloudflare: done (recorded in target.env, worker.env and access.env; setup cloudflare checks them",
    );
    expect(first.output).not.toContain("Cloudflare API token");
    expect(first.output).toContain(
      "model: wrote MODEL_BASE_URL, MODEL_API_KEY, MODEL_ID, MODEL_CONTEXT_TOKENS to worker.env",
    );
    expect(await readWorkerEnv()).toBe(`${[...OTHERS, ...MODEL_LINES(MODEL_KEY)].join("\n")}\n`);
    expect(deepseek.requests).toEqual([`Bearer ${MODEL_KEY}`]);
    const written = await readWorkerEnv();
    deepseek.requests = [];

    const again = await setup([]);

    expect(again.code).toBe(0);
    expect(again.output).not.toContain(KEY_PROMPT);
    expect(again.output).not.toContain("model: wrote");
    expect(again.output).toContain(`directory: ${directory}: pass`);
    expect(again.output).toContain("model: done");
    expect(await readWorkerEnv()).toBe(written);
    expect(deepseek.requests).toEqual([`Bearer ${MODEL_KEY}`]);
  });

  it("creates the directory and the file with exact owner bits under any umask, and skips the check after cloudflare and the App's step stop", async () => {
    const result = await setup([], {
      turns: [
        ["The hostname prq will serve", "\r"],
        [KEY_PROMPT, `${MODEL_KEY}\r`],
      ],
      umask: "277",
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain(`directory: created ${directory} (0700)`);
    expect(result.output).toContain("cloudflare: wrangler whoami failed");
    expect(result.output).toContain("github-app: that is not a hostname; nothing was written");
    expect(result.output).toContain("model: done");
    expect(result.output).toContain("check: skipped (it needs cloudflare, which stopped)");
    expect(result.output).toContain(
      "setup: stopped: cloudflare, github-app, check; fix what the first one says, then run setup again",
    );
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "config"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "worker.env"))).mode & 0o777).toBe(0o600);
  });

  it("makes the App's state directory and file with exact owner bits under any umask", async () => {
    const result = await setup([], {
      turns: [
        ["The hostname prq will serve", "prq.example.com\r"],
        ["The private test repository (owner/name): ", "octo-host/prq-test\r"],
        [KEY_PROMPT, `${MODEL_KEY}\r`],
      ],
      umask: "277",
    });

    expect(result.output).toContain("github-app: done");
    expect(result.output).toContain("model: done");
    expect((await stat(join(root, "state"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "state", "setup.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "target.env"))).mode & 0o777).toBe(0o600);
  });

  it("stops the App's step on a state file it cannot write, runs the model's, and skips the check", async () => {
    await writePrivateFile("target.env", TARGET);
    await mkdir(join(root, "state"), { mode: 0o500 });

    const result = await setup([], { turns: [[KEY_PROMPT, `${MODEL_KEY}\r`]] });

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/github-app: could not write setup\.json in .+ \(EACCES\); it is as it was/);
    expect(result.output).toContain("model: done");
    expect(result.output).toContain(
      "setup: stopped: cloudflare, github-app, check; fix what the first one says, then run setup again",
    );
    expect(await readdir(join(root, "state"))).toEqual([]);
    expect(github.state().opened).toEqual([]);
  });

  it("runs the cloudflare step when access.env holds an empty credential", async () => {
    await completeButModel();
    await writePrivateFile("access.env", ACCESS.replace("PRQ_ACCESS_CLIENT_ID=id.access", "PRQ_ACCESS_CLIENT_ID="));

    const result = await setup([], { turns: [[KEY_PROMPT, `${MODEL_KEY}\r`]] });

    expect(result.output).not.toContain("cloudflare: done");
    expect(result.output).toContain("cloudflare: wrangler whoami failed");
  });

  it.each([
    ["CI", { CI: "true" }, "setup: the environment marks this run as CI (CI), where nobody answers"],
    ["an override", { PRQ_DEPLOY_X: "1" }, "setup: the environment sets PRQ_DEPLOY_X"],
  ])("refuses %s before anything", async (_what, marks, refusal) => {
    Object.assign(env, marks);

    const result = await setup([]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(refusal);
    await expect(lstat(directory)).rejects.toThrow("ENOENT");
  });
});

describe("setup directory", () => {
  it.each([
    [
      "the directory open to others",
      async () => {
        await mkdir(directory, { recursive: true });
        await chmod(directory, 0o755);
      },
      () => "the deploy directory is open to others than its owner (mode 0755): chmod 700 it",
    ],
    [
      "the directory as a symbolic link",
      async () => {
        await mkdir(join(root, "elsewhere"), { mode: 0o700 });
        await mkdir(join(root, "config"));
        await symlink(join(root, "elsewhere"), directory);
      },
      () => "the deploy directory is a symbolic link",
    ],
    [
      "a file open to others",
      async () => {
        await writePrivateFile("worker.env", "", 0o644);
      },
      () => `${join(directory, "worker.env")} is open to others than its owner (mode 0644): chmod 600 it`,
    ],
    [
      "a file as a symbolic link",
      async () => {
        await writePrivateFile("elsewhere", "");
        await symlink(join(directory, "elsewhere"), join(directory, "worker.env"));
      },
      () => `${join(directory, "worker.env")} is a symbolic link`,
    ],
  ])("refuses %s", async (_what, arrange, refusal) => {
    await arrange();

    const result = await setup(["directory"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`setup: ${refusal()}`);
  });

  it.runIf(canAcl).each([
    ["the directory", true],
    ["a file", false],
  ])("refuses an access control list on %s", async (_what, onDirectory) => {
    await writePrivateFile("worker.env", "");
    const path = onDirectory ? directory : join(directory, "worker.env");
    expect(addAcl(path, onDirectory)).toBe(true);

    const result = await setup(["directory"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `setup: ${path} has an access control list, which can let others read it: ${ACL_FIX} it`,
    );
  });
});

describe("setup model", () => {
  it("asks for the key without echo, checks it with DeepSeek, and writes 0600 under any umask", async () => {
    const result = await setup(["model"], { turns: [[KEY_PROMPT, `${MODEL_KEY}\r`]], umask: "000" });

    expect(result.code).toBe(0);
    expect(result.output).toContain("https://platform.deepseek.com/api_keys");
    expect(result.output).toContain("model: DeepSeek takes the key and lists deepseek-flash");
    expect(deepseek.requests).toEqual([`Bearer ${MODEL_KEY}`]);
    expect(await readWorkerEnv()).toBe(`${MODEL_LINES(MODEL_KEY).join("\n")}\n`);
    expect((await stat(join(directory, "worker.env"))).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["worker.env"]);
  });

  it("keeps the file's other lines and comments in place, and replaces it whole", async () => {
    const before = `# prq\n${OTHERS.join("\n")}\n`;
    await writePrivateFile("worker.env", before);
    const old = await stat(join(directory, "worker.env"));

    const result = await setup(["model"], { turns: [[KEY_PROMPT, `${MODEL_KEY}\r`]] });

    expect(result.code).toBe(0);
    expect(await readWorkerEnv()).toBe(`${before}${MODEL_LINES(MODEL_KEY).join("\n")}\n`);
    expect((await stat(join(directory, "worker.env"))).ino).not.toBe(old.ino);
    expect(await readdir(directory)).toEqual(["worker.env"]);
  });

  it("asks before replacing a key DeepSeek refuses, and replaces only that line on yes", async () => {
    const before = `${MODEL_LINES("sk-sentinel-revoked").join("\n")}\n${OTHERS.join("\n")}\n`;
    await writePrivateFile("worker.env", before);
    SENTINELS.push("sk-sentinel-revoked");

    const result = await setup(["model"], {
      turns: [
        [KEY_PROMPT, `${NEW_KEY}\r`],
        ["Replace MODEL_API_KEY in worker.env? [y/N] ", "y\r"],
      ],
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain("model: DeepSeek refuses the MODEL_API_KEY in worker.env");
    expect(result.output).toContain("Replace MODEL_API_KEY in worker.env? [y/N] ");
    expect(result.output).toContain("model: wrote MODEL_API_KEY to worker.env");
    expect(await readWorkerEnv()).toBe(before.replace("sk-sentinel-revoked", NEW_KEY));
    expect(deepseek.requests).toEqual(["Bearer sk-sentinel-revoked", `Bearer ${NEW_KEY}`]);
  });

  it("writes nothing when the replacement is declined, and stops the check", async () => {
    const before = `${[...OTHERS, ...MODEL_LINES("sk-sentinel-revoked")].join("\n")}\n`;
    await writePrivateFile("worker.env", before);
    await recordedApp();
    await writePrivateFile("access.env", ACCESS);
    SENTINELS.push("sk-sentinel-revoked");

    const result = await setup([], {
      turns: [
        [KEY_PROMPT, `${NEW_KEY}\r`],
        ["Replace MODEL_API_KEY in worker.env? [y/N] ", "n\r"],
      ],
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain("model: kept MODEL_API_KEY in worker.env; nothing was written");
    expect(result.output).toContain("check: skipped (it needs model, which stopped)");
    expect(result.output).toContain("setup: stopped: model, check;");
    expect(await readWorkerEnv()).toBe(before);
  });

  it.each([
    [
      "a name set twice",
      "MODEL_ID=model-one\nMODEL_ID=model-two\n",
      "worker.env sets a name twice (MODEL_ID, line 1 and line 2)",
    ],
    [
      "a padded value pasted twice where a name goes",
      `MODEL_ID=model-one\n${PADDED}\n${PADDED}\n`,
      "worker.env sets a name twice (line 2 and line 3)",
    ],
    ["a line Node reads under another name", "export\tMODEL_ID=model-one\n", "line 1 of worker.env is not NAME=value"],
    [
      "a value spanning lines",
      'MODEL_ID="model-one\nmodel-two"\n',
      "worker.env sets a value that spans lines (MODEL_ID, line 1)",
    ],
    ["a line that is not NAME=value", `MODEL_ID=model-one\n${MODEL_KEY}\n`, "line 2 of worker.env is not NAME=value"],
  ])("refuses %s before asking or sending anything", async (_what, text, refusal) => {
    await writePrivateFile("worker.env", text);

    const result = await setup(["model"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`setup: ${refusal}`);
    expect(result.output).not.toContain(KEY_PROMPT);
    expect(deepseek.requests).toEqual([]);
    expect(await readWorkerEnv()).toBe(text);
  });

  it("sends a stored key nowhere when MODEL_BASE_URL names another provider", async () => {
    const before = `MODEL_BASE_URL=https://sentinel-model.example/v1\nMODEL_API_KEY=${MODEL_KEY}\n`;
    await writePrivateFile("worker.env", before);

    const result = await setup(["model"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain(
      "model: skipped (MODEL_BASE_URL names another provider than https://api.deepseek.com",
    );
    expect(deepseek.requests).toEqual([]);
  });

  it("sends a stored key nowhere without MODEL_BASE_URL", async () => {
    await writePrivateFile("worker.env", `MODEL_API_KEY=${MODEL_KEY}\n`);

    const result = await setup(["model"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: worker.env sets MODEL_API_KEY without MODEL_BASE_URL");
    expect(deepseek.requests).toEqual([]);
  });

  it.each([
    ["DeepSeek refuses the key", () => (deepseek.keys = []), "setup: DeepSeek refused the key; nothing was written"],
    [
      "DeepSeek does not list the model",
      () => (deepseek.models = ["deepseek-pro"]),
      "setup: DeepSeek does not list the model deepseek-flash for the key; nothing was written",
    ],
  ])("writes nothing when %s", async (_what, arrange, refusal) => {
    arrange();

    const result = await setup(["model"], { turns: [[KEY_PROMPT, `${MODEL_KEY}\r`]] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(refusal);
    await expect(lstat(join(directory, "worker.env"))).rejects.toThrow("ENOENT");
  });

  it("refuses to ask for the key without a terminal", async () => {
    const result = await setup(["model"], { terminal: false });

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "setup: DeepSeek API key (not shown) is asked on a terminal, where it does not show",
    );
    expect(deepseek.requests).toEqual([]);
  });

  it.each([
    ["Ctrl-C", { turns: [[KEY_PROMPT, "sk-part\u0003"]] as [string, string][] }, 130],
    [
      "SIGTERM",
      {
        turns: [[KEY_PROMPT, "sk-part"]] as [string, string][],
        signalAt: [KEY_PROMPT, "SIGTERM"] as [string, NodeJS.Signals],
      },
      143,
    ],
    [
      "SIGQUIT",
      {
        turns: [[KEY_PROMPT, "sk-part"]] as [string, string][],
        signalAt: [KEY_PROMPT, "SIGQUIT"] as [string, NodeJS.Signals],
      },
      131,
    ],
  ])("restores the terminal after %s at the key, and writes nothing", async (_what, run, code) => {
    SENTINELS.push("sk-part");

    const result = await setup(["model"], { ...run, stty: true });

    expect(result.code).toBe(code);
    const settings = result.output.slice(result.output.indexOf(KEY_PROMPT));
    expect(settings).toMatch(/(^|\s)echo(\s|$)/m);
    expect(settings).toMatch(/(^|\s)icanon(\s|$)/m);
    expect(settings).not.toMatch(/(^|\s)-echo(\s|$)/m);
    expect(deepseek.requests).toEqual([]);
    await expect(lstat(join(directory, "worker.env"))).rejects.toThrow("ENOENT");
  });
});

describe("setup model writing", () => {
  it("removes its temporary file when SIGTERM stops the write before the rename", async () => {
    const before = `${OTHERS.join("\n")}\n`;
    await writePrivateFile("worker.env", before);
    const temporary = async () => (await readdir(directory)).some((entry) => entry.startsWith(".worker.env."));

    const result = await setup(["model"], {
      turns: [[KEY_PROMPT, `${MODEL_KEY}\r`]],
      holdMs: 10_000,
      signalWhen: [temporary, "SIGTERM"],
    });

    expect(result.code).toBe(143);
    expect(await readWorkerEnv()).toBe(before);
    expect(await readdir(directory)).toEqual(["worker.env"]);
  });

  it("keeps the file's line endings on the lines it replaces, keeps and adds", async () => {
    const stale = MODEL_LINES("sk-sentinel-revoked").slice(0, 3);
    const before = `# prq\r\n${[...stale, ...OTHERS].join("\r\n")}\r\n`;
    await writePrivateFile("worker.env", before);
    SENTINELS.push("sk-sentinel-revoked");

    const result = await setup(["model"], {
      turns: [
        [KEY_PROMPT, `${MODEL_KEY}\r`],
        ["Replace MODEL_API_KEY in worker.env? [y/N] ", "y\r"],
      ],
    });

    expect(result.code).toBe(0);
    expect(await readWorkerEnv()).toBe(
      `${before.replace("sk-sentinel-revoked", MODEL_KEY)}MODEL_CONTEXT_TOKENS=1048576\r\n`,
    );
  });

  it("refuses a directory it cannot write, naming it, and skips the check", async () => {
    // The cloudflare step and the App recorded, so that the model's write is the first this run makes.
    await completeButModel();
    await chmod(directory, 0o500);

    const result = await setup([], { turns: [[KEY_PROMPT, `${MODEL_KEY}\r`]] });
    await chmod(directory, 0o700);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "model: could not write worker.env in the deploy directory (EACCES); it is as it was",
    );
    expect(result.output).toContain("check: skipped (it needs model, which stopped)");
  });
});

describe("setup check", () => {
  async function complete(): Promise<void> {
    await completeButModel();
    await writePrivateFile("worker.env", `${[...OTHERS, ...MODEL_LINES(MODEL_KEY)].join("\n")}\n`);
  }

  it("passes a complete directory, reaching nothing", async () => {
    await complete();

    const result = await setup(["check"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("check: target.env and access.env: exactly their names");
    expect(result.output).toContain("check: done");
    expect(deepseek.requests).toEqual([]);
  });

  it.each([
    ["an empty access.env", "access.env", "# none yet\n", "access.env does not set PRQ_URL"],
    [
      "target.env whose hostname line Node reads under another name",
      "target.env",
      "CLOUDFLARE_ACCOUNT_ID=5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e\nexport\tPRQ_HOST=prq.example.com\n",
      "line 2 of target.env is not NAME=value",
    ],
    [
      "target.env with an empty hostname",
      "target.env",
      "CLOUDFLARE_ACCOUNT_ID=5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e\nPRQ_HOST=\n",
      "target.env does not set PRQ_HOST to a hostname",
    ],
    ["target.env with another name", "target.env", `${TARGET}${MODEL_KEY}=1\n`, "target.env sets a name besides"],
    [
      "target.env without PRQ_HOST",
      "target.env",
      "CLOUDFLARE_ACCOUNT_ID=5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e\n",
      "target.env does not set PRQ_HOST",
    ],
    ["no access.env", "access.env", null, "the deploy directory has no access.env (setup cloudflare writes it)"],
    [
      "access.env naming another host",
      "access.env",
      ACCESS.replace("prq.example.com", "other.example.com"),
      "access.env does not set PRQ_URL to https:// and target.env's PRQ_HOST",
    ],
    [
      "access.env with an empty secret",
      "access.env",
      ACCESS.replace("PRQ_ACCESS_CLIENT_SECRET=sentinel-client-secret", "PRQ_ACCESS_CLIENT_SECRET="),
      "access.env sets PRQ_ACCESS_CLIENT_SECRET to nothing",
    ],
    [
      "access.env without its secret",
      "access.env",
      "PRQ_URL=https://prq.example.com\nPRQ_ACCESS_CLIENT_ID=id\n",
      "access.env does not set PRQ_ACCESS_CLIENT_SECRET",
    ],
    [
      "worker.env setting a name twice",
      "worker.env",
      `${[...OTHERS, ...MODEL_LINES(MODEL_KEY), "MODEL_ID=other"].join("\n")}\n`,
      "worker.env sets a name twice (MODEL_ID, line 8 and line 10)",
    ],
    ["a file open to others", "access.env", "PRQ_URL=x\n", "access.env is open to others than its owner (mode 0640)"],
  ])("refuses %s", async (_what, file, text, refusal) => {
    await complete();
    if (text === null) {
      await rm(join(directory, file));
    } else {
      await writePrivateFile(file, text, refusal.includes("0640") ? 0o640 : 0o600);
    }

    const result = await setup(["check"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(refusal);
  });

  it.runIf(canAcl)("refuses an access control list on a file", async () => {
    await complete();
    expect(addAcl(join(directory, "github-app.pk8.pem"), false)).toBe(true);

    const result = await setup(["check"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("github-app.pk8.pem has an access control list");
  });
});
