// check:skills's scripts step (G3, the script half; with a pull request argument, before the smoke): the Worker in
// wrangler's local runtime with containers on, the GitHub App of packages/server/.dev.vars, and its model the scripted
// one (scripted.ts), so a turn makes the same calls whatever a model would do.
// 1. The deterministic turn: yomiyasu registered from main, the push's analysis, then a question whose answer activates
//    yomiyasu (following each page's note), runs `yomiyasu_check.py run --stdin --fact-gaps` with a Japanese original
//    and final, calls a file of the skill no entry allows and a command no entry allows, runs `verify --final - --json`
//    with the same final, and answers `done`. Pass: the run exits 0; both disallowed calls are refusals naming the
//    allowed commands, with no prq.skill.script line; the verify's status line says `exit 0` and its stdout's JSON
//    says `"status": "executed"` (the scratch lasted between the runs); the answer is done.
// 2. Container probes through the Workspace's runScript RPC with a probe skill of the check's own, acting from outside
//    through `docker exec` where a probe must: the ownership a distinct `skill` user gives; a 2.1 MB bundle and a
//    100,000-character input through the pipe; the reset cleanup's scope; a runner given no frame; scratch lost in a
//    turn without a restart; orphan adoption and reaping at the script's timeout; a dead runner's marker, then a
//    restart. Each prints its seconds.
// It prints what each step saw and removes every container the Worker started.

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { type PrRef, type Skill, sessionName } from "@prq/protocol";
import * as v from "valibot";

import { toolArgv } from "../../../server/src/workspace-git.ts";
import { field, textField } from "./compaction.ts";
import { ask, deliver } from "./pr.ts";
import type { GithubApp } from "./reconcile.ts";
import {
  type ChatRequest,
  chatRequest,
  SCRIPTED_MODEL,
  type Script,
  type Scripted,
  serveScripted,
} from "./scripted.ts";
import { lastToolResult, nextPage, type Verdict } from "./skill-context.ts";
import { registerSkill, skillLink, YOMIYASU } from "./skill-github.ts";
import { startWorker, type Worker } from "./worker.ts";
import {
  exec,
  execDetached,
  execStatus,
  readPull,
  stopContainer,
  untilEnded,
  workspaceContainers,
} from "./workspace.ts";

const NAME = "yomiyasu";
const SCRIPT_DIR = "${CLAUDE_SKILL_DIR}/scripts";
const ORIGINAL = [
  "このプルリクエストは、ワークスペースでスキルのスクリプトを動かせるようにするものです。",
  "",
  "実行は一回ごとに区切られ、結果はモデルに返されます。",
].join("\n");
const FINAL = [
  "このプルリクエストで、ワークスペースの中でスキルのスクリプトが動くようになります。",
  "",
  "スクリプトは一回ずつ実行され、その結果がモデルに返ります。",
].join("\n");

// yomiyasu's input on stdin for `run --stdin`: the original, then the final, each after its own delimiter line.
function yomiyasuInput(): string {
  return `<<<yomiyasu:original>>>\n${ORIGINAL}\n<<<yomiyasu:final>>>\n${FINAL}\n`;
}

// --- 1. The deterministic turn ---

type Step = { label: string; call: Scripted };

