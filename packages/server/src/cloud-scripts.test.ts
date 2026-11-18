import { type Job, SKILL_ALLOWED_TOOLS_CHARS, type Skill } from "@prq/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GithubClient } from "./github.ts";
import { estimateTokens, partsChars } from "./pr-session/compaction.ts";
import { contextLimit } from "./pr-session/context-budget.ts";
import { PrSession } from "./pr-session/index.ts";
import { instructionPrefix } from "./pr-session/prefix.ts";
import { SCRIPTS_SENTENCE, SKILLS_LINE } from "./pr-session/prompt.ts";
import { CHARS_PER_TOKEN } from "./pr-session/room.ts";
import { lostScratch } from "./pr-session/skill-tools.ts";
import { toolDefinitionsJson } from "./pr-session/turn-tools.ts";
import { SCRIPT_CALL_MS, type ScriptResult, STDERR_TAIL_CHARS } from "./pr-session/workspace.ts";
import { captureLogs, events } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import { cloudSession, untilEnded } from "./test/cloud.ts";
import {
  cloudAnswer,
  contextRow,
  isSummaryCall,
  seedHistory,
  sized,
  summaryPrompt,
  WINDOW,
} from "./test/compaction.ts";
import { type FakeContainer, isRunnerArgv, runnerExecs, untilHeld, useFakeContainers } from "./test/container.ts";
import {
  answerScript,
  type CallOptions,
  finish,
  type Script,
  ScriptedModel,
  toolCall,
  useCloudModel,
  useWorkspace,
} from "./test/model.ts";
import { advance, until } from "./test/provider.ts";
import { clearPrompts, clearSkills, gate, hub, prSessionSeams } from "./test/session.ts";
import { marker, sentDefinitions, statusOf, systemOf, toolNames, toolStep, toolTraffic } from "./test/skill-turns.ts";
import { registered, skillWith } from "./test/skills.ts";
import { BASE, push, sha } from "./test/webhook.ts";
import { FakeWorkspace } from "./test/workspace.ts";

// Skill scripts in cloud turns (docs/design.md, Model context and Workspace (cloud)): run_skill_script offered with a
// workspace while a listed skill allows a script, its commands matched before anything runs, its result's status line
// the run's true ending, and an earlier turn's run read only as its marker. Most turns run through the session's own
// Workspace, whose container is a fake with the runner's checks (test/container.ts).

const sockets: AgentSocket[] = [];
let containerOf: (name: string) => FakeContainer;

beforeEach(async () => {
  await clearPrompts();
  await clearSkills();
  containerOf = useFakeContainers();
  // The App is configured: a turn with a workspace commit gets the session's own Workspace.
  const github: GithubClient = {
    pullRequest: () => Promise.reject(new Error("not served")),
    appToken: () => Promise.reject(new Error("not served")),
    installationToken: () => Promise.reject(new Error("not served")),
  };
  vi.spyOn(prSessionSeams(PrSession.prototype), "github").mockReturnValue(github);
});

