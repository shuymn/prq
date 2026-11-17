// A manual check of the cloud workspace with Docker (workspace-check.ts): the real Worker in wrangler's local runtime
// with containers on, the GitHub App and a model configured, and a real pull request of a public repository, delivered
// as its webhook would be. It checks three things and prints the proof of each:
// 1. The push's analysis prepares the container from empty at the head, fetching through the egress with the
//    installation token, and a code question is answered through the tools.
// 2. After the container is stopped (by its ID), the next question rebuilds the checkout from empty at the same commit
//    and is answered.
// 3. From inside the container, a request to another host or another github.com path gets 403, and no token is in the
//    container's environment or the checkout's .git/config.
// Docker runs only through the named operations below, on containers this check saw start.

import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { type PrRef, PrSessionView, sessionName } from "@prq/protocol";
import * as v from "valibot";

import { ask, deliver } from "./pr.ts";
import type { GithubApp } from "./reconcile.ts";
import { type ModelSettings, startWorker, type Worker } from "./worker.ts";

const run = promisify(execFile);

// Longer than a container start, a fetch, and a turn at the provider's bounds.
const JOB_MS = 10 * 60_000;
const POLL_MS = 1000;
const STOP_MS = 60_000;
// The image wrangler builds from packages/server/Dockerfile for the Workspace class, and the label workerd puts on the
// containers of one runtime session (miniflare's SESSION_LABEL).
const IMAGE_PREFIX = "cloudflare-dev/workspace:";
const SESSION_LABEL = "dev.workerd.session";
const CHECKOUT = "/workspace/repo";
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const CONTAINER_ID = /^[0-9a-f]{64}$/;
// GitHub's token formats, and the words of an Authorization header a token would come with.
const SECRET_LIKE = /\bgh[opsur]_[A-Za-z0-9_]+|x-access-token|authorization|extraheader/i;

// Questions only a tool call answers, whatever the repository and whatever the analysis already read.
const QUESTIONS = [
  "Call the list_files tool now, even if you listed files before, and name three paths from its result. Answer in one sentence.",
  "Call the read_file tool now on README.md (or, if there is none, on any file list_files shows) and quote its first line. Answer in one sentence.",
];

const Pull = v.object({
  head: v.object({ sha: v.string() }),
  base: v.object({ sha: v.string() }),
  updated_at: v.string(),
  user: v.object({ login: v.string() }),
});
const Stored = v.array(
  v.object({
    id: v.string(),
    parts: v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()), input: v.optional(v.unknown()) })),
  }),
);

type Job = PrSessionView["jobs"][number];
type Container = { id: string; image: string; session: string; state: string };

// The pull request's head, base and update time, from GitHub's API without credentials (a public repository).
async function readPull(pr: PrRef): Promise<v.InferOutput<typeof Pull>> {
  const res = await fetch(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "prq-workspace-check" },
  });
  if (res.status !== 200) {
    throw new Error(`GitHub answered ${res.status} for the pull request`);
  }
  return v.parse(Pull, await res.json());
}

// The Worker's requests to GitHub, seen where the harness hands them to this process's fetch: each one's method, host
// and path, status, and whether it carried git's Basic credentials for the installation token (never the token).
function watchGithub(): { requests: string[]; stop: () => void } {
  const requests: string[] = [];
  const passThrough = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== "github.com" && url.host !== "api.github.com") {
      return passThrough(input, init);
    }
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(
      "authorization",
    );
    const basic = /^Basic (.+)$/.exec(authorization ?? "");
    const user =
      basic === null
        ? null
        : Buffer.from(basic[1] ?? "", "base64")
            .toString()
            .split(":")[0];
    const credentials =
      user === "x-access-token"
        ? ", with the installation token"
        : authorization === null
          ? ""
          : ", with other credentials";
    const response = await passThrough(input, init);
    requests.push(`${method} ${url.host}${url.pathname}${url.search}: ${response.status}${credentials}`);
    return response;
  };
  return {
    requests,
    stop: () => {
      globalThis.fetch = passThrough;
    },
  };
}

// --- Docker, only through these operations ---

async function containers(): Promise<Container[]> {
  const { stdout } = await run("docker", [
    "ps",
    "--all",
    "--no-trunc",
    "--format",
    `{{.ID}}\t{{.Image}}\t{{.Label "${SESSION_LABEL}"}}\t{{.State}}`,
  ]);
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [id = "", image = "", session = "", state = ""] = line.split("\t");
      return { id, image, session, state };
    });
}

