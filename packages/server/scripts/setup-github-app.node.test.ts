// The setup's GitHub App step (setup-github-app.ts) through the tests' entry (test-entry.ts), against the GitHub
// stand-in (github-stand-in.ts): its REST API, the manifest form's target, and the programs run in place of gh and of
// the browser's opener, which plays the browser. Runs get a terminal from python3's pty module, where prompts are
// answered. Every secret the stand-in hands out is a sentinel no output, and no argument of gh or the opener, may hold.
// Nothing reaches the network.

import type { ChildProcess } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

import type * as v from "valibot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fixtureRoot } from "../../cli/src/test/git.ts";
import type { Fixture } from "./fixture.ts";
import { type GitHub, rsaKey, type StandIn, startGitHub } from "./github-stand-in.ts";
import { inTerminal, type Turn, warmTerminal } from "./setup-terminal.ts";

type Repository = GitHub["installations"][number]["repositories"][number];

const TARGET = "CLOUDFLARE_ACCOUNT_ID=5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e\nPRQ_HOST=prq.example.com\n";
const STORED_SECRET = "sentinel-stored-webhook-secret-6d1e";
// worker.env's other secrets, so that the check passes once the App's are written.
const OTHERS = [
  "ACCESS_TEAM_DOMAIN=https://sentinel-team.example",
  "ACCESS_AUD=sentinel-aud-5e3c0b9a7d1f4e2a",
  "MODEL_BASE_URL=https://api.deepseek.com",
  "MODEL_API_KEY=sk-sentinel-deepseek-4b1d9e2a",
  "MODEL_ID=deepseek-flash",
  "MODEL_CONTEXT_TOKENS=1048576",
];
const STATIC_SENTINELS = [STORED_SECRET, "sentinel-aud-5e3c0b9a7d1f4e2a", "sk-sentinel-deepseek-4b1d9e2a"];
const PASTE = "paste its address bar's URL here (not shown): ";
const REPO = "The private test repository (owner/name): ";
const TEST_REPO = "octo-host/prq-test";
const KEY_FILE = "github-app.pk8.pem";
const NONCE = "0123456789abcdef";
const NONCE_QUESTION = "Is no App with that description left? [y/N] ";
const DESCRIPTION = `prq's deployment (registration ${NONCE})`;

let standIn: StandIn;
let github: GitHub;
let root: string;
let directory: string;
let stateDir: string;
let programs: { gh: string; open: string };
let env: Record<string, string>;
const started: ChildProcess[] = [];

beforeAll(async () => {
  standIn = await startGitHub();
  await warmTerminal();
}, 120_000);

afterAll(async () => {
  await standIn.close();
});

beforeEach(async () => {
  root = await fixtureRoot("prq-setup-github-app-");
  directory = join(root, "config", "deploy");
  stateDir = join(root, "state");
  standIn.reset();
  github = standIn.state();
  programs = await standIn.programs(root);
  env = { PATH: process.env["PATH"] ?? "", HOME: root, TERM: "xterm" };
});

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await standIn.settled();
  await rm(root, { recursive: true, force: true });
});

type Run = {
  turns?: Turn[];
  // The browser's bound and the installation's.
  browserMs?: number;
  installMs?: number;
  signalAt?: [string, NodeJS.Signals];
};

// The setup with these arguments, in a terminal. Neither its output nor gh's or the opener's arguments hold a sentinel.
async function setup(args: string[], { turns = [], browserMs = 20_000, installMs = 10_000, signalAt }: Run = {}) {
  const file = join(root, "fixture.json");
  const settings: v.InferOutput<typeof Fixture> = {
    directory,
    stateDir,
    githubApi: `${standIn.origin}/api`,
    githubWeb: `${standIn.origin}/web`,
    gh: programs.gh,
    open: programs.open,
    waitMs: 15_000,
    stepMs: browserMs,
    followMs: installMs,
    pollMs: 100,
    childEnv: { PRQ_GITHUB_STAND_IN: standIn.origin },
  };
  writeFileSync(file, JSON.stringify(settings));
  const result = await inTerminal(
    { fixture: file, args: ["setup", ...args], cwd: root, env, turns, signalAt },
    started,
  );
  await standIn.settled();
  const argumentsGiven = JSON.stringify([github.ghCalls, github.opened]);
  for (const sentinel of [...STATIC_SENTINELS, ...github.sentinels].filter((each) => each !== "")) {
    expect(result.output).not.toContain(sentinel);
    expect(argumentsGiven).not.toContain(sentinel);
  }
  return result;
}

