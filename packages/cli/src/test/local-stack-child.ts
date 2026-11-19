// The local stack's worker process, which local-stack.ts starts in a process group of its own and whose end it owns:
// the real Worker through wrangler's test harness behind the stand-in for Access, a repository fixture for
// acme/widgets#7 in the fixture root the owner made (the one argument), and a control server on loopback that pushes
// scripted jobs and prints the stand-in's request log per agent. Nothing reaches the network, and nothing is deployed.
// The harness registers SIGINT and SIGTERM handlers that exit the process, so signals go to the owner, which asks this
// process to stop over the IPC channel; it stops as well on POST /stop, when the channel closes (the owner is gone), and
// when its start fails. Stopping runs the ending of everything it started, every one even if another throws, and then
// the process exits: 1 after a failed start or ending, else 0.

import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionName } from "@prq/protocol";
import * as v from "valibot";

import { type Access, startAccess } from "./access.ts";
import { type Exit, result, type Running, startCli } from "./cli.ts";
import { Endings } from "./endings.ts";
import { makeRepo, type Repo } from "./git.ts";
import { agents, ask, push, retry } from "./pr.ts";
import { startWorker, type Worker } from "./worker.ts";

const PR = { owner: "acme", repo: "widgets", number: 7 };
const SESSION = "local-session";
const OTHER = "other-agent";
// How long the stack runs one prq of its own (another agent's, or the session's before a restart) before it stops it:
// longer than a command's retry window.
const CLI_MS = 120_000;
// How long a retry waits for the session to read the job's context.
const RETRY_WATCH_MS = 15 * 60_000;
const BIN_DIR = dirname(fileURLToPath(new URL("../../dist/prq", import.meta.url)));

const root = process.argv[2] ?? "";
if (!isAbsolute(root)) {
  throw new Error("the worker process takes the fixture root, an absolute path");
}
const sessionHome = join(root, "state");

const started = performance.now();
const elapsed = (at: number) => `+${((at - started) / 1000).toFixed(1)}s`;
const say = (line: string) => process.stdout.write(`[${elapsed(performance.now())}] ${line}\n`);

const endings = new Endings();
let phase: "starting" | "ready" | "stopping" = "starting";
let stopAsked = false;

// The owner's stop, or the owner gone (the IPC channel closed); during the start, at its next step.
function requestStop(): void {
  if (phase === "starting") {
    stopAsked = true;
  } else {
    void stop(0);
  }
}
process.on("message", (message) => {
  if (message === "stop") {
    requestStop();
  }
});
process.on("disconnect", requestStop);

class Stopped extends Error {}
function checkpoint(): void {
  if (stopAsked) {
    throw new Stopped("asked to stop during the start");
  }
}

async function stop(code: number): Promise<void> {
  if (phase === "stopping") {
    return;
  }
  phase = "stopping";
  const errors = await endings.run();
  for (const error of errors) {
    process.stderr.write(`prq local stack: an ending failed: ${String(error)}\n`);
  }
  process.exitCode = errors.length > 0 ? 1 : code;
  // The channel is left on a later turn: Node fails on a disconnect within its delivery of a queued message. With the
  // channel closed and everything started ended, the process exits.
  await new Promise((resolve) => setImmediate(resolve));
  if (process.connected) {
    process.disconnect();
  }
}

// The stack, each part set by start() as its step completes.
let worker: Worker;
let access: Access;
let repo: Repo;
let sessionEnv: Record<string, string>;

// The stack's own runs of prq: the session's agent ID and state root (the session before a restart), or another
// agent's in a state root of its own. Each is stopped after CLI_MS, or when the stack stops.
const running = new Set<Running>();
function prq(args: string[], agentId: string): Promise<Exit> {
  const home = agentId === SESSION ? sessionHome : join(root, "other-state");
  const env = { ...sessionEnv, HOME: root, PRQ_AGENT_ID: agentId, PRQ_HOME: home };
  const run = startCli(args, env, root);
  running.add(run);
  const timer = setTimeout(() => void run.kill(), CLI_MS);
  return run.exited.finally(() => {
    clearTimeout(timer);
    running.delete(run);
  });
}

const Claimed = v.looseObject({ job: v.looseObject({ jobId: v.string() }), dir: v.string(), answer: v.string() });

async function claim(agentId: string) {
  const exit = await prq(["claim"], agentId);
  if (exit.code !== 0) {
    throw new Error(`prq claim as ${agentId} exited ${exit.code}: ${exit.stderr.trim()}`);
  }
  return v.parse(Claimed, result(exit));
}