function checked(id: string): string {
  if (!CONTAINER_ID.test(id)) {
    throw new Error(`not a container ID: ${id}`);
  }
  return id;
}

// A command in a container this check started, its output whatever its exit status.
async function exec(id: string, argv: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run("docker", ["exec", checked(id), ...argv], { timeout: 60_000 });
    return `${stdout}${stderr}`;
  } catch (error) {
    const out =
      error instanceof Error
        ? `${String(Reflect.get(error, "stdout") ?? "")}${String(Reflect.get(error, "stderr") ?? "")}`
        : "";
    return out === "" ? `exec failed: ${error instanceof Error ? error.message : String(error)}` : out;
  }
}

async function environmentNames(id: string): Promise<string[]> {
  const { stdout } = await run("docker", [
    "inspect",
    "--format",
    "{{range .Config.Env}}{{println .}}{{end}}",
    checked(id),
  ]);
  return stdout.split("\n").filter((line) => line !== "");
}

async function stopContainer(id: string): Promise<void> {
  await run("docker", ["stop", checked(id)], { timeout: STOP_MS });
}

async function removeContainer(id: string): Promise<void> {
  await run("docker", ["rm", "--force", checked(id)], { timeout: STOP_MS });
}

// --- The session ---

async function view(worker: Worker, pr: PrRef): Promise<PrSessionView> {
  const session = await worker.durableObject("PrSession", sessionName(pr));
  return v.parse(PrSessionView, await session["view"]?.());
}

// The job the predicate picks, once it has ended or JOB_MS passed.
async function untilEnded(worker: Worker, pr: PrRef, pick: (job: Job) => boolean): Promise<Job | undefined> {
  const started = Date.now();
  let job = (await view(worker, pr)).jobs.find(pick);
  while (job?.state !== "done" && job?.state !== "failed" && Date.now() - started < JOB_MS) {
    await sleep(POLL_MS);
    job = (await view(worker, pr)).jobs.find(pick);
  }
  return job;
}

async function stored(worker: Worker, pr: PrRef): Promise<v.InferOutput<typeof Stored>> {
  const res = await fetch(new URL(`/agents/pr-session/${sessionName(pr)}/get-messages`, worker.url()), {
    headers: { "Cf-Access-Jwt-Assertion": await worker.token() },
  });
  if (res.status !== 200) {
    throw new Error(`get-messages answered ${res.status}`);
  }
  return v.parse(Stored, await res.json());
}

// The Worker's log events of the workspace and the egress since the given count of lines.
function events(worker: Worker, from: number): string[] {
  return worker
    .logs()
    .slice(from)
    .filter((line) => /prq\.(workspace|egress|job\.usage)\b/.test(line))
    .map((line) => line.replace(/\s+/g, " "));
}

