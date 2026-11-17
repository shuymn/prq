// The local stack (`pnpm run stack` in packages/cli; .claude/skills/verify-prq/SKILL.md): the real Worker through
// wrangler's test harness behind the stand-in for Access, a repository fixture for acme/widgets#7, and a control
// server on loopback that pushes scripted jobs and prints the stand-in's request log per agent, for an AI session that
// follows skills/prq/SKILL.md with the compiled prq. Nothing reaches the network, and nothing is deployed. It stops on
// POST /stop, SIGINT or SIGTERM, and then removes only what it made: its servers, the Worker's runtime and its fixture
// root (the state root and the repositories).

import { rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionName } from "@prq/protocol";
import * as v from "valibot";

import { startAccess } from "./access.ts";
import { type Exit, result, type Running, startCli } from "./cli.ts";
import { fixtureRoot, makeRepo } from "./git.ts";
import { agents, ask, push, retry } from "./pr.ts";
import { startWorker } from "./worker.ts";

const PR = { owner: "acme", repo: "widgets", number: 7 };
const SESSION = "local-session";
const OTHER = "other-agent";
// How long the stack runs one prq of its own (another agent's, or the session's before a restart) before it stops it:
// longer than a command's retry window.
const CLI_MS = 120_000;
// How long a retry waits for the session to read the job's context.
const RETRY_WATCH_MS = 15 * 60_000;
const BIN_DIR = dirname(fileURLToPath(new URL("../../dist/prq", import.meta.url)));

const started = performance.now();
const elapsed = (at: number) => `+${((at - started) / 1000).toFixed(1)}s`;
const say = (line: string) => process.stdout.write(`[${elapsed(performance.now())}] ${line}\n`);

// What the stack started, each with its ending, run in reverse by stop() or by a start that fails part way.
const endings: (() => Promise<void>)[] = [];
async function end(): Promise<void> {
  for (const ending of endings.splice(0).toReversed()) {
    await ending();
  }
}

const root = await fixtureRoot("prq-stack-");
endings.push(() => rm(root, { recursive: true, force: true }));
const [worker, access, repo] = await (async () => {
  try {
    const runtime = await startWorker();
    endings.push(() => runtime.close());
    const standIn = await startAccess(runtime);
    endings.push(() => standIn.close());
    const fixture = await makeRepo(root, PR);
    // The session's prq runs git with the host's own config, so the clone itself sends the pull request's URL to the
    // bare repository (the longest insteadOf wins), and its fetches stay in the fixture root.
    const url = `https://github.com/${PR.owner}/${PR.repo}.git`;
    await fixture.clone.configSet(`url.file://${fixture.bare.path}.insteadOf`, url);
    return [runtime, standIn, fixture] as const;
  } catch (error) {
    await end();
    throw error;
  }
})();

const sessionHome = join(root, "state");
const sessionEnv: Record<string, string> = {
  PRQ_URL: access.url,
  PRQ_ACCESS_CLIENT_ID: access.clientId,
  PRQ_ACCESS_CLIENT_SECRET: access.clientSecret,
  PRQ_AGENT_ID: SESSION,
  PRQ_HOME: sessionHome,
  PRQ_CLONE_ROOTS: repo.env["PRQ_CLONE_ROOTS"] ?? "",
};

// The stack's own runs of prq: the session's agent ID and state root (the session before a restart), or another
// agent's in a state root of its own. Each is stopped after CLI_MS, or when the stack stops.
const running = new Set<Running>();
endings.push(async () => {
  await Promise.all([...running].map((run) => run.kill()));
});
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

const stopping = new AbortController();
endings.push(async () => stopping.abort());

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
    void stop();
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

const server = createServer((req, res) => {
  control(req, res).catch(() => res.destroy());
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
endings.push(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
const address = server.address();
if (address === null || typeof address === "string") {
  await end();
  throw new Error("the control server is not listening on a port");
}
const controlUrl = `http://127.0.0.1:${address.port}`;

let stopped = false;
async function stop(): Promise<void> {
  if (stopped) {
    return;
  }
  stopped = true;
  say("stopping: the control server, the stack's prq runs, the stand-in, the Worker, then the fixture root");
  await end();
  say("stopped");
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

const exports = [`PATH="${BIN_DIR}:$PATH"`, ...Object.entries(sessionEnv).map(([name, value]) => `${name}=${value}`)];
await writeFile(join(root, "session.env"), exports.map((line) => `export ${line}\n`).join(""));
process.stdout.write(
  [
    `prq local stack: the Worker behind the Access stand-in at ${access.url}; nothing reaches the network.`,
    `The session's environment (also in ${join(root, "session.env")}):`,
    ...exports.map((line) => `  export ${line}`),
    `Control: curl -s -X POST ${controlUrl}/<command>, one of ${Object.keys(commands).join(", ")}, stop;`,
    `  curl -s ${controlUrl}/log for the request log per agent.`,
    "",
  ].join("\n"),
);
