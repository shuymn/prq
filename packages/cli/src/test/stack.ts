// What an end-to-end test file runs against: one Worker for the file, reset before each test, behind the stand-in
// Access, and the CLI runs of the test, each with a fresh HOME and state root in the test's fixture root (outside every
// repository), and git isolated in it as the fixtures' git is. A run still going when its test ends is killed, and its
// exit awaited, before the next test starts.

import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";

import { type Access, startAccess } from "./access.ts";
import { type Exit, type Running, startCli } from "./cli.ts";
import { fixtureRoot, gitEnv } from "./git.ts";
import { agents } from "./pr.ts";
import { startWorker, type Worker } from "./worker.ts";

type EnvOverrides = Readonly<Record<string, string | undefined>>;

export type Stack = {
  worker(): Worker;
  access(): Access;
  // The test's fixture root (src/test/git.ts): the CLI's HOME, and its working directory unless a run names another.
  dir(): string;
  // The test's state root (PRQ_HOME).
  home(): string;
  start(args: readonly string[], env?: EnvOverrides, cwd?: string): Running;
  run(args: readonly string[], env?: EnvOverrides, cwd?: string): Promise<Exit>;
  // Resolves once the Hub lists the agent as waiting.
  waiting(agentId: string): Promise<void>;
};

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} is not started`);
  }
  return value;
}

export function useStack(): Stack {
  let worker: Worker | undefined;
  let access: Access | undefined;
  let dir: string | undefined;
  const running = new Set<Running>();

  beforeAll(async () => {
    worker = await startWorker();
    access = await startAccess(worker);
  });
  beforeEach(async () => {
    await required(worker, "the Worker").reset();
    required(access, "the stand-in").clear();
    dir = await fixtureRoot("prq-cli-");
  });
  afterEach(async () => {
    await Promise.all([...running].map((run) => run.kill()));
    running.clear();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  });
  afterAll(async () => {
    await access?.close();
    await worker?.close();
  });

  const stack: Stack = {
    worker: () => required(worker, "the Worker"),
    access: () => required(access, "the stand-in"),
    dir: () => required(dir, "the test directory"),
    home: () => join(stack.dir(), "state"),
    start(args, overrides = {}, cwd = stack.dir()) {
      const home = stack.dir();
      const stand = stack.access();
      const env: Record<string, string> = {};
      const base: EnvOverrides = {
        ...gitEnv(home),
        PRQ_HOME: stack.home(),
        PRQ_URL: stand.url,
        PRQ_ACCESS_CLIENT_ID: stand.clientId,
        PRQ_ACCESS_CLIENT_SECRET: stand.clientSecret,
      };
      for (const [name, value] of Object.entries({ ...base, ...overrides })) {
        if (value !== undefined) {
          env[name] = value;
        }
      }
      const run = startCli(args, env, cwd);
      running.add(run);
      const forget = () => running.delete(run);
      void run.exited.then(forget, forget);
      return run;
    },
    run: (args, overrides, cwd) => stack.start(args, overrides, cwd).exited,
    async waiting(agentId) {
      await vi.waitFor(
        async () => {
          const row = (await agents(stack.worker())).find((agent) => agent.agentId === agentId);
          expect(row?.waiting).toBe(true);
        },
        { timeout: 10_000, interval: 50 },
      );
    },
  };
  return stack;
}