// The answer's calls: the activation's pages as their notes give them, then the runs.
function scriptsTurn(): { script: Script; steps: Step[] } {
  const steps: Step[] = [];
  const runs: Step[] = [
    {
      label: "run",
      call: {
        tool: "run_skill_script",
        input: {
          name: NAME,
          command: `python3 ${SCRIPT_DIR}/yomiyasu_check.py run --stdin --fact-gaps`,
          stdin: yomiyasuInput(),
        },
      },
    },
    {
      label: "a file no entry allows",
      call: {
        tool: "run_skill_script",
        input: { name: NAME, command: `python3 ${SCRIPT_DIR}/yomiyasu_diff.py --help` },
      },
    },
    {
      label: "a command no entry allows",
      call: { tool: "run_skill_script", input: { name: NAME, command: "python3 -c 'print(1)'" } },
    },
    {
      label: "verify",
      call: {
        tool: "run_skill_script",
        input: {
          name: NAME,
          command: `python3 ${SCRIPT_DIR}/yomiyasu_check.py verify --final - --json`,
          stdin: `${FINAL}\n`,
        },
      },
    },
  ];
  let pages = 0;
  let next = 0;
  const script: Script = (request): Scripted => {
    const result = lastToolResult(request);
    let step: Step;
    if (result === null) {
      pages = 1;
      step = { label: "activation", call: { tool: "activate_skill", input: { name: NAME } } };
    } else {
      const input = next === 0 ? nextPage(NAME, result, pages) : null;
      if (input !== null) {
        pages += 1;
        step = { label: `activation page ${pages}`, call: { tool: "activate_skill", input } };
      } else {
        step = runs[next] ?? { label: "answer", call: { publish: "done" } };
        next += 1;
      }
    }
    steps.push(step);
    return step.call;
  };
  return { script, steps };
}

function toolResults(request: ChatRequest): string[] {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : ""));
}

const STATUS = /^\[run_skill_script skill yomiyasu at [0-9a-f]{40} rev \d+: (exit \d+|timeout|no room|error)\]$/;
const Verified = v.looseObject({ status: v.string() });

async function deterministicTurn(
  worker: Worker,
  pr: PrRef,
  scripted: { play: (script: Script) => void },
  skill: Skill,
  print: (line: string) => void,
  verdict: Verdict,
): Promise<void> {
  const { script, steps } = scriptsTurn();
  const from = { requests: worker.modelRequests().length, logs: worker.logs().length };
  scripted.play(script);
  await ask(worker, pr, "scripts-1", "このプルリクエストを要約し、yomiyasu で文章を整えてください。");
  const job = await untilEnded(
    worker,
    pr,
    (entry) => entry.target.kind === "answer" && entry.target.messageId === "scripts-1",
  );
  const requests = worker.modelRequests().slice(from.requests).map(chatRequest);
  const last = requests.at(-1);
  const results = last === undefined ? [] : toolResults(last);
  // Each request after the first holds the result of the call before it.
  const chained = requests.every((request, index) => index === 0 || toolResults(request).length === index);
  verdict(
    job?.state === "done" && chained && steps.at(-1)?.label === "answer",
    `G3 turn: ${job?.state ?? "no job"}${job?.failure == null ? "" : `: ${job.failure}`}; ${requests.length} requests, ` +
      `each next one holding the result before it: ${chained ? "yes" : "no"}; calls: ${steps.map((step) => step.label).join(", ")}`,
  );
  const byLabel = new Map(
    steps.flatMap((step, index) => (index < results.length ? [[step.label, results[index] ?? ""]] : [])),
  );
  const run = byLabel.get("run") ?? "";
  const runStatus = STATUS.exec(run.split("\n", 1)[0] ?? "")?.[1];
  verdict(
    runStatus === "exit 0",
    `G3 run: ${runStatus ?? "no status line"}; ${run.split("\n").slice(1).join(" ").slice(0, 300)}`,
  );
  const allowed = (skill.allowedTools ?? []).filter((tool) => tool.runs).map((tool) => tool.entry.slice(5, -1));
  for (const label of ["a file no entry allows", "a command no entry allows"]) {
    const refused = byLabel.get(label) ?? "";
    verdict(
      STATUS.exec(refused.split("\n", 1)[0] ?? "")?.[1] === "error" &&
        refused.includes(`the commands ${NAME} allows: ${allowed.join("; ")}`),
      `G3 ${label}: ${refused.split("\n").slice(1).join(" ").slice(0, 300)}`,
    );
  }
  const verify = byLabel.get("verify") ?? "";
  const verifyStatus = STATUS.exec(verify.split("\n", 1)[0] ?? "")?.[1];
  const json = verify.split("\n").slice(1).join("\n");
  let status = "(no JSON)";
  try {
    status = v.parse(Verified, JSON.parse(json.slice(json.indexOf("{"), json.lastIndexOf("}") + 1))).status;
  } catch {
    // Reported below.
  }
  verdict(
    verifyStatus === "exit 0" && status === "executed",
    `G3 verify: ${verifyStatus ?? "no status line"}; its JSON's status: ${status}`,
  );
  const logged = worker
    .logs()
    .slice(from.logs)
    .filter((line) => line.includes("prq.skill.script"));
  verdict(
    logged.length === 2,
    `G3 prq.skill.script lines: ${logged.length} (the run and the verify only): ` +
      logged
        .map(
          (line) =>
            `${field(line, "script")} ${textField(line, "ending")} in ${(Number(field(line, "ms")) / 1000).toFixed(1)} s`,
        )
        .join(", "),
  );
  if (runStatus !== "exit 0" || status !== "executed") {
    print(`  the run's result: ${run.slice(0, 2000)}`);
    print(`  the verify's result: ${verify.slice(0, 2000)}`);
  }
}