async function writePrivateFile(name: string, text: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, name), text, { mode: 0o600 });
  await chmod(join(directory, name), 0o600);
}

async function workerEnv(): Promise<Record<string, string | undefined>> {
  return parseEnv(await readFile(join(directory, "worker.env"), "utf8"));
}

async function setupState(): Promise<unknown> {
  try {
    const state: unknown = JSON.parse(await readFile(join(stateDir, "setup.json"), "utf8"));
    return state;
  } catch {
    return {};
  }
}

// A registration started an hour ago, with the nonce its App's description carries.
function pending(name = "octo-host-prq"): unknown {
  return { pending: { name, nonce: NONCE, recordedAt: new Date(Date.now() - 3_600_000).toISOString() } };
}

async function recordState(value: unknown): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, "setup.json"), JSON.stringify({ githubApp: value }), { mode: 0o600 });
}

// An App the deploy directory records, installed on the test repository, which the state file records.
async function recordedApp(
  app: Partial<Parameters<StandIn["addApp"]>[0]> = {},
  repositories: Repository[] = [{ full_name: TEST_REPO, private: true }],
): Promise<number> {
  const key = rsaKey();
  standIn.addApp({ id: 4242, name: "octo-host-prq", publicKey: key.publicKey, ...app }, repositories);
  await writePrivateFile("target.env", TARGET);
  await writePrivateFile(
    "worker.env",
    `${[...OTHERS, `GITHUB_APP_ID=${app.id ?? 4242}`, `WEBHOOK_SECRET=${STORED_SECRET}`, "HOST_GITHUB_ID=7340021"].join("\n")}\n`,
  );
  await writePrivateFile(KEY_FILE, key.pkcs8);
  await recordState({ testRepository: TEST_REPO });
  github.sentinels.push(...key.pkcs8.split("\n").filter((line) => line !== "" && !line.startsWith("-----")));
  return 4242;
}

