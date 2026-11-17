// The local stack's end: whether a signal comes during its start or after it printed its control commands, and when its
// last start step fails, it stops every process it started (the worker process and its process group: workerd and
// esbuild), removes its fixture root and prints `stopped`. The stack runs as `pnpm run stack` runs it, a child process.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it, onTestFinished, vi } from "vitest";

const run = promisify(execFile);
const STACK = fileURLToPath(new URL("./local-stack.ts", import.meta.url));
const STARTING = /^prq local stack: starting in (\S+), the worker process (\d+) in a process group of its own$/;
const STOPPED = "prq local stack: stopped";
// The start bundles and runs the Worker: seconds, more on a busy machine.
const START_MS = 60_000;

type Started = { root: string; pid: number };

function startStack() {
  const child = spawn(process.execPath, [STACK], { stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    const parts = stdout.split("\n");
    stdout = parts.pop() ?? "";
    lines.push(...parts);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  let started: Started | null = null;
  // If the test fails part way: the stack, its worker process group and its root end here.
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    if (started !== null) {
      try {
        process.kill(-started.pid, "SIGKILL");
      } catch {
        // Ended.
      }
      await rm(started.root, { recursive: true, force: true });
    }
  });
  return {
    pid: child.pid ?? 0,
    lines,
    stderr: () => stderr,
    exited,
    async started(): Promise<Started> {
      const match = await vi.waitFor(
        () => {
          const found = lines.map((line) => STARTING.exec(line)).find((m) => m !== null);
          if (found?.[1] === undefined || found[2] === undefined) {
            throw new Error(`no starting line yet: ${JSON.stringify(lines)}`);
          }
          return found;
        },
        { timeout: START_MS, interval: 20 },
      );
      started = { root: match[1] ?? "", pid: Number(match[2]) };
      return started;
    },
    async line(prefix: string): Promise<number> {
      return vi.waitFor(
        () => {
          const index = lines.findIndex((line) => line.startsWith(prefix));
          if (index === -1) {
            throw new Error(`no line starting ${prefix} yet: ${JSON.stringify(lines)}`);
          }
          return index;
        },
        { timeout: START_MS, interval: 50 },
      );
    },
  };
}

// The processes of a process group, by ID.
async function group(pgid: number): Promise<number[]> {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,pgid="]);
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, id]) => id === pgid && pid !== undefined)
    .map(([pid]) => pid ?? 0);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the local stack", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "%s after the control commands: stops its processes, removes its root, prints stopped, ends by the signal",
    async (signal) => {
      const stack = startStack();
      const { root, pid } = await stack.started();
      const control = await stack.line("Control: ");
      // The worker process, workerd and esbuild.
      const members = await group(pid);
      expect(members).toContain(pid);
      expect(members.length).toBeGreaterThanOrEqual(3);

      process.kill(stack.pid, signal);
      expect(await stack.exited).toEqual({ code: null, signal });
      expect(stack.lines.at(-1)).toBe(STOPPED);
      expect(stack.lines.indexOf(STOPPED)).toBeGreaterThan(control);
      expect(existsSync(root)).toBe(false);
      expect(await group(pid)).toEqual([]);
      expect(members.filter(alive)).toEqual([]);
    },
    START_MS * 2,
  );

  it.each(["SIGINT", "SIGTERM"] as const)(
    "%s during the start: stops what started, removes its root, prints stopped, ends by the signal",
    async (signal) => {
      const stack = startStack();
      const { root, pid } = await stack.started();

      process.kill(stack.pid, signal);
      expect(await stack.exited).toEqual({ code: null, signal });
      expect(stack.lines.at(-1)).toBe(STOPPED);
      expect(stack.lines.some((line) => line.startsWith("Control: "))).toBe(false);
      expect(existsSync(root)).toBe(false);
      expect(await group(pid)).toEqual([]);
    },
    START_MS * 2,
  );

  it(
    "POST /stop: stops its processes, removes its root, prints stopped, exit 0",
    async () => {
      const stack = startStack();
      const { root, pid } = await stack.started();
      const control = await stack.line("Control: ");
      const url = /^Control: curl -s -X POST (\S+)\/<command>/.exec(stack.lines[control] ?? "")?.[1];

      expect(await (await fetch(`${url}/stop`, { method: "POST" })).text()).toBe("stopping\n");
      expect(await stack.exited).toEqual({ code: 0, signal: null });
      expect(stack.lines.at(-1)).toBe(STOPPED);
      expect(existsSync(root)).toBe(false);
      expect(await group(pid)).toEqual([]);
    },
    START_MS * 2,
  );

  it(
    "a failed last start step (session.env cannot be written): ends what started, removes its root, exit 1",
    async () => {
      const stack = startStack();
      const { root, pid } = await stack.started();
      // A directory where the start writes session.env, made while the Worker is still starting.
      await mkdir(join(root, "session.env"));

      expect(await stack.exited).toEqual({ code: 1, signal: null });
      expect(stack.stderr()).toMatch(/^prq local stack: the start failed: EISDIR/m);
      expect(stack.lines.at(-1)).toBe(STOPPED);
      expect(stack.lines.some((line) => line.startsWith("Control: "))).toBe(false);
      expect(existsSync(root)).toBe(false);
      expect(await group(pid)).toEqual([]);
    },
    START_MS * 2,
  );
});