// --- 2. The container probes ---

const PROBE = "probe";
const PROBE_DIR = `/workspace/skills/${PROBE}`;
const PROBE_PY = `import hashlib, os, subprocess, sys, time
mode, *rest = sys.argv[1:]
def note(name, text):
    with open(name, "w") as file:
        file.write(text)
note("runner-pid", str(os.getppid()))
if mode == "ids":
    lines = [f"uid={os.getuid()} gid={os.getgid()} groups={os.getgroups()}"]
    for path in rest:
        try:
            with open(os.path.join(path, "probe-write"), "w") as file:
                file.write("x")
            lines.append(f"{path}: written")
        except OSError as error:
            lines.append(f"{path}: {type(error).__name__}")
    print("\\n".join(lines))
elif mode == "echo":
    data = sys.stdin.buffer.read()
    blob = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "blob.txt")
    print(hashlib.sha256(data).hexdigest(), len(data), os.path.getsize(blob))
elif mode == "mark":
    print(" ".join(sorted(name for name in os.listdir(".") if name != "runner-pid")) or "(empty)")
    note("mark", "made")
    time.sleep(float(rest[0]) if rest else 0)
elif mode == "helper":
    helper = subprocess.Popen(["sh", "-c", "sleep 600; true"])
    note("helper", str(helper.pid))
    while not os.path.exists("go"):
        time.sleep(0.2)
    alive = helper.poll() is None
    helper.kill()
    helper.wait()
    print(f"helper alive at the end: {alive}")
elif mode == "orphan":
    grandchild = "import os, sys, time; time.sleep(1); open(sys.argv[1], 'w').write(str(os.getppid())); time.sleep(600)"
    child = "import subprocess, sys; subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2]], start_new_session=True)"
    subprocess.run([sys.executable, "-c", child, grandchild, os.path.abspath("grandparent")], check=True)
    time.sleep(600)
elif mode == "survivor":
    survivor = subprocess.Popen(["sleep", "600"], start_new_session=True)
    note("survivor", str(survivor.pid))
    time.sleep(600)
`;
const encoder = new TextEncoder();

type FrameFile = { path: string; mode: "100644" | "100755"; content: Uint8Array };

// 2.1 MB of text, the size of yomiyasu's bundle.
function blob(): Uint8Array {
  const line = `${"0123456789abcdef".repeat(4)}\n`;
  return encoder.encode(line.repeat(Math.ceil(2_100_000 / line.length)));
}

const PROBE_FILES: FrameFile[] = [
  {
    path: "SKILL.md",
    mode: "100644",
    content: encoder.encode("---\nname: probe\ndescription: The check's probe.\n---\n"),
  },
  { path: "data/blob.txt", mode: "100644", content: blob() },
  { path: "scripts/probe.py", mode: "100755", content: encoder.encode(PROBE_PY) },
];