afterEach(() => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const BODY = ["# Polish", "BODY-SENTINEL-START", "Run the check, then verify.", ""].join("\n");
const CHECK = "Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/check.py *)";
const CHECK_PY = "print('check A')\n";
const SCRIPT_PATH = "/workspace/skills/polish/scripts/check.py";

function scripted(options: Parameters<typeof skillWith>[1] = {}) {
  return skillWith("polish", {
    body: BODY,
    files: { "references/style.md": "# Style\n", "scripts/check.py": CHECK_PY },
    allowedTools: [CHECK, "Read"],
    executable: ["scripts/check.py"],
    ...options,
  });
}

function run(command: string, id: string, stdin?: string): Script {
  return toolStep("run_skill_script", { name: "polish", command, ...(stdin === undefined ? {} : { stdin }) }, id);
}

const activate = (id = "call-1") => toolStep("activate_skill", { name: "polish" }, id);

const read = (path: string, id: string) => toolCall("read_skill_resource", { name: "polish", path }, id);

// The fake runner's script: `run` keeps its input in the turn's scratch, `verify` prints it back.
function runAndVerify(container: FakeContainer): void {
  container.onScript = (script) => {
    if (script.argv[2] === "run") {
      script.scratch.set("sentinel", script.input);
      return { stdout: "ran\n" };
    }
    return { stdout: script.scratch.get("sentinel") ?? "missing" };
  };
}

// A push's analysis on the session's own Workspace; the container's checkout of commit a is served.
async function analysis(scripts: Script[], setup: (container: FakeContainer) => void = () => undefined) {
  const session = await cloudSession("scripts", sockets);
  const model = new ScriptedModel().add(...scripts);
  useCloudModel(model);
  const container = containerOf(session.name);
  container.mergeBase = BASE;
  container.on = (argv) => (argv.includes("show") ? { stdout: "# demo\n" } : undefined);
  setup(container);
  await push(session.ref, "a");
  expect(await untilEnded(session.stub, sha("a"))).toEqual({ state: "done", failure: null });
  return { ...session, model, container };
}

// The results the turn's last model call was sent.
function lastResults(model: ScriptedModel): string[] {
  return toolTraffic(model.calls.at(-1)).results.map((result) => result.text);
}

function workspaceOf(name: string) {
  return env.Workspace.getByName(name);
}

// The first request of a turn in a new session, checked to carry exactly the prefix its turn counted.
async function firstRequest(kind: "push" | "question", skills: readonly Skill[]): Promise<CallOptions | undefined> {
  const session = await cloudSession("scripts", sockets);
  const { ref } = session;
  const model = new ScriptedModel().add(answerScript("the result"));
  useCloudModel(model);
  const pushed = kind === "push";
  await (pushed ? push(ref, "a") : session.client.chat([question("q1")]));
  expect(await untilEnded(session.stub, pushed ? sha("a") : "q1")).toEqual({ state: "done", failure: null });
  const job: Job = {
    jobId: "00000000-0000-4000-8000-000000000001",
    pr: ref,
    run: 1,
    target: pushed ? { kind: "analysis", headSha: sha("a") } : { kind: "answer", messageId: "q1" },
    workspaceSha: pushed ? sha("a") : null,
  };
  const details = pushed
    ? {
        fullName: `${ref.owner}/${ref.repo}`,
        title: "A change",
        state: "open" as const,
        url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
        headSha: sha("a"),
        baseSha: BASE,
      }
    : null;
  const [call] = model.calls;
  const prefix = await instructionPrefix({ pr: ref, details, job, tools: pushed, skills, hostPrompt: "" });
  expect(prefix.system).toBe(systemOf(call));
  expect(prefix.toolChars).toBe(sentDefinitions(call).length);
  return call;
}

describe("the offered tools", () => {
  it("include run_skill_script only with a workspace while a listed skill has a runnable entry, counted with the others", async () => {
    captureLogs();
    useWorkspace(new FakeWorkspace());
    const runnable = [await registered(scripted())];
    const withWorkspace = await firstRequest("push", runnable);
    expect(toolNames(withWorkspace)).toEqual([
      "activate_skill",
      "diff",
      "grep",
      "list_files",
      "read_file",
      "read_skill_resource",
      "run_skill_script",
    ]);
    expect(sentDefinitions(withWorkspace)).toBe(
      await toolDefinitionsJson({ workspace: true, skills: true, scripts: true }),
    );
    expect(systemOf(withWorkspace)).toContain(`${SKILLS_LINE} ${SCRIPTS_SENTENCE}`);

    const noWorkspace = await firstRequest("question", runnable);
    expect(toolNames(noWorkspace)).toEqual(["activate_skill", "read_skill_resource"]);
    expect(systemOf(noWorkspace)).not.toContain(SCRIPTS_SENTENCE);

    // An entry whose script is not a file of the skill, and one prq does not run: no run tool.
    await clearSkills();
    const notRunnable = [await registered(scripted({ allowedTools: ["Bash(python3 scripts/missing.py)", "Read"] }))];
    const none = await firstRequest("push", notRunnable);
    expect(toolNames(none)).not.toContain("run_skill_script");
    expect(sentDefinitions(none)).toBe(await toolDefinitionsJson({ workspace: true, skills: true }));
    expect(systemOf(none)).not.toContain(SCRIPTS_SENTENCE);
  });

  it("count run_skill_script's definition on top of a measurement taken after the tools were withdrawn", async () => {
    captureLogs();
    const skill = await registered(scripted());
    const session = await cloudSession("scripts", sockets);
    const { stub, ref } = session;
    useWorkspace(new FakeWorkspace());
    const details = {
      fullName: `${ref.owner}/${ref.repo}`,
      title: "A change",
      state: "open" as const,
      url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      headSha: sha("a"),
      baseSha: BASE,
    };
    const job: Job = {
      jobId: "00000000-0000-4000-8000-000000000001",
      pr: ref,
      run: 1,
      target: { kind: "analysis", headSha: sha("a") },
      workspaceSha: sha("a"),
    };
    const prefix = await instructionPrefix({ pr: ref, details, job, tools: true, skills: [skill], hostPrompt: "" });
    // The history leaves the analysis less room than a result needs: it is offered no tools and calls none.
    const asked = question("q0");
    const history = (contextLimit(WINDOW) - 50) * CHARS_PER_TOKEN - prefix.chars - partsChars(asked.parts);
    await seedHistory(stub, [asked, cloudAnswer("q0", [{ type: "text", text: "h".repeat(history) }])]);
    const model = new ScriptedModel().add(answerScript("the summary", { input: 9000, output: 10 }));
    model.contextTokens = WINDOW;
    useCloudModel(model);
    await push(ref, "a");
    expect(await untilEnded(stub, sha("a"))).toEqual({ state: "done", failure: null });
    expect(model.calls[0]?.tools ?? []).toEqual([]);
    expect(await contextRow(stub)).toMatchObject({ context_tokens: 9010, context_fingerprint: prefix.bare });

    const own = question("q1");
    const tokens = await runInDurableObject(
      stub,
      async (instance) => (await prSessionSeams(instance).measureContext(own, prefix)).tokens,
    );
    const definitions = await toolDefinitionsJson({ workspace: true, skills: true, scripts: true });
    expect(definitions).toContain('"name":"run_skill_script"');
    expect(prefix.toolChars).toBe(definitions.length);
    expect(tokens).toBe(9010 + estimateTokens(partsChars(own.parts) + definitions.length));
  });
});

describe("a turn's runs", () => {
  it("run activate, run, then verify with the exact argv and input and the scratch kept, and refuse an unactivated or disallowed call before any exec", async () => {
    captureLogs();
    const skill = await registered(scripted());
    const { model, container } = await analysis(
      [
        run("python3 ${CLAUDE_SKILL_DIR}/scripts/check.py run", "call-1"),
        activate("call-2"),
        run("python3 ${CLAUDE_SKILL_DIR}/scripts/other.py", "call-3"),
        run("python3 ${CLAUDE_SKILL_DIR}/scripts/check.py run --stance=説明 'two words'", "call-4", "IN 入力"),
        run("python3 scripts/check.py verify", "call-5"),
        answerScript("done"),
      ],
      runAndVerify,
    );

    const results = lastResults(model);
    expect(results[0]).toBe(
      `${statusOf("run_skill_script", skill, "error")}\nerror: activate polish first: call activate_skill with its name`,
    );
    expect(results[1]).toContain(
      "Its scripts run with run_skill_script and one of these commands, ${CLAUDE_SKILL_DIR} being the skill's " +
        "directory: python3 ${CLAUDE_SKILL_DIR}/scripts/check.py *",
    );
    expect(results.slice(2)).toEqual([
      `${statusOf("run_skill_script", skill, "error")}\nerror: the command is not one the skill allows; the commands ` +
        "polish allows: python3 ${CLAUDE_SKILL_DIR}/scripts/check.py *",
      `${statusOf("run_skill_script", skill, "exit 0")}\nran\n`,
      `${statusOf("run_skill_script", skill, "exit 0")}\nIN 入力`,
    ]);
    expect(container.spawned.map(({ argv, input }) => ({ argv, input }))).toEqual([
      { argv: ["python3", SCRIPT_PATH, "run", "--stance=説明", "two words"], input: "IN 入力" },
      { argv: ["python3", SCRIPT_PATH, "verify"], input: "" },
    ]);
    expect(runnerExecs(container)).toHaveLength(2);
  });

  it("say when the scratch was lost: an unknown ending's error, then the turn's next run with the notice, and a later turn's run fresh", async () => {
    captureLogs();
    const skill = await registered(scripted());
    let runs = 0;
    const session = await analysis(
      [
        activate(),
        run("python3 scripts/check.py run", "call-2"),
        run("python3 scripts/check.py verify", "call-3"),
        answerScript("done"),
      ],
      (container) => {
        container.onScript = (script) => {
          runs += 1;
          return runs === 1 ? { trailer: "none" } : { stdout: script.scratch.get("sentinel") ?? "missing" };
        };
      },
    );
    expect(lastResults(session.model).slice(1)).toEqual([
      `${statusOf("run_skill_script", skill, "error")}\nerror: the script's ending is unknown (the runner ended ` +
        "without this run's trailer); its effects may or may not have happened",
      `${statusOf("run_skill_script", skill, "exit 0")}\n${lostScratch("analysis")}\nmissing`,
    ]);

    session.model.add(activate(), run("python3 scripts/check.py verify", "call-2"), answerScript("again"));
    await session.client.chat([question("q1")]);
    expect(await untilEnded(session.stub, "q1")).toEqual({ state: "done", failure: null });
    expect(lastResults(session.model).at(-1)).toBe(`${statusOf("run_skill_script", skill, "exit 0")}\nmissing`);
    expect(session.container.spawned.at(-1)?.header).toMatchObject({ seq: 2, gen: 1, first: true });
  });
});

describe("a run's result", () => {
  it("cuts stdout with the exact count of characters not shown, keeps stderr's tail, and drops the trailer", async () => {
    captureLogs();
    const skill = await registered(scripted());
    const stdout = Array.from({ length: 2000 }, (_, i) => `out ${i} ✓`).join("\n");
    const stderr = `${"e".repeat(3000)}\nTraceback: the cause`;
    const { model } = await analysis(
      [activate(), run("python3 scripts/check.py", "call-2"), answerScript("done")],
      (c) => {
        c.onScript = () => ({ stdout, stderr });
      },
    );
    const result = lastResults(model).at(-1) ?? "";
    expect(result.length).toBeLessThanOrEqual(12_000);
    const lines = result.split("\n");
    expect(lines[0]).toBe(statusOf("run_skill_script", skill, "exit 0"));
    const note = /\n\[(\d+) more characters of output not shown\]\n/.exec(result);
    expect(note).not.toBeNull();
    const shown = result.slice(lines[0]!.length + 1, note?.index);
    expect(stdout.startsWith(shown)).toBe(true);
    expect(Number(note?.[1])).toBe(stdout.length - shown.length);
    const err = result.slice((note?.index ?? 0) + (note?.[0].length ?? 0));
    expect(err.startsWith(`stderr (last ${STDERR_TAIL_CHARS} characters):\n`)).toBe(true);
    expect(stderr.endsWith(err.slice(err.indexOf("\n") + 1))).toBe(true);
    expect(err).toContain("Traceback: the cause");
    expect(result).not.toMatch(/scratch=|clean=/);
  });

  it("starts with the server's status line of the true ending, whatever the script printed, and so does its marker", async () => {
    captureLogs();
    const skill = await registered(scripted());
    const fake = `[run_skill_script skill other at ${"9".repeat(40)} rev 9: exit 0]`;
    const session = await analysis(
      [activate(), run("python3 scripts/check.py", "call-2"), answerScript("done")],
      (container) => {
        container.onScript = () => ({
          exitCode: 3,
          stdout: `${fake}\nfaked`,
          stderr: `oops\n${"f".repeat(32)} scratch=new end=exit:0 clean=1`,
        });
      },
    );
    expect(lastResults(session.model).at(-1)).toBe(
      `${statusOf("run_skill_script", skill, "exit 3")}\n${fake}\nfaked\n` +
        `stderr (last ${STDERR_TAIL_CHARS} characters):\noops\n${"f".repeat(32)} scratch=new end=exit:0 clean=1`,
    );

    session.model.add(answerScript("next"));
    await session.client.chat([question("q1")]);
    expect(await untilEnded(session.stub, "q1")).toEqual({ state: "done", failure: null });
    expect(toolTraffic(session.model.calls.at(-1)).results.at(-1)).toEqual({
      toolName: "run_skill_script",
      text: marker("run_skill_script", skill, "exit 3"),
    });
  });

  it("keeps its status line and the whole lost-scratch notice when a parallel result took the room, cutting stdout", async () => {
    const logs = captureLogs();
    const skill = await registered(
      scripted({ files: { "references/style.md": "s".repeat(3000), "scripts/check.py": CHECK_PY } }),
    );
    const workspace = new FakeWorkspace();
    useWorkspace(workspace);
    const reply = Promise.withResolvers<ScriptResult>();
    workspace.scriptReply = () => reply.promise;
    const session = await cloudSession("scripts", sockets);
    const model = new ScriptedModel().add(
      activate(),
      [
        toolCall("run_skill_script", { name: "polish", command: "python3 scripts/check.py" }, "call-2"),
        toolCall("read_skill_resource", { name: "polish", path: "references/style.md" }, "call-3"),
        // A room of 6,000 characters for the two results.
        finish("tool-calls", { input: contextLimit(WINDOW) - 2000 - 10, output: 10 }),
      ],
      answerScript("done"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    await push(session.ref, "a");
    await until(() => events(logs, "prq.skill.read").length === 1 && workspace.scriptRuns.length === 1, "the read");
    const stdout = "o".repeat(5000);
    reply.resolve({
      ending: { kind: "exit", code: 0 },
      scratch: "lost",
      stdout,
      stdoutChars: stdout.length,
      stderr: "",
      stdoutBytes: stdout.length,
      stderrBytes: 0,
      clean: true,
    });
    expect(await untilEnded(session.stub, sha("a"))).toEqual({ state: "done", failure: null });

    const result = toolTraffic(model.calls.at(-1)).results.find((entry) => entry.toolName === "run_skill_script")?.text;
    const head = `${statusOf("run_skill_script", skill, "exit 0")}\n${lostScratch("analysis")}\n`;
    expect(result?.startsWith(head)).toBe(true);
    const note = /\n\[(\d+) more characters of output not shown\]$/.exec(result ?? "");
    expect(note).not.toBeNull();
    const shown = (result ?? "").slice(head.length, note?.index);
    expect(shown.length).toBeGreaterThan(0);
    expect(Number(note?.[1])).toBe(stdout.length - shown.length);
    expect(workspace.scriptRuns[0]?.capChars).toBeGreaterThan(shown.length);
  });

  it("still carries the count of what was not shown when a parallel result took all the room", async () => {
    const logs = captureLogs();
    const skill = await registered(
      scripted({ files: { "references/style.md": "s".repeat(10_000), "scripts/check.py": CHECK_PY } }),
    );
    const workspace = new FakeWorkspace();
    useWorkspace(workspace);
    const reply = Promise.withResolvers<ScriptResult>();
    workspace.scriptReply = () => reply.promise;
    const session = await cloudSession("scripts", sockets);
    const model = new ScriptedModel().add(
      activate(),
      [
        toolCall("run_skill_script", { name: "polish", command: "python3 scripts/check.py" }, "call-2"),
        toolCall("read_skill_resource", { name: "polish", path: "references/style.md" }, "call-3"),
        // A room of 6,000 characters for the two results, the read's page cut to whatever the run leaves.
        finish("tool-calls", { input: contextLimit(WINDOW) - 2000 - 10, output: 10 }),
      ],
      answerScript("done"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    await push(session.ref, "a");
    await until(() => events(logs, "prq.skill.read").length === 1 && workspace.scriptRuns.length === 1, "the read");
    const stdout = "o".repeat(500);
    reply.resolve({
      ending: { kind: "exit", code: 0 },
      scratch: "new",
      stdout,
      stdoutChars: stdout.length,
      stderr: "",
      stdoutBytes: stdout.length,
      stderrBytes: 0,
      clean: true,
    });
    expect(await untilEnded(session.stub, sha("a"))).toEqual({ state: "done", failure: null });

    const result = toolTraffic(model.calls.at(-1)).results.find((entry) => entry.toolName === "run_skill_script")?.text;
    const head = `${statusOf("run_skill_script", skill, "exit 0")}\n`;
    expect(result?.startsWith(head)).toBe(true);
    const note = /\[(\d+) more characters of output not shown\]$/.exec(result ?? "");
    expect(note).not.toBeNull();
    const shown = (result ?? "").slice(head.length, note?.index).replace(/\n$/, "");
    expect(stdout.startsWith(shown)).toBe(true);
    expect(Number(note?.[1])).toBe(stdout.length - shown.length);
  });

  // The count only when stdout was cut: an empty stdout gets none, even past the room.
  it.each([
    { chars: 500, tail: "\n[500 more characters of output not shown]" },
    { chars: 0, tail: "" },
  ])(
    "still carries its status line, and the count when cut, when parallel reads were charged past the room ($chars characters of stdout)",
    async ({ chars, tail }) => {
      const logs = captureLogs();
      const skill = await registered(
        scripted({
          files: {
            "references/a.md": "a".repeat(10_000),
            "references/b.md": "b".repeat(10_000),
            "references/c.md": "c".repeat(10_000),
            "scripts/check.py": CHECK_PY,
          },
        }),
      );
      const workspace = new FakeWorkspace();
      useWorkspace(workspace);
      const reply = Promise.withResolvers<ScriptResult>();
      workspace.scriptReply = () => reply.promise;
      const session = await cloudSession("scripts", sockets);
      const model = new ScriptedModel().add(
        activate(),
        [
          toolCall("run_skill_script", { name: "polish", command: "python3 scripts/check.py" }, "call-2"),
          read("references/a.md", "call-3"),
          read("references/b.md", "call-4"),
          read("references/c.md", "call-5"),
          // A room of 6,000 characters: one read takes a page of it, the other two are charged their no-room replies.
          finish("tool-calls", { input: contextLimit(WINDOW) - 2000 - 10, output: 10 }),
        ],
        answerScript("done"),
      );
      model.contextTokens = WINDOW;
      useCloudModel(model);
      await push(session.ref, "a");
      await until(() => events(logs, "prq.skill.read").length === 3 && workspace.scriptRuns.length === 1, "the reads");
      const stdout = "o".repeat(chars);
      reply.resolve({
        ending: { kind: "exit", code: 0 },
        scratch: "new",
        stdout,
        stdoutChars: stdout.length,
        stderr: "",
        stdoutBytes: stdout.length,
        stderrBytes: 0,
        clean: true,
      });
      expect(await untilEnded(session.stub, sha("a"))).toEqual({ state: "done", failure: null });

      const results = toolTraffic(model.calls.at(-1)).results;
      const reads = results.filter((entry) => entry.toolName === "read_skill_resource").map((entry) => entry.text);
      expect(reads.filter((text) => text.startsWith(statusOf("read_skill_resource", skill, "read")))).toHaveLength(1);
      expect(reads.filter((text) => text.startsWith(statusOf("read_skill_resource", skill, "no room")))).toHaveLength(
        2,
      );
      expect(results.find((entry) => entry.toolName === "run_skill_script")?.text).toBe(
        `${statusOf("run_skill_script", skill, "exit 0")}${tail}`,
      );
    },
  );

  it("runs with 399 characters of room, as many as before the count was held for", async () => {
    captureLogs();
    const skill = await registered(scripted());
    const workspace = new FakeWorkspace();
    useWorkspace(workspace);
    workspace.scriptReply = () => ({
      ending: { kind: "exit", code: 0 },
      scratch: "new",
      stdout: "ok\n",
      stdoutChars: 3,
      stderr: "",
      stdoutBytes: 3,
      stderrBytes: 0,
      clean: true,
    });
    const session = await cloudSession("scripts", sockets);
    const model = new ScriptedModel().add(
      activate(),
      [
        toolCall("run_skill_script", { name: "polish", command: "python3 scripts/check.py" }, "call-2"),
        // A room of 399 characters for the result.
        finish("tool-calls", { input: contextLimit(WINDOW) - 133 - 10, output: 10 }),
      ],
      answerScript("done"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    await push(session.ref, "a");
    expect(await untilEnded(session.stub, sha("a"))).toEqual({ state: "done", failure: null });

    expect(workspace.scriptRuns).toHaveLength(1);
    expect(lastResults(model).at(-1)).toBe(`${statusOf("run_skill_script", skill, "exit 0")}\nok\n`);
  });

  it("shows the whole stdout with no count when only stderr's tail was cut", async () => {
    captureLogs();
    const skill = await registered(scripted());
    const workspace = new FakeWorkspace();
    useWorkspace(workspace);
    const stdout = "o".repeat(100);
    const stderr = "e".repeat(STDERR_TAIL_CHARS);
    workspace.scriptReply = () => ({
      ending: { kind: "exit", code: 0 },
      scratch: "new",
      stdout,
      stdoutChars: stdout.length,
      stderr,
      stdoutBytes: stdout.length,
      stderrBytes: 5000,
      clean: true,
    });
    const session = await cloudSession("scripts", sockets);
    const model = new ScriptedModel().add(
      activate(),
      [
        toolCall("run_skill_script", { name: "polish", command: "python3 scripts/check.py" }, "call-2"),
        // A room of 1,350 characters: stdout fits, stderr's tail does not.
        finish("tool-calls", { input: contextLimit(WINDOW) - 450 - 10, output: 10 }),
      ],
      answerScript("done"),
    );
    model.contextTokens = WINDOW;
    useCloudModel(model);
    await push(session.ref, "a");
    expect(await untilEnded(session.stub, sha("a"))).toEqual({ state: "done", failure: null });

    const result = toolTraffic(model.calls.at(-1)).results.find((entry) => entry.toolName === "run_skill_script")?.text;
    const label = `stderr (last ${STDERR_TAIL_CHARS} characters):\n`;
    expect(result?.startsWith(`${statusOf("run_skill_script", skill, "exit 0")}\n${stdout}\n${label}e`)).toBe(true);
    expect(result?.length).toBeLessThan(1350);
    expect(result).not.toMatch(/more characters/);
  });
});

// The analysis activates polish, then its run is held until `during` is done.
async function heldRun(during: () => Promise<void>) {
  const session = await cloudSession("scripts", sockets);
  const container = containerOf(session.name);
  container.mergeBase = BASE;
  const held = await gate(session.stub);
  const model = new ScriptedModel().add(
    activate(),
    [
      { hold: held },
      toolCall("run_skill_script", { name: "polish", command: "python3 scripts/check.py" }, "call-2"),
      finish("tool-calls"),
    ],
    answerScript("done"),
  );
  useCloudModel(model);
  await push(session.ref, "a");
  await held.reached();
  await during();
  await held.open();
  expect(await untilEnded(session.stub, sha("a"))).toEqual({ state: "done", failure: null });
  return { container, result: lastResults(model).at(-1) };
}

describe("the turn's revision", () => {
  const changed =
    "error: the skill polish was updated or removed after this summary started; its current version applies from " +
    "the next summary";

  it("refuses a run once the skill was updated before its bundle was read, with no exec", async () => {
    captureLogs();
    const skill = await registered(scripted());
    const { container, result } = await heldRun(async () => {
      expect(await (await hub()).updateSkill(scripted({ sha: "b".repeat(40) }), skill.rev)).toHaveProperty("rev");
    });
    expect(result).toBe(changed);
    expect(runnerExecs(container)).toEqual([]);
  });

  it("refuses a run once the skill was removed and registered again at the same commit, with no exec", async () => {
    captureLogs();
    await registered(scripted());
    const { container, result } = await heldRun(async () => {
      expect(await (await hub()).removeSkill("polish")).toBe(true);
      await registered(scripted());
    });
    expect(result).toBe(changed);
    expect(runnerExecs(container)).toEqual([]);
  });

  it("runs the bundle it read when the skill is updated after the read and before the exec", async () => {
    captureLogs();
    const skill = await registered(scripted());
    const session = await cloudSession("scripts", sockets);
    const container = containerOf(session.name);
    container.mergeBase = BASE;
    const exec = container.holdExec(isRunnerArgv);
    const model = new ScriptedModel().add(activate(), run("python3 scripts/check.py", "call-2"), answerScript("done"));
    useCloudModel(model);
    await push(session.ref, "a");
    await untilHeld(exec);
    const update = scripted({
      sha: "b".repeat(40),
      files: { "references/style.md": "# B\n", "scripts/check.py": "print('B')\n" },
    });
    expect(await (await hub()).updateSkill(update, skill.rev)).toHaveProperty("rev");
    await runInDurableObject(workspaceOf(session.name), () => exec.open());
    expect(await untilEnded(session.stub, sha("a"))).toEqual({ state: "done", failure: null });
    expect(container.spawned[0]?.files.get("scripts/check.py")?.text).toBe(CHECK_PY);
    expect(lastResults(model).at(-1)).toBe(statusOf("run_skill_script", skill, "exit 0"));
  });
});

describe("the call's bound", () => {
  it("gives the model the Workspace's own answer at SCRIPT_CALL_MS, not the tool's timeout", async () => {
    captureLogs();
    const skill = await registered(scripted());
    const workspace = new FakeWorkspace();
    useWorkspace(workspace);
    workspace.scriptReply = () =>
      new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              ending: {
                kind: "unknown",
                reason: `the script call reached its bound of ${SCRIPT_CALL_MS / 60_000} minutes`,
              },
              scratch: null,
              stdout: "",
              stdoutChars: 0,
              stderr: "",
              stdoutBytes: 0,
              stderrBytes: 0,
              clean: false,
            }),
          SCRIPT_CALL_MS,
        );
      });
    const session = await cloudSession("scripts", sockets);
    const model = new ScriptedModel().add(activate(), run("python3 scripts/check.py", "call-2"), answerScript("done"));
    useCloudModel(model);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The AI SDK bounds a tool's execution with AbortSignal.timeout, which fake timers do not drive: here the fake
    // setTimeout drives it, so the tool's own bound (SCRIPT_TOOL_MS) runs on the same clock as the Workspace's answer.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const timedOut = new AbortController();
      setTimeout(() => timedOut.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
      return timedOut.signal;
    });
    await push(session.ref, "a");
    await until(() => workspace.scriptRuns.length === 1, "the run");
    await advance(session.stub, SCRIPT_CALL_MS - 1);
    expect(model.calls).toHaveLength(2);
    await advance(session.stub, 1);
    await until(() => model.calls.length === 3, "the answer");
    expect(lastResults(model).at(-1)).toBe(
      `${statusOf("run_skill_script", skill, "error")}\nerror: the script's ending is unknown (the script call ` +
        `reached its bound of ${SCRIPT_CALL_MS / 60_000} minutes); its effects may or may not have happened`,
    );
  });
});

describe("an earlier turn's run", () => {
  it("reaches the next turn and a summary request only as its marker, and its log holds no argument, input or output", async () => {
    const logs = captureLogs();
    const skill = await registered(scripted());
    const session = await cloudSession("scripts", sockets);
    const { stub, client } = session;
    await seedHistory(stub, [question("q0"), cloudAnswer("q0", [{ type: "text", text: "answer zero" }])]);
    const container = containerOf(session.name);
    container.mergeBase = BASE;
    container.onScript = () => ({ stdout: "OUT-SENTINEL", stderr: "ERR-SENTINEL" });
    const stdin = `STDIN-SENTINEL${"i".repeat(100_000 - 14)}`;
    const model = new ScriptedModel().add(
      activate(),
      run("python3 scripts/check.py ARG-SENTINEL 'ARG SENTINEL 2'", "call-2", stdin),
      answerScript(sized("the summary", 11_000)),
      // Measured near the limit: the next turn's start compacts.
      answerScript(sized("answer one", 5500), { input: 12_000, output: 5500 }),
      answerScript("## Key facts\nthe notes", { input: 100, output: 50 }),
      answerScript("answer two"),
    );
    useCloudModel(model);
    await push(session.ref, "a");
    expect(await untilEnded(stub, sha("a"))).toEqual({ state: "done", failure: null });
    expect(lastResults(model).at(-1)).toBe(
      `${statusOf("run_skill_script", skill, "exit 0")}\nOUT-SENTINEL\nstderr (last ${STDERR_TAIL_CHARS} characters):\nERR-SENTINEL`,
    );
    expect(container.spawned[0]?.input).toBe(stdin);

    // The next turn's first request.
    await client.chat([question("q1")]);
    expect(await untilEnded(stub, "q1")).toEqual({ state: "done", failure: null });
    const next = model.calls[3];
    expect(toolTraffic(next)).toEqual({
      calls: [
        { toolName: "activate_skill", input: { name: "polish" } },
        { toolName: "run_skill_script", input: { name: "polish" } },
      ],
      results: [
        { toolName: "activate_skill", text: marker("activate_skill", skill) },
        { toolName: "run_skill_script", text: marker("run_skill_script", skill, "exit 0") },
      ],
    });
    expect(JSON.stringify(next?.prompt)).not.toMatch(/SENTINEL/);

    // A compaction at the next turn's start summarizes the analysis: its request holds the markers.
    model.contextTokens = WINDOW;
    await client.chat([question("q2")]);
    expect(await untilEnded(stub, "q2")).toEqual({ state: "done", failure: null });
    const summary = model.calls.filter(isSummaryCall).map(summaryPrompt).join("\n");
    expect(summary).toContain('[Assistant tool calls]: run_skill_script(name="polish")\n');
    expect(summary).toContain(`[Tool result]: ${marker("run_skill_script", skill, "exit 0")}`);
    expect(summary).not.toMatch(/SENTINEL/);
    expect(JSON.stringify(model.calls.at(-1)?.prompt)).not.toMatch(/SENTINEL/);

    const [logged] = events(logs, "prq.skill.script");
    expect(Object.keys(logged ?? {}).toSorted()).toEqual(
      [
        "event",
        "pr",
        "jobId",
        "name",
        "rev",
        "sha",
        "script",
        "ending",
        "ms",
        "stdoutBytes",
        "stderrBytes",
        "scratch",
        "clean",
      ].toSorted(),
    );
    expect(logged).toMatchObject({
      name: "polish",
      rev: skill.rev,
      sha: skill.sha,
      script: "scripts/check.py",
      ending: "exit 0",
      stdoutBytes: 12,
      scratch: "new",
      clean: true,
    });
    expect(JSON.stringify(events(logs, "prq.skill.script"))).not.toMatch(/SENTINEL|iiii/);
  });
});

describe("an activation with allowed-tools at its cap", () => {
  it("still carries body text on its first page with a full room", async () => {
    captureLogs();
    const files: Record<string, string> = {};
    const entries: string[] = [];
    let index = 0;
    while (entries.join(" ").length + 32 <= SKILL_ALLOWED_TOOLS_CHARS) {
      const path = `scripts/s${String(index).padStart(3, "0")}.py`;
      files[path] = "print(1)\n";
      entries.push(`Bash(python3 ${path} *)`);
      index += 1;
    }
    // The last entry's fixed words fill the field to the character.
    const last = entries.pop() ?? "";
    const pad = SKILL_ALLOWED_TOOLS_CHARS - entries.join(" ").length - 1 - last.length;
    entries.push(last.replace(" *)", ` ${"w".repeat(pad - 1)} *)`));
    expect(entries.join(" ")).toHaveLength(SKILL_ALLOWED_TOOLS_CHARS);
    const body = Array.from({ length: 400 }, (_, i) => `rule ${i}`.padEnd(60, ".")).join("\n");
    const skill = await registered(skillWith("polish", { body, files, allowedTools: entries }));
    expect(skill.allowedTools?.every((tool) => tool.runs)).toBe(true);

    const { model } = await analysis([activate(), answerScript("done")]);
    const page = lastResults(model).at(-1) ?? "";
    expect(page.length).toBeLessThanOrEqual(12_000);
    const header = page.split("\n").slice(0, 4);
    expect(header[0]).toBe(statusOf("activate_skill", skill));
    expect(header[3]).toContain(entries.map((entry) => entry.slice(5, -1)).join("; "));
    const shown = page.split("\n").slice(4).join("\n");
    expect(shown.startsWith("rule 0")).toBe(true);
    expect(shown.length).toBeGreaterThan(9000);
  });
});

describe("a left running marker", () => {
  it("makes every run an error naming the restart while git keeps answering, and a restarted container runs again", async () => {
    captureLogs();
    const skill = await registered(scripted());
    const session = await analysis(
      [
        activate(),
        run("python3 scripts/check.py", "call-2"),
        toolStep("read_file", { path: "README.md" }, "call-3"),
        run("python3 scripts/check.py", "call-4"),
        answerScript("done"),
      ],
      (container) => {
        const served = container.on;
        // The marker is left once the first checkout is ready.
        let left = false;
        container.on = (argv) => {
          if (argv[0] === "sh" && !left) {
            left = true;
            queueMicrotask(() => {
              container.runner.running = true;
            });
          }
          return served(argv);
        };
      },
    );
    const unclean =
      `${statusOf("run_skill_script", skill, "error")}\nerror: the processes of an earlier script run could not be ` +
      "confirmed ended, so scripts do not run until the workspace restarts (after 30 minutes without a request); go " +
      "on without the script";
    expect(lastResults(session.model).slice(1)).toEqual([unclean, "1\t# demo", unclean]);
    expect(session.container.spawned).toEqual([]);

    session.container.stop();
    session.model.add(activate(), run("python3 scripts/check.py", "call-2"), answerScript("again"));
    await session.client.chat([question("q1")]);
    expect(await untilEnded(session.stub, "q1")).toEqual({ state: "done", failure: null });
    expect(lastResults(session.model).at(-1)).toBe(statusOf("run_skill_script", skill, "exit 0"));
    expect(session.container.runnerEnds.at(-1)).toMatchObject({ scratch: "new", end: "exit:0" });
  });
});