// The redirect the browser was sent, once there is one, with the state given.
async function redirect(state?: string): Promise<string> {
  for (let tries = 0; github.redirect === null && tries < 200; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const url = new URL(github.redirect ?? "");
  if (state !== undefined) {
    url.searchParams.set("state", state);
  }
  return `${url.toString()}\r`;
}

describe("setup github-app", () => {
  it("makes the App from the manifest, writes its values as one set that passes the check, and does nothing on a re-run", async () => {
    await writePrivateFile("target.env", TARGET);
    await writePrivateFile("worker.env", `${OTHERS.join("\n")}\n`);

    const first = await setup(["github-app"], { turns: [[REPO, `${TEST_REPO}\r`]] });

    expect(first.code).toBe(0);
    expect(first.output).toContain("github-app: created the App octo-host-prq");
    expect(first.output).toContain("github-app: installed");
    expect(first.output).toContain(
      "github-app: webhook URL: the hostname's /webhook, inactive until first-deploy turns it on",
    );
    expect(first.output).toContain("github-app: done");
    expect(github.manifests).toEqual([
      {
        name: "octo-host-prq",
        description: expect.stringMatching(/^prq's deployment \(registration [0-9a-f]{16}\)$/),
        url: "https://prq.example.com",
        hook_attributes: { url: "https://prq.example.com/webhook", active: false },
        redirect_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
        public: false,
        default_permissions: { contents: "read", issues: "read", metadata: "read", pull_requests: "read" },
        default_events: ["pull_request"],
        request_oauth_on_install: false,
      },
    ]);
    expect(github.callbacks).toEqual([200]);
    const app = github.apps.find((each) => each.name === "octo-host-prq");
    const values = await workerEnv();
    expect(values["GITHUB_APP_ID"]).toBe(String(app?.id));
    expect(values["HOST_GITHUB_ID"]).toBe("7340021");
    expect(github.sentinels).toContain(values["WEBHOOK_SECRET"]);
    const key = await readFile(join(directory, KEY_FILE), "utf8");
    expect(key).toContain("-----BEGIN PRIVATE KEY-----");
    expect(createPublicKey(createPrivateKey(key)).equals(app?.publicKey ?? createPublicKey(key))).toBe(true);
    expect((await stat(join(directory, KEY_FILE))).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).toSorted()).toEqual([KEY_FILE, "target.env", "worker.env"]);
    const state = await setupState();
    expect(state).toEqual({ githubApp: { testRepository: TEST_REPO } });
    expect(github.opened).toEqual([
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/),
      `${standIn.origin}/web/apps/octo-host-prq/installations/new`,
    ]);

    const check = await setup(["check"]);
    expect(check.code).toBe(0);

    const opened = github.opened.length;
    const again = await setup(["github-app"]);

    expect(again.code).toBe(0);
    expect(again.output).not.toContain(REPO);
    expect(again.output).not.toContain("wrote");
    expect(again.output).toContain(`github-app: GitHub takes ${KEY_FILE} as the key of the App GITHUB_APP_ID names`);
    expect(again.output).toContain("github-app: done");
    expect(again.output).not.toContain("inactive");
    expect(github.conversions).toBe(1);
    expect(github.opened).toHaveLength(opened);
  });

  it("keeps waiting after a callback with another state, and takes the redirect with its own at once", async () => {
    await writePrivateFile("target.env", TARGET);
    github.browser = "wrong-state";

    // A browser bound past the test's own: the redirect ends the paste prompt, not the bound.
    const result = await setup(["github-app"], { turns: [[REPO, `${TEST_REPO}\r`]], browserMs: 120_000 });

    expect(result.code).toBe(0);
    expect(github.callbacks).toEqual([400, 200]);
    expect(github.conversions).toBe(1);
  });

  it("takes the callback URL pasted from the address bar, refusing one with another state", async () => {
    await writePrivateFile("target.env", TARGET);
    github.browser = "paste";

    const result = await setup(["github-app"], {
      turns: [
        [PASTE, () => redirect("f".repeat(64))],
        [PASTE, () => redirect()],
        [REPO, `${TEST_REPO}\r`],
      ],
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain("github-app: that is not the redirect to");
    expect(github.callbacks).toEqual([]);
    expect(github.conversions).toBe(1);
  });

  it("asks for the hostname when target.env lacks it, and records it", async () => {
    const result = await setup(["github-app"], {
      turns: [
        ["The hostname prq will serve", "prq.example.org\r"],
        [REPO, `${TEST_REPO}\r`],
      ],
    });

    expect(result.code).toBe(0);
    expect(parseEnv(await readFile(join(directory, "target.env"), "utf8"))).toEqual({ PRQ_HOST: "prq.example.org" });
    expect(github.manifests[0]).toHaveProperty("url", "https://prq.example.org");
  });

  it("generates the webhook secret when the conversion answers none", async () => {
    await writePrivateFile("target.env", TARGET);
    github.webhookSecret = false;

    const result = await setup(["github-app"], { turns: [[REPO, `${TEST_REPO}\r`]] });

    expect(result.code).toBe(0);
    expect((await workerEnv())["WEBHOOK_SECRET"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replaces a stored webhook secret with the new App's, asking before the browser", async () => {
    await writePrivateFile("target.env", TARGET);
    await writePrivateFile("worker.env", `WEBHOOK_SECRET=${STORED_SECRET}\n`);

    const result = await setup(["github-app"], {
      turns: [
        ["Go on? [y/N] ", "y\r"],
        [REPO, `${TEST_REPO}\r`],
      ],
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain("The new App replaces WEBHOOK_SECRET in worker.env.");
    const secret = (await workerEnv())["WEBHOOK_SECRET"];
    expect(secret).not.toBe(STORED_SECRET);
    expect(github.sentinels).toContain(secret);
  });

  it("cuts a long login to fit GitHub's 34 characters", async () => {
    await writePrivateFile("target.env", TARGET);
    const login = "l".repeat(39);
    github.user = { login, id: 7340021 };
    github.browserAccount = github.user;

    const result = await setup(["github-app"], { turns: [[REPO, `${TEST_REPO}\r`]] });

    expect(result.code).toBe(0);
    expect(github.manifests[0]).toHaveProperty("name", `${"l".repeat(27)}-prq`);
  });

  it("picks another name when GitHub has an App of the first", async () => {
    await writePrivateFile("target.env", TARGET);
    standIn.addApp({ id: 77, name: "octo-host-prq", owner: { login: "someone", id: 99 } });

    const result = await setup(["github-app"], { turns: [[REPO, `${TEST_REPO}\r`]] });

    expect(result.code).toBe(0);
    expect(github.manifests[0]).toHaveProperty("name", "octo-host-prq-2");
  });

  it("asks before the browser to replace an App's values, and makes nothing on no", async () => {
    await writePrivateFile("target.env", TARGET);
    await writePrivateFile("worker.env", "GITHUB_APP_ID=31337\n");

    const result = await setup(["github-app"], { turns: [["Go on? [y/N] ", "n\r"]] });

    expect(result.code).toBe(1);
    expect(result.output).toContain("The new App replaces GITHUB_APP_ID in worker.env.");
    expect(result.output).toContain("setup: kept GITHUB_APP_ID in worker.env; no App was made");
    expect(github.opened).toEqual([]);
    expect(await setupState()).toEqual({});
    expect(await readFile(join(directory, "worker.env"), "utf8")).toBe("GITHUB_APP_ID=31337\n");
  });

  it("writes nothing when the conversion fails, and keeps the registration pending", async () => {
    await writePrivateFile("target.env", TARGET);
    github.conversionStatus = 422;

    const result = await setup(["github-app"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: GitHub did not hand over the App's key (HTTP 422)");
    await expect(lstat(join(directory, "worker.env"))).rejects.toThrow("ENOENT");
    await expect(lstat(join(directory, KEY_FILE))).rejects.toThrow("ENOENT");
    expect(await setupState()).toEqual({
      githubApp: {
        pending: {
          name: "octo-host-prq",
          nonce: expect.stringMatching(/^[0-9a-f]{16}$/),
          recordedAt: expect.any(String),
        },
      },
    });
  });

  it("writes nothing when GitHub made the App on another account than gh's", async () => {
    await writePrivateFile("target.env", TARGET);
    github.browserAccount = { login: "other", id: 5150 };

    const result = await setup(["github-app"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `setup: GitHub made the App on another account than gh's (octo-host): delete it at ${standIn.origin}/web/settings/apps/octo-host-prq/advanced`,
    );
    await expect(lstat(join(directory, "worker.env"))).rejects.toThrow("ENOENT");
    await expect(lstat(join(directory, KEY_FILE))).rejects.toThrow("ENOENT");
  });

  it("has the owner delete a pending registration's App whose key did not arrive, then starts over", async () => {
    // A stop between the renames: the new App's ID in worker.env, the old key beside it.
    await recordedApp({ description: DESCRIPTION });
    await writePrivateFile(KEY_FILE, rsaKey().pkcs8);
    await recordState(pending());

    const result = await setup(["github-app"], {
      turns: [
        [
          "Press Enter once it is deleted: ",
          () => {
            standIn.deleteApp("octo-host-prq");
            return "\r";
          },
        ],
        ["Go on? [y/N] ", "y\r"],
        [REPO, `${TEST_REPO}\r`],
      ],
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain(
      `github-app: delete it (Delete GitHub App, at the bottom): ${standIn.origin}/web/settings/apps/octo-host-prq/advanced`,
    );
    expect(result.output).toContain(
      "The new App replaces GITHUB_APP_ID in worker.env and WEBHOOK_SECRET in worker.env and github-app.pk8.pem.",
    );
    const app = github.apps.find((each) => each.name === "octo-host-prq");
    const values = await workerEnv();
    expect(values["GITHUB_APP_ID"]).toBe(String(app?.id));
    expect(app?.id).not.toBe(4242);
    // The set is the new App's whole: its webhook secret, not the one recorded beside the earlier ID.
    expect(values["WEBHOOK_SECRET"]).not.toBe(STORED_SECRET);
    expect(github.sentinels).toContain(values["WEBHOOK_SECRET"]);
    expect(await setupState()).toEqual({ githubApp: { testRepository: TEST_REPO } });
  });

  it("stops when the pending registration's App is still there", async () => {
    await recordedApp({ description: DESCRIPTION });
    await writePrivateFile(KEY_FILE, rsaKey().pkcs8);
    await recordState(pending());
    const before = await readFile(join(directory, "worker.env"), "utf8");

    const result = await setup(["github-app"], { turns: [["Press Enter once it is deleted: ", "\r"]] });

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: the App octo-host-prq is still there: delete it");
    expect(github.opened).toEqual([]);
    expect(await readFile(join(directory, "worker.env"), "utf8")).toBe(before);
  });

  it("never names another App of the name for deletion, and stops before a second registration", async () => {
    // An App of the proposed name made apart from setup, such as one for local checks.
    await writePrivateFile("target.env", TARGET);
    standIn.addApp({ id: 77, name: "octo-host-prq" }, [{ full_name: TEST_REPO, private: true }]);
    await recordState(pending());

    const result = await setup(["github-app"], { turns: [[NONCE_QUESTION, "n\r"]] });

    expect(result.code).toBe(1);
    expect(result.output).not.toContain("Delete GitHub App");
    expect(result.output).toContain(
      `github-app: in ${standIn.origin}/web/settings/apps, delete any App whose description holds "registration ${NONCE}"`,
    );
    expect(result.output).toContain("setup: the earlier registration is not settled");
    expect(github.apps.map((each) => each.id)).toEqual([77]);
    expect(github.opened).toEqual([]);
    expect(await setupState()).toHaveProperty("githubApp.pending.nonce", NONCE);
  });

  it("stops a retry before a second registration when the App was renamed on GitHub", async () => {
    await writePrivateFile("target.env", TARGET);
    github.rename = "renamed-prq";
    github.conversionStatus = 422;
    expect((await setup(["github-app"])).code).toBe(1);
    github.conversionStatus = 201;

    const retry = await setup(["github-app"], { turns: [[NONCE_QUESTION, "n\r"]] });

    expect(retry.code).toBe(1);
    expect(github.apps.map((each) => each.name)).toEqual(["renamed-prq"]);
    expect(github.manifests).toHaveLength(1);
  });

  it("starts over once the owner says no App of the earlier registration is left", async () => {
    await writePrivateFile("target.env", TARGET);
    await recordState(pending());

    const result = await setup(["github-app"], {
      turns: [
        [NONCE_QUESTION, "y\r"],
        [REPO, `${TEST_REPO}\r`],
      ],
    });

    expect(result.code).toBe(0);
    expect(github.conversions).toBe(1);
    expect(await setupState()).toEqual({ githubApp: { testRepository: TEST_REPO } });
  });

  it("makes a new App when the recorded webhook secret is empty, asking first", async () => {
    await recordedApp();
    await writePrivateFile("worker.env", "GITHUB_APP_ID=4242\nWEBHOOK_SECRET=\nHOST_GITHUB_ID=7340021\n");

    const result = await setup(["github-app"], { turns: [["Go on? [y/N] ", "n\r"]] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "The new App replaces GITHUB_APP_ID in worker.env and WEBHOOK_SECRET in worker.env",
    );
    expect(result.output).not.toContain("github-app: done");
  });

  it("refuses a recorded App when GitHub answers another App's ID", async () => {
    await recordedApp();
    github.appIdOverride = 999;

    const result = await setup(["github-app"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("they do not belong together");
  });

  it("refuses a key and an ID that do not belong together, without a pending registration", async () => {
    await recordedApp();
    await writePrivateFile(KEY_FILE, rsaKey().pkcs8);

    const result = await setup(["github-app"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `setup: GitHub does not take ${KEY_FILE} as the key of the App GITHUB_APP_ID names: they do not belong together`,
    );
    expect(github.opened).toEqual([]);
  });

  it("stops at the bound when GitHub does not redirect back, and closes its server", async () => {
    await writePrivateFile("target.env", TARGET);
    github.browser = "none";

    const result = await setup(["github-app"], { browserMs: 1_500 });

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: GitHub did not redirect back within 2 s");
    await expect(fetch(github.opened[0] ?? "")).rejects.toThrow("fetch failed");
    expect(await setupState()).toHaveProperty("githubApp.pending");
  });

  it("counts the browser's time from before the form, the opener's time included", async () => {
    await writePrivateFile("target.env", TARGET);
    github.browser = "none";
    github.openDelayMs = 2_000;

    const result = await setup(["github-app"], { browserMs: 4_000 });

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/keep the name octo-host-prq and click Create GitHub App, within [12] s/);
  });

  it("refuses a redirect that comes back after the browser's time, exchanging nothing", async () => {
    await writePrivateFile("target.env", TARGET);
    github.openDelayMs = 2_000;
    github.browseBeforeReturn = true;

    const result = await setup(["github-app"], { browserMs: 1_000 });

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: GitHub did not redirect back within 1 s");
    expect(github.callbacks).toEqual([400]);
    expect(github.conversions).toBe(0);
    expect(await setupState()).toHaveProperty("githubApp.pending");
  });

  it("closes its server and restores the terminal when stopped by a signal while it waits", async () => {
    await writePrivateFile("target.env", TARGET);
    github.browser = "none";

    const result = await setup(["github-app"], { signalAt: [PASTE, "SIGTERM"] });

    expect(result.code).toBe(143);
    await expect(fetch(github.opened[0] ?? "")).rejects.toThrow("fetch failed");
    expect((await readdir(directory)).toSorted()).toEqual(["target.env"]);
  });

  it("adopts an App made by hand from its downloaded key, deleting the download on yes", async () => {
    await writePrivateFile("target.env", TARGET);
    const key = rsaKey();
    github.sentinels.push(...key.pkcs1.split("\n").filter((line) => line !== "" && !line.startsWith("-----")));
    standIn.addApp({ id: 6060, name: "by-hand", publicKey: key.publicKey }, [{ full_name: TEST_REPO, private: true }]);
    const download = join(root, "by-hand.private-key.pem");
    await writeFile(download, key.pkcs1, { mode: 0o600 });
    await writePrivateFile("worker.env", `WEBHOOK_SECRET=${STORED_SECRET}\n`);

    const result = await setup(["github-app", "--key", download, "--app-id", "6060"], {
      turns: [
        ["the key GitHub downloaded", "y\r"],
        [REPO, `${TEST_REPO}\r`],
      ],
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain("github-app: webhook URL: not set yet (first-deploy sets it)");
    await expect(lstat(download)).rejects.toThrow("ENOENT");
    const values = await workerEnv();
    expect(values["GITHUB_APP_ID"]).toBe("6060");
    expect(values["HOST_GITHUB_ID"]).toBe("7340021");
    expect(values["WEBHOOK_SECRET"]).toBe(STORED_SECRET);
    expect(await readFile(join(directory, KEY_FILE), "utf8")).toBe(key.pkcs8);
    expect(github.manifests).toEqual([]);
  });

  it("refuses to adopt an App of another account than gh's before asking for the hostname, writing nothing", async () => {
    const key = rsaKey();
    github.sentinels.push(...key.pkcs1.split("\n").filter((line) => line !== "" && !line.startsWith("-----")));
    standIn.addApp({ id: 6060, name: "by-hand", publicKey: key.publicKey, owner: { login: "other", id: 5150 } }, [
      { full_name: "other/prq-test", private: true },
    ]);
    const download = join(root, "by-hand.private-key.pem");
    await writeFile(download, key.pkcs1, { mode: 0o600 });

    const result = await setup(["github-app", "--key", download, "--app-id", "6060"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: the App 6060 is not octo-host's, the account gh is logged in as");
    expect(result.output).not.toContain("The hostname prq will serve");
    await expect(lstat(join(directory, "target.env"))).rejects.toThrow("ENOENT");
    await expect(lstat(join(directory, KEY_FILE))).rejects.toThrow("ENOENT");
    await expect(lstat(join(directory, "worker.env"))).rejects.toThrow("ENOENT");
    expect(await readFile(download, "utf8")).toBe(key.pkcs1);
  });

  it("keeps the download on no, and refuses a key that is not the App's", async () => {
    await writePrivateFile("target.env", TARGET);
    const key = rsaKey();
    github.sentinels.push(...key.pkcs1.split("\n").filter((line) => line !== "" && !line.startsWith("-----")));
    standIn.addApp({ id: 6060, name: "by-hand", publicKey: key.publicKey }, [{ full_name: TEST_REPO, private: true }]);
    const download = join(root, "by-hand.private-key.pem");
    await writeFile(download, key.pkcs1, { mode: 0o600 });

    const wrong = await setup(["github-app", "--key", download, "--app-id", "6061"]);
    expect(wrong.code).toBe(1);
    expect(wrong.output).toContain(`setup: GitHub does not take ${download} as the key of the App 6061`);
    await expect(lstat(join(directory, KEY_FILE))).rejects.toThrow("ENOENT");

    const kept = await setup(["github-app", "--app-id", "6060", "--key", download], {
      turns: [
        ["the key GitHub downloaded", "n\r"],
        [REPO, `${TEST_REPO}\r`],
      ],
    });
    expect(kept.code).toBe(0);
    expect(kept.output).toContain(`github-app: kept ${download}`);
    expect((await workerEnv())["WEBHOOK_SECRET"]).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(download, "utf8")).toBe(key.pkcs1);
  });

  it("refuses other arguments", async () => {
    const result = await setup(["github-app", "--key", "x"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: usage: setup [");
  });

  it("stops at the bound when the App is not installed", async () => {
    await recordedApp();
    github.installations = [];
    github.installOnOpen = null;

    const result = await setup(["github-app"], { installMs: 1_000 });

    expect(result.code).toBe(1);
    expect(result.output).toContain("setup: the App was not installed within 1 s");
  });

  it("finds the test repository past the first page of the installation's", async () => {
    await recordedApp({}, [
      ...Array.from({ length: 130 }, (_, n) => ({ full_name: `octo-host/repo-${n}`, private: true })),
      { full_name: TEST_REPO, private: true },
    ]);

    const result = await setup(["github-app"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain(`github-app: the test repository ${TEST_REPO}: installed, private`);
  });

  it.each([
    [false, TEST_REPO, `setup: ${TEST_REPO} is public: the test repository is a private one`],
    [true, "octo-host/elsewhere", "setup: the App is not installed on octo-host/elsewhere"],
  ])("refuses a test repository that is public or not installed", async (isPrivate, named, refusal) => {
    await recordedApp({}, [{ full_name: TEST_REPO, private: isPrivate }]);
    await recordState({});

    const result = await setup(["github-app"], { turns: [[REPO, `${named}\r`]] });

    expect(result.code).toBe(1);
    expect(result.output).toContain(refusal);
    expect(await setupState()).toEqual({ githubApp: {} });
  });

  it("refuses an App that does not read back as made, naming each difference", async () => {
    await recordedApp({
      permissions: { contents: "write", issues: "read", metadata: "read", pull_requests: "read", checks: "read" },
      events: ["pull_request", "push"],
      hookUrl: "https://elsewhere.example.com/webhook",
    });

    const result = await setup(["github-app"]);

    expect(result.code).toBe(1);
    for (const refusal of [
      "setup: the App's contents permission is write, not read",
      "setup: the App's checks permission is read, not none",
      "setup: the App subscribes to push besides pull_request",
      "setup: the App's webhook URL is https://elsewhere.example.com/webhook, not",
    ]) {
      expect(result.output).toContain(refusal);
    }
  });

  it("asks before replacing a HOST_GITHUB_ID that is not the App's owner", async () => {
    await recordedApp();
    await writePrivateFile(
      "worker.env",
      `${[`GITHUB_APP_ID=4242`, `WEBHOOK_SECRET=${STORED_SECRET}`, "HOST_GITHUB_ID=1"].join("\n")}\n`,
    );

    const result = await setup(["github-app"], { turns: [["Replace HOST_GITHUB_ID in worker.env? [y/N] ", "n\r"]] });

    expect(result.code).toBe(1);
    expect((await workerEnv())["HOST_GITHUB_ID"]).toBe("1");
  });
});