const ScriptResult = v.looseObject({
  ending: v.looseObject({ kind: v.string() }),
  scratch: v.nullable(v.string()),
  stdout: v.string(),
  stderr: v.string(),
  clean: v.boolean(),
});
type ScriptResult = v.InferOutput<typeof ScriptResult>;
const Reply = v.union([
  v.object({ ok: v.literal(true), value: v.unknown() }),
  v.object({ ok: v.literal(false), kind: v.string(), reason: v.string() }),
]);

function ending(result: ScriptResult): string {
  return JSON.stringify(result.ending);
}

type Target = { fullName: string; installationId: number; sha: string; baseSha: string; seq: number };

class Probes {
  readonly #workspace: Record<string, (...args: unknown[]) => Promise<unknown>>;
  readonly #target: Omit<Target, "seq">;
  readonly #containers: () => Promise<{ id: string; state: string }[]>;

  constructor(
    workspace: Record<string, (...args: unknown[]) => Promise<unknown>>,
    target: Omit<Target, "seq">,
    containers: () => Promise<{ id: string; state: string }[]>,
  ) {
    this.#workspace = workspace;
    this.#target = target;
    this.#containers = containers;
  }

  // A run of the probe skill under turn seq: its result and seconds.
  async run(seq: number, args: string[], stdin = ""): Promise<{ result: ScriptResult | string; seconds: string }> {
    const started = Date.now();
    const run = {
      name: PROBE,
      files: PROBE_FILES,
      argv: ["python3", `${PROBE_DIR}/scripts/probe.py`, ...args],
      stdin,
      capChars: 8000,
    };
    const reply = v.parse(Reply, await this.#workspace["runScript"]?.({ ...this.#target, seq }, run));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (!reply.ok) {
      return { result: `${reply.kind}: ${reply.reason}`, seconds };
    }
    return { result: v.parse(ScriptResult, reply.value), seconds };
  }