// The markers the log shows between requests: what the stack did, when.
const markers: { at: number; text: string }[] = [];
function mark(text: string): void {
  markers.push({ at: performance.now(), text });
  say(text);
}

let heads = 0;
let questions = 0;
async function pushHead(): Promise<string> {
  heads += 1;
  const head = await repo.head(`h${heads}`, { "change.md": `change ${heads}\n` });
  await push(worker, PR, head, repo.base);
  return head;
}

// A job for the session, pushed only while the session is present (its wait counts as a contact), so that the job is
// a local agent's.
function forSession(job: () => Promise<string>): () => Promise<string> {
  return async () =>
    (await agents(worker)).some((row) => row.agentId === SESSION)
      ? job()
      : `${SESSION} is not present: start the session first (its prq wait makes it present)`;
}

// Retries the job the session claimed once the session has read its context, so the session's submit is dropped: the
// first 200 from /cli/context of the session after from. Gives up after RETRY_WATCH_MS or when the stack stops.
async function retryAfterContext(from: number, cancel: AbortSignal): Promise<void> {
  const deadline = performance.now() + RETRY_WATCH_MS;
  const read = () =>
    access.log.some(
      (entry) => entry.at > from && entry.agentId === SESSION && entry.route === "/cli/context" && entry.status === 200,
    );
  while (!read()) {
    if (cancel.aborted || performance.now() > deadline) {
      say("retry: gave up, the session read no context");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // The job the session holds now, which the retry's revision then pins.
  const rows = await worker.sql(
    "PrSession",
    sessionName(PR),
    "SELECT job_id FROM prq_jobs WHERE state = 'claimed' AND agent_id = ?",
    SESSION,
  );
  const row = v.safeParse(v.tuple([v.object({ job_id: v.string() })]), rows);
  if (!row.success) {
    say("retry: the session holds no claimed job any more; nothing retried");
    return;
  }
  await retry(worker, PR, row.output[0].job_id);
  mark(`retry: the host retried job ${row.output[0].job_id} after the session read its context`);
}

// Ends the retry watchers when the stack stops.
const stopping = new AbortController();

// The scripted jobs, each one control command.
const commands: Record<string, () => Promise<string>> = {
  analysis: forSession(async () => {
    const head = await pushHead();
    mark(`analysis: pushed head ${head.slice(0, 7)} of ${PR.owner}/${PR.repo}#${PR.number}`);
    return "an analysis job for the session";
  }),
  question: forSession(async () => {
    questions += 1;
    const id = `q${questions}`;
    await ask(worker, PR, id, "Which file does this pull request change, and what does it now contain?");
    mark(`question: asked ${id}`);
    return "an answer job for the session";
  }),
  taken: forSession(async () => {
    const head = await pushHead();
    mark(`taken: pushed head ${head.slice(0, 7)}; ${OTHER} claims it at once`);
    const claimed = await claim(OTHER);
    await writeFile(claimed.answer, "A summary written by another agent.\n");
    const submitted = await prq(["submit"], OTHER);
    mark(`taken: ${OTHER} claimed job ${claimed.job.jobId} and submitted (exit ${submitted.code})`);
    return "a job another agent took: the session's claim finds none";
  }),
  retry: forSession(async () => {
    const from = performance.now();
    const head = await pushHead();
    mark(`retry: pushed head ${head.slice(0, 7)}; the host retries it once the session has read its context`);
    void retryAfterContext(from, stopping.signal).catch((error: unknown) => say(`retry: failed: ${String(error)}`));
    return "a job the host retries while the session works on it: the session's submit is dropped";
  }),
  async restart() {
    if ((await agents(worker)).some((row) => row.agentId === SESSION && row.waiting)) {
      return `${SESSION} is waiting: stop the AI session (and its prq wait) first`;
    }
    // The session before the restart: present, claimed the job, and stopped while writing its answer. The stack runs
    // its prq, so the log shows these requests under the session's agent ID, after this marker.
    mark(`restart: the stack runs ${SESSION}'s prq as the session before the restart: wait, then claim a new head`);
    await prq(["wait", "--timeout", "0"], SESSION);
    const head = await pushHead();
    const claimed = await claim(SESSION);
    await writeFile(claimed.answer, "## Summary\n\nThis pull request changes\n");
    mark(`restart: claimed job ${claimed.job.jobId} at head ${head.slice(0, 7)} and left an unfinished answer`);
    return `start a fresh session: it must finish the answer in ${claimed.answer} before it submits`;
  },
};

// The stand-in's requests, per agent, with the stack's markers between them; consecutive answered waits are one line.
function requestLog(): string {
  const lines: string[] = [];
  const ids = [...new Set(access.log.map((entry) => entry.agentId ?? "(none)"))];
  for (const id of ids) {
    lines.push(id);
    const events = [
      ...access.log
        .filter((entry) => (entry.agentId ?? "(none)") === id)
        .map((entry) => ({
          at: entry.at,
          text: `${entry.route} ${entry.open ? "in flight" : (entry.status ?? "cut off")}`,
          wait: entry.route === "/cli/wait" && entry.status !== null,
        })),
      ...markers.map((marker) => ({ at: marker.at, text: `-- ${marker.text}`, wait: false })),
    ].toSorted((a, b) => a.at - b.at);
    let run = 0;
    events.forEach((event, i) => {
      const next = events[i + 1];
      if (event.wait && next?.wait === true) {
        run += 1;
        return;
      }
      const count = event.wait && run > 0 ? ` (and ${run} answered polls before it)` : "";
      run = 0;
      lines.push(`  ${elapsed(event.at)} ${event.text}${count}`);
    });
  }
  return `${lines.join("\n")}\n`;
}

let queue = Promise.resolve();
async function control(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const name = new URL(req.url ?? "/", "http://control").pathname.slice(1);
  const reply = (status: number, body: string) => res.writeHead(status, { "Content-Type": "text/plain" }).end(body);
  if (req.method === "GET" && name === "log") {
    reply(200, requestLog());
    return;
  }
  if (req.method === "POST" && name === "stop") {
    reply(200, "stopping\n");
    void stop(0);
    return;
  }
  const command = req.method === "POST" ? commands[name] : undefined;
  if (command === undefined) {
    reply(404, `commands: POST ${Object.keys(commands).join(", ")}, stop; GET log\n`);
    return;
  }
  // One command at a time, in the order they came.
  const done = queue.then(command);
  queue = done.then(
    () => {},
    () => {},
  );
  try {
    reply(200, `${await done}\n`);
  } catch (error) {
    say(`${name}: failed: ${String(error)}`);
    reply(500, `${name} failed: ${String(error)}\n`);
  }
}

// The start, step by step, each step's ending added as it completes; a stop asked for meanwhile ends it at the next
// step. The last step writes session.env, then the environment and the control commands are printed.
async function start(): Promise<void> {
  worker = await startWorker();
  endings.add(() => worker.close());
  checkpoint();
  access = await startAccess(worker);
  endings.add(() => access.close());
  endings.add(async () => {
    stopping.abort();
    await Promise.all([...running].map((run) => run.kill()));
  });
  checkpoint();
  repo = await makeRepo(root, PR);
  // The session's prq runs git with the host's own config, so the clone itself sends the pull request's URL to the
  // bare repository (the longest insteadOf wins), and its fetches stay in the fixture root.
  await repo.clone.configSet(`url.file://${repo.bare.path}.insteadOf`, `https://github.com/${PR.owner}/${PR.repo}.git`);
  checkpoint();
  sessionEnv = {
    PRQ_URL: access.url,
    PRQ_ACCESS_CLIENT_ID: access.clientId,
    PRQ_ACCESS_CLIENT_SECRET: access.clientSecret,
    PRQ_AGENT_ID: SESSION,
    PRQ_HOME: sessionHome,
    PRQ_CLONE_ROOTS: repo.env["PRQ_CLONE_ROOTS"] ?? "",
  };
  const server = createServer((req, res) => {
    control(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endings.add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  checkpoint();
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the control server is not listening on a port");
  }
  const controlUrl = `http://127.0.0.1:${address.port}`;
  const exports = [`PATH="${BIN_DIR}:$PATH"`, ...Object.entries(sessionEnv).map(([name, value]) => `${name}=${value}`)];
  await writeFile(join(root, "session.env"), exports.map((line) => `export ${line}\n`).join(""));
  process.stdout.write(
    [
      `prq local stack: the Worker behind the Access stand-in at ${access.url}; nothing reaches the network.`,
      `The web UI, through the stand-in's browser door: ${access.door.url}`,
      `The session's environment (also in ${join(root, "session.env")}):`,
      ...exports.map((line) => `  export ${line}`),
      `Control: curl -s -X POST ${controlUrl}/<command>, one of ${Object.keys(commands).join(", ")}, stop;`,
      `  curl -s ${controlUrl}/log for the request log per agent.`,
      "",
    ].join("\n"),
  );
}

try {
  await start();
  phase = "ready";
  if (stopAsked) {
    await stop(0);
  }
} catch (error) {
  if (!(error instanceof Stopped)) {
    process.stderr.write(
      `prq local stack: the start failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  await stop(error instanceof Stopped ? 0 : 1);
}