// Asks a question and prints how its job ended: the answer, and the tool calls stored with it.
async function question(
  worker: Worker,
  pr: PrRef,
  id: string,
  text: string,
  print: (line: string) => void,
): Promise<{ done: boolean; tools: number }> {
  print(`question: ${text}`);
  const started = Date.now();
  await ask(worker, pr, id, text);
  const job = await untilEnded(worker, pr, (entry) => entry.target.kind === "answer" && entry.target.messageId === id);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (job?.state !== "done") {
    print(`  job: ${job?.state ?? "none"} after ${seconds} s${job?.failure == null ? "" : `: ${job.failure}`}`);
    return { done: false, tools: 0 };
  }
  const answer = (await stored(worker, pr)).find((message) => message.id === `answer-${job.jobId}`);
  const tools = (answer?.parts ?? []).filter((part) => part.type.startsWith("tool-"));
  print(`  job: done after ${seconds} s (a cloud turn ends done only when the model's finish is stop)`);
  for (const part of tools) {
    print(`  tool call: ${part.type.slice("tool-".length)} ${JSON.stringify(part.input ?? null)}`);
  }
  const answerText = (answer?.parts ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
  print(`  answer: ${answerText.trim()}`);
  return { done: answerText.trim() !== "", tools: tools.length };
}

// The HTTP probes run in the container: python3's urllib, trusting the interception CA, prints each URL's status.
const PROBE = `
import ssl, sys, urllib.error, urllib.request
context = ssl.create_default_context(cafile=sys.argv[1])
for method, url in zip(sys.argv[2::2], sys.argv[3::2]):
    request = urllib.request.Request(url, method=method, data=b"0000" if method == "POST" else None)
    try:
        with urllib.request.urlopen(request, context=context, timeout=30) as response:
            print(method, url, response.status)
    except urllib.error.HTTPError as error:
        print(method, url, error.code)
    except Exception as error:
        print(method, url, "error", type(error).__name__)
`;

export type WorkspaceCheck = { app: GithubApp; model: ModelSettings };

export async function checkWorkspace(
  settings: WorkspaceCheck,
  pr: PrRef,
  print: (line: string) => void,
): Promise<boolean> {
  const pull = await readPull(pr);
  const head = pull.head.sha;
  const repo = `https://github.com/${pr.owner}/${pr.repo}`;
  print(
    `workspace check: ${pr.owner}/${pr.repo}#${pr.number} at head ${head} (base ${pull.base.sha}), ` +
      `App ${settings.app.settings.GITHUB_APP_ID}, installation ${settings.app.installationId}, ` +
      `model ${settings.model.MODEL_ID}; the Worker in a local runtime with containers on`,
  );
  const before = new Set((await containers()).map((container) => container.id));
  const ours = new Set<string>();
  // The new Workspace containers, and any container of the same runtime session (the egress sidecar), noted as ours.
  const workspaces = async (): Promise<Container[]> => {
    const fresh = (await containers()).filter((container) => !before.has(container.id));
    const sessions = new Set(fresh.filter((c) => c.image.startsWith(IMAGE_PREFIX)).map((c) => c.session));
    for (const container of fresh) {
      if (container.session !== "" && sessions.has(container.session)) {
        ours.add(checked(container.id));
      }
    }
    return fresh.filter((container) => container.image.startsWith(IMAGE_PREFIX));
  };
  const results = { prepared: false, rebuilt: false, contained: false };
  // Installed before the Worker starts, so the Worker's own fetch wrapper passes GitHub's requests through it.
  const github = watchGithub();
  const githubSince = (from: number) => {
    const lines = github.requests.slice(from);
    for (const line of lines) {
      print(`  the Worker to GitHub: ${line}`);
    }
    return lines;
  };
  const fetched = (lines: string[]) =>
    lines.some((line) =>
      line.startsWith(`POST github.com/${pr.owner}/${pr.repo}.git/git-upload-pack: 200, with the installation token`),
    );
  const worker = await startWorker({ model: settings.model, githubApp: settings.app.settings, containers: true }).catch(
    (error: unknown) => {
      github.stop();
      throw error;
    },
  );
  try {
    // 1. The analysis prepares from empty at the head; a question is answered through the tools.
    print("step 1: the push's analysis prepares the container from empty, and a code question is answered");
    let from = worker.logs().length;
    await deliver(worker, pr, {
      action: "opened",
      head,
      base: pull.base.sha,
      at: pull.updated_at,
      installation: settings.app.installationId,
    });
    await (await worker.durableObject("PrSession", sessionName(pr)))["settle"]?.();
    const analysis = await untilEnded(worker, pr, (job) => job.target.kind === "analysis");
    print(`  analysis: ${analysis?.state ?? "none"}${analysis?.failure == null ? "" : `: ${analysis.failure}`}`);
    const first = (await workspaces()).filter((container) => container.state === "running");
    print(
      `  Workspace containers running: ${first.map((container) => container.id.slice(0, 12)).join(", ") || "none"}`,
    );
    const firstEvents = events(worker, from);
    for (const line of firstEvents) {
      print(`  ${line}`);
    }
    const firstGithub = githubSince(0);
    const minted = firstGithub.some((line) =>
      line.startsWith(`POST api.github.com/app/installations/${settings.app.installationId}/access_tokens: 201`),
    );
    const rebuiltAtHead = (lines: string[]) =>
      lines.some((line) => line.includes("prq.workspace.prepared") && line.includes(head) && line.includes("rebuild"));
    from = worker.logs().length;
    const asked = await question(worker, pr, "workspace-check-1", QUESTIONS[0] ?? "", print);
    for (const line of events(worker, from)) {
      print(`  ${line}`);
    }
    results.prepared =
      analysis?.state === "done" &&
      first.length === 1 &&
      rebuiltAtHead(firstEvents) &&
      minted &&
      fetched(firstGithub) &&
      asked.done &&
      asked.tools > 0;
    print(results.prepared ? "step 1: as expected" : "step 1: NOT as expected");

    const container = first[0];
    if (container === undefined) {
      return false;
    }

    // 3. Inside the container: other hosts and paths get 403, and no token is there.
    print("step 3: from inside the container, other hosts and paths get 403, and no token is there");
    const probeFrom = github.requests.length;
    const probes = await exec(container.id, [
      "python3",
      "-c",
      PROBE,
      CA,
      "GET",
      `${repo}.git/info/refs?service=git-upload-pack`,
      "GET",
      "https://example.com/",
      "GET",
      "http://example.com/",
      "GET",
      `${repo}/archive/refs/heads/main.zip`,
      "GET",
      `${repo}.git/info/refs?service=git-receive-pack`,
      "POST",
      `${repo}.git/git-receive-pack`,
      "GET",
      `https://api.github.com/repos/${pr.owner}/${pr.repo}`,
    ]);
    const statuses = probes.split("\n").filter((line) => line !== "");
    for (const line of statuses) {
      print(`  ${line}`);
    }
    githubSince(probeFrom);
    const [allowed, ...denied] = statuses;
    const probesHold =
      allowed?.endsWith(" 200") === true && denied.length === 6 && denied.every((line) => line.endsWith(" 403"));
    const environment = await environmentNames(container.id);
    const runtimeEnvironment = await exec(container.id, ["env"]);
    const config = await exec(container.id, ["cat", "--", `${CHECKOUT}/.git/config`]);
    print(`  container environment: ${environment.map((entry) => entry.split("=")[0]).join(", ") || "none"}`);
    print(
      `  exec environment: ${runtimeEnvironment
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => l.split("=")[0])
        .join(", ")}`,
    );
    print(`  ${CHECKOUT}/.git/config:`);
    for (const line of config.split("\n").filter((entry) => entry !== "")) {
      print(`    ${line}`);
    }
    const noToken = ![environment.join("\n"), runtimeEnvironment, config].some((text) => SECRET_LIKE.test(text));
    print(`  a token or an authorization in the environment or .git/config: ${noToken ? "none" : "FOUND"}`);
    from = worker.logs().length;
    results.contained = probesHold && noToken && config.includes('[remote "origin"]');
    print(results.contained ? "step 3: as expected" : "step 3: NOT as expected");

    // 2. The container stopped by its ID; the next question rebuilds from empty at the same commit.
    print(
      `step 2: the container ${container.id.slice(0, 12)} is stopped; the next question rebuilds at the same commit`,
    );
    await stopContainer(container.id);
    const state = (await containers()).find((entry) => entry.id === container.id)?.state ?? "gone";
    print(`  container ${container.id.slice(0, 12)}: ${state}`);
    from = worker.logs().length;
    const githubFrom = github.requests.length;
    const again = await question(worker, pr, "workspace-check-2", QUESTIONS[1] ?? "", print);
    const secondEvents = events(worker, from);
    for (const line of secondEvents) {
      print(`  ${line}`);
    }
    const secondGithub = githubSince(githubFrom);
    const second = (await workspaces()).filter((entry) => entry.state === "running");
    print(`  Workspace containers running: ${second.map((entry) => entry.id.slice(0, 12)).join(", ") || "none"}`);
    results.rebuilt =
      state !== "running" &&
      again.done &&
      rebuiltAtHead(secondEvents) &&
      fetched(secondGithub) &&
      second.length === 1 &&
      second[0]?.id !== container.id;
    print(results.rebuilt ? "step 2: as expected" : "step 2: NOT as expected");
  } finally {
    await worker.close();
    github.stop();
    await workspaces();
    const left = (await containers()).filter((container) => ours.has(container.id));
    for (const container of left) {
      await removeContainer(container.id);
    }
    print(`containers of this check: ${ours.size}, removed after the Worker closed: ${left.length}`);
  }
  const ok = results.prepared && results.rebuilt && results.contained;
  print(ok ? "as expected" : "NOT as expected");
  return ok;
}