  // A prepare of turn seq at the head or at the base, as a turn's first call makes it.
  async prepare(seq: number, at: "head" | "base"): Promise<string> {
    const sha = at === "head" ? this.#target.sha : this.#target.baseSha;
    const reply = v.parse(Reply, await this.#workspace["prepare"]?.({ ...this.#target, sha, seq }));
    return reply.ok ? "ok" : `${reply.kind}: ${reply.reason}`;
  }

  // A git tool call on the checkout.
  async git(seq: number): Promise<string> {
    const command = {
      argv: toolArgv.listFiles(this.#target.sha),
      page: { start: { line: 1, char: 0 }, capChars: 2000, numbered: false, detectBinary: false },
    };
    const reply = v.parse(Reply, await this.#workspace["run"]?.({ ...this.#target, seq }, command));
    return reply.ok ? `exit ${String(Reflect.get(Object(reply.value), "exitCode"))}` : `${reply.kind}: ${reply.reason}`;
  }

  async container(): Promise<string> {
    const running = (await this.#containers()).filter((container) => container.state === "running");
    if (running.length !== 1 || running[0] === undefined) {
      throw new Error(`expected one running Workspace container, found ${running.length}`);
    }
    return running[0].id;
  }

  // A file of turn seq's scratch, once it exists (within 30 s), or null.
  async scratchFile(id: string, seq: number, name: string): Promise<string | null> {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const text = await exec(id, ["cat", "--", `/workspace/scratch/${seq}/${name}`]);
      if (!text.includes("No such file")) {
        return text.trim();
      }
      await sleep(200);
    }
    return null;
  }

  async processes(id: string): Promise<{ user: string; pid: string; args: string }[]> {
    const text = await exec(id, ["ps", "-o", "user,pid,args"]);
    return text
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const [user = "", pid = "", ...args] = line.split(/\s+/);
        return { user, pid, args: args.join(" ") };
      });
  }
}

// The modes of the checkout: /workspace, the checkout's root, its ready token, its first file and directory, and every
// entry under /workspace (but the turns' scratch and symbolic links) that a group or others may write.
async function modes(id: string): Promise<{ held: boolean; line: string }> {
  const out = await exec(id, [
    "sh",
    "-c",
    "f=$(find /workspace/repo -path /workspace/repo/.git -prune -o -type f -print | head -n 1); " +
      "d=$(find /workspace/repo -mindepth 1 -path /workspace/repo/.git -prune -o -type d -print | head -n 1); " +
      'stat -c "%a %U %n" /workspace /workspace/repo /workspace/repo/.git/prq-ready "$f" "$d"; ' +
      "echo writable: $(find /workspace -path /workspace/scratch -prune -o ! -type l \\( -perm -020 -o -perm -002 \\) -print | wc -l)",
  ]);
  const lines = out.trim().split("\n");
  const stats = lines.slice(0, 5).map((line) => line.split(" "));
  const writable = /^writable: (\d+)$/.exec(lines.at(-1) ?? "")?.[1];
  const held =
    stats.length === 5 &&
    stats.every(
      ([mode = "", owner]) => owner === "root" && /^[0-7]+$/.test(mode) && (Number.parseInt(mode, 8) & 0o022) === 0,
    ) &&
    writable === "0";
  return { held, line: lines.join("; ") };
}

function resultLine(outcome: { result: ScriptResult | string; seconds: string }): string {
  const { result, seconds } = outcome;
  return typeof result === "string"
    ? `${result} (${seconds} s)`
    : `${ending(result)}, scratch ${result.scratch ?? "-"}, clean ${result.clean}, stdout ${JSON.stringify(result.stdout.trim().slice(0, 200))} (${seconds} s)`;
}

function exited(outcome: { result: ScriptResult | string }, code = 0): boolean {
  return typeof outcome.result !== "string" && ending(outcome.result) === JSON.stringify({ kind: "exit", code });
}

async function probe(label: string, verdict: Verdict, body: () => Promise<{ held: boolean; line: string }>) {
  try {
    const { held, line } = await body();
    verdict(held, `G3 probe ${label}: ${line}`);
  } catch (error) {
    verdict(false, `G3 probe ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function containerProbes(probes: Probes, verdict: Verdict): Promise<void> {
  let seq = 1000;

  await probe("2.1 MB bundle and 100,000-character input", verdict, async () => {
    const input = "読みやすさを確かめる入力です。".repeat(Math.ceil(100_000 / 15)).slice(0, 100_000);
    const bytes = encoder.encode(input);
    const run = await probes.run((seq += 1), ["echo"], input);
    const expected = `${createHash("sha256").update(bytes).digest("hex")} ${bytes.byteLength} ${PROBE_FILES[1]?.content.byteLength}`;
    return {
      held: exited(run) && typeof run.result !== "string" && run.result.stdout.trim() === expected,
      line: `${resultLine(run)}; expected stdout ${expected}`,
    };
  });

  await probe("ownership", verdict, async () => {
    const id = await probes.container();
    const skillIds =
      (await exec(id, ["id", "-u", "skill"])).trim() + " " + (await exec(id, ["id", "-g", "skill"])).trim();
    // The checkout's modes as the turns' prepare from empty left them, then after an update prepare (the base).
    const fresh = await modes(id);
    const update = await probes.prepare((seq += 1), "base");
    const updated = await modes(id);
    const targets = ["/workspace/repo", "/workspace/repo/.git", PROBE_DIR, "/workspace/.prq"];
    const run = await probes.run((seq += 1), ["ids", ...targets]);
    const out = typeof run.result === "string" ? "" : run.result.stdout;
    const [uid = "", gid = ""] = skillIds.split(" ");
    // The identity line, then a refused write for each target, all of them.
    const expected = [`uid=${uid} gid=${gid} groups=[]`, ...targets.map((path) => `${path}: PermissionError`)];
    const held =
      fresh.held &&
      update === "ok" &&
      updated.held &&
      exited(run) &&
      uid !== "0" &&
      JSON.stringify(out.trim().split("\n")) === JSON.stringify(expected);
    return {
      held,
      line:
        `skill is ${skillIds}; after the prepare from empty: ${fresh.line}; the update prepare: ${update}; after it: ` +
        `${updated.line}; ${resultLine(run)}; ${out.trim().replaceAll("\n", "; ")}`,
    };
  });

  await probe("git by name under umask 0000", verdict, async () => {
    const id = await probes.container();
    const out = await exec(id, [
      "sh",
      "-c",
      'umask 000; d=$(mktemp -d); git init -q "$d/r" && stat -c "%a %n" "$d/r" "$d/r/.git" "$d/r/.git/config"; rm -rf "$d"',
    ]);
    const found = out
      .trim()
      .split("\n")
      .map((line) => line.split(" ")[0]);
    return {
      held: JSON.stringify(found) === JSON.stringify(["755", "755", "644"]),
      line: `the image's git wrapper: ${out.trim().replaceAll("\n", "; ")}`,
    };
  });

  await probe("the reset cleanup's scope", verdict, async () => {
    const id = await probes.container();
    const turn = (seq += 1);
    const pending = probes.run(turn, ["helper"]);
    const helper = await probes.scratchFile(id, turn, "helper");
    const runner = await probes.scratchFile(id, turn, "runner-pid");
    await execDetached(id, ["sh", "-c", "sleep 600; true"]);
    await sleep(500);
    const before = await probes.processes(id);
    const rootSh = before.filter((entry) => entry.user === "root" && entry.args === "sh -c sleep 600; true");
    // Whether the kernel the container runs on gives pidfd_open: without it the cleanup exits 2 and the Workspace stops
    // the container instead (an amd64 image under emulation, as on an arm64 machine, has none).
    const pidfd = await execStatus(id, ["python3", "-I", "-S", "-c", "import os; os.close(os.pidfd_open(1))"]);
    const cleanup = await execStatus(id, [
      "python3",
      "-I",
      "-S",
      "/usr/local/libexec/prq-skill-run",
      "--reset-cleanup",
    ]);
    const after = await probes.processes(id);
    const alive = (pid: string | null) => after.some((entry) => entry.pid === pid);
    await exec(id, ["touch", `/workspace/scratch/${turn}/go`]);
    const run = await pending;
    const out = typeof run.result === "string" ? "" : run.result.stdout.trim();
    const rootAlive = after.some((entry) => rootSh.some((root) => root.pid === entry.pid));
    // Without pidfd_open the scope cannot be shown here: what holds is the fail-safe ending, 2 with nothing signalled,
    // on which the Workspace stops the container.
    const held =
      rootSh.length === 1 &&
      (pidfd.code === 0 ? cleanup.code === 0 && !rootAlive : cleanup.code === 2 && rootAlive) &&
      alive(helper) &&
      alive(runner) &&
      exited(run) &&
      out === "helper alive at the end: True";
    return {
      held,
      line:
        (pidfd.code === 0 ? "" : "the scope is not shown without pidfd_open, only the fail-safe ending; ") +
        `root sh ${rootSh.map((entry) => entry.pid).join(",") || "not found"} ${rootAlive ? "alive" : "gone"}; ` +
        `pidfd_open ${pidfd.code === 0 ? "works" : "fails: " + (pidfd.output.trim().split("\n").at(-1) ?? "")}; ` +
        `the cleanup exited ${cleanup.code}; the skill's helper ${helper} ${alive(helper) ? "alive" : "gone"}, the runner ${runner} ` +
        `${alive(runner) ? "alive" : "gone"}; the run: ${resultLine(run)}`,
    };
  });

  await probe("a runner given no frame", verdict, async () => {
    const id = await probes.container();
    const snapshot = () =>
      exec(id, ["sh", "-c", "cat /workspace/.prq/state.json; ls -la /workspace/scratch /workspace/skills"]);
    const before = await snapshot();
    const runner = await execStatus(
      id,
      [
        "python3",
        "-I",
        "-S",
        "/usr/local/libexec/prq-skill-run",
        "--root",
        "/workspace",
        "--user",
        "skill",
        PROBE,
        "--",
        "python3",
        `${PROBE_DIR}/scripts/probe.py`,
        "mark",
      ],
      45_000,
    );
    const after = await snapshot();
    const trailer = runner.output.trim().split("\n").at(-1) ?? "";
    return {
      held: trailer === "- scratch=- end=failed:frame clean=1" && runner.ms < 40_000 && before === after,
      line: `exit ${runner.code} after ${(runner.ms / 1000).toFixed(1)} s with stdin open and empty; trailer ${JSON.stringify(trailer)}; state, scratch and skills ${before === after ? "unchanged" : "CHANGED"}`,
    };
  });

  await probe("scratch lost in a turn without a restart", verdict, async () => {
    const id = await probes.container();
    const turn = (seq += 1);
    const pending = probes.run(turn, ["mark", "20"]);
    const runner = await probes.scratchFile(id, turn, "runner-pid");
    await probes.scratchFile(id, turn, "mark");
    // The runner stops answering; its script ends meanwhile. The Workspace's wait ends at the exec's bound.
    await exec(id, ["kill", "-STOP", runner ?? ""]);
    const first = await pending;
    await exec(id, ["kill", "-CONT", runner ?? ""]);
    let settled = false;
    for (let attempt = 0; attempt < 60 && !settled; attempt += 1) {
      const marker = await exec(id, ["sh", "-c", "test -e /workspace/.prq/running && echo marker || echo none"]);
      const skillProcesses = (await probes.processes(id)).filter((entry) => entry.user === "skill");
      settled = marker.trim() === "none" && skillProcesses.length === 0;
      if (!settled) {
        await sleep(500);
      }
    }
    const next = await probes.run(turn, ["mark"]);
    const sameContainer = (await probes.container()) === id;
    const out = typeof next.result === "string" ? "" : next.result.stdout.trim();
    const held =
      typeof first.result !== "string" &&
      first.result.ending.kind === "unknown" &&
      settled &&
      exited(next) &&
      typeof next.result !== "string" &&
      next.result.scratch === "lost" &&
      out === "(empty)" &&
      sameContainer;
    return {
      held,
      line:
        `the first run: ${resultLine(first)}; the abandoned runner reaped and removed its marker: ${settled ? "yes" : "no"}; ` +
        `the next run: ${resultLine(next)}; the same container: ${sameContainer ? "yes" : "no"}`,
    };
  });

  await probe("orphan adoption and reaping at the timeout", verdict, async () => {
    const id = await probes.container();
    const turn = (seq += 1);
    const run = await probes.run(turn, ["orphan"]);
    const runner = await probes.scratchFile(id, turn, "runner-pid");
    const parent = await probes.scratchFile(id, turn, "grandparent");
    const skillProcesses = (await probes.processes(id)).filter((entry) => entry.user === "skill");
    const sameContainer = (await probes.container()) === id;
    const held =
      typeof run.result !== "string" &&
      run.result.ending.kind === "timeout" &&
      run.result.clean &&
      parent === runner &&
      skillProcesses.length === 0 &&
      sameContainer;
    return {
      held,
      line:
        `${resultLine(run)}; the grandchild's parent after the handoff ${parent}, the runner ${runner}; ` +
        `processes of skill afterwards: ${skillProcesses.length}; the same container: ${sameContainer ? "yes" : "no"}`,
    };
  });

  await probe("a dead runner", verdict, async () => {
    const id = await probes.container();
    const turn = (seq += 1);
    const pending = probes.run(turn, ["survivor"]);
    const runner = await probes.scratchFile(id, turn, "runner-pid");
    const survivor = await probes.scratchFile(id, turn, "survivor");
    await exec(id, ["kill", "-KILL", runner ?? ""]);
    const killed = await pending;
    const refused = await probes.run(turn, ["mark"]);
    const marked = await exec(id, ["sh", "-c", `test -e /workspace/scratch/${turn}/mark && echo spawned || echo none`]);
    const git = await probes.git(turn);
    await stopContainer(id);
    const restarted = await probes.run((seq += 1), ["mark"]);
    const newId = await probes.container();
    const held =
      typeof killed.result !== "string" &&
      killed.result.ending.kind === "unknown" &&
      typeof refused.result !== "string" &&
      ending(refused.result) ===
        JSON.stringify({ kind: "refused", end: { kind: "failed", reason: "unclean", detail: null } }) &&
      marked.trim() === "none" &&
      git === "exit 0" &&
      exited(restarted) &&
      typeof restarted.result !== "string" &&
      restarted.result.scratch === "new";
    return {
      held,
      line:
        `the runner ${runner} killed with the script's child ${survivor} alive: ${resultLine(killed)}; the next run: ${resultLine(refused)}, ` +
        `spawned: ${marked.trim()}; a git call: ${git}; after docker stop: ${resultLine(restarted)} in container ${newId.slice(0, 12)} (was ${id.slice(0, 12)})`,
    };
  });
}

export async function checkScripts(
  app: GithubApp,
  pr: PrRef,
  print: (line: string) => void,
  verdict: Verdict,
): Promise<void> {
  const pull = await readPull(pr);
  print(
    `G3 scripts: ${pr.owner}/${pr.repo}#${pr.number} at head ${pull.head.sha.slice(0, 7)}, the scripted model, containers on`,
  );
  const tracked = await workspaceContainers();
  const scripted = serveScripted();
  let worker: Worker;
  try {
    worker = await startWorker({ model: SCRIPTED_MODEL, githubApp: app.settings, containers: true });
  } catch (error) {
    scripted.stop();
    throw error;
  }
  try {
    const skill = await registerSkill(worker, skillLink(YOMIYASU, "main"));
    print(
      `  yomiyasu registered at ${skill.sha.slice(0, 7)} rev ${skill.rev}; the commands it runs here: ` +
        (skill.allowedTools ?? [])
          .filter((tool) => tool.runs)
          .map((tool) => tool.entry)
          .join(" ; "),
    );
    scripted.play(() => ({ publish: "The summary." }));
    await deliver(worker, pr, {
      action: "opened",
      head: pull.head.sha,
      base: pull.base.sha,
      at: pull.updated_at,
      installation: app.installationId,
    });
    await (await worker.durableObject("PrSession", sessionName(pr)))["settle"]?.();
    const analysis = await untilEnded(worker, pr, (job) => job.target.kind === "analysis");
    verdict(
      analysis?.state === "done",
      `G3 analysis: ${analysis?.state ?? "none"}${analysis?.failure == null ? "" : `: ${analysis.failure}`}`,
    );
    await deterministicTurn(worker, pr, scripted, skill, print, verdict);

    const workspace = await worker.durableObject("Workspace", sessionName(pr));
    const probes = new Probes(
      workspace,
      {
        fullName: `${pr.owner}/${pr.repo}`,
        installationId: app.installationId,
        sha: pull.head.sha,
        baseSha: pull.base.sha,
      },
      tracked.workspaces,
    );
    await containerProbes(probes, verdict);
  } finally {
    await worker.close();
    scripted.stop();
    const { seen, removed } = await tracked.remove();
    print(`  containers of the scripts step: ${seen}, removed after the Worker closed: ${removed}`);
  }
}
