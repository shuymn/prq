#!/usr/bin/env node
// prq: the local runner's CLI. Spike scope: wait, claim, submit (context / checkout / reconcile are not part of it).
import { hostname } from "node:os";
import { parseArgs } from "node:util";

import { ClaimResponse, SubmitResponse, WaitResponse, type JobTarget } from "@prq/protocol";

import { AuthError, ConflictError, post, type Config } from "./http.ts";

/** Exit codes the AI's procedure tells apart. */
export const EXIT = { ok: 0, error: 1, timeout: 2, auth: 3, conflict: 4 } as const;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "agent-id": { type: "string" },
    "poll-ms": { type: "string" },
    "max-wait-ms": { type: "string" },
    session: { type: "string" },
    job: { type: "string" },
    claim: { type: "string" },
    kind: { type: "string" },
    target: { type: "string" },
    text: { type: "string" },
  },
});

const config: Config = {
  baseUrl: process.env["PRQ_URL"] ?? "http://localhost:8787",
  token: process.env["PRQ_ACCESS_TOKEN"] ?? "",
  agentId: values["agent-id"] ?? process.env["PRQ_AGENT_ID"] ?? hostname(),
};

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function wait(): Promise<number> {
  const pollMs = Number(values["poll-ms"] ?? 20_000);
  const deadline = Date.now() + Number(values["max-wait-ms"] ?? 30 * 60_000);
  let backoff = 500;
  // Each long-poll is short; reconnecting re-checks pending jobs, so a dropped connection loses nothing.
  while (Date.now() < deadline) {
    const timeoutMs = Math.max(0, Math.min(pollMs, deadline - Date.now()));
    try {
      const res = await post(config, "/cli/wait", { agentId: config.agentId, timeoutMs }, WaitResponse, timeoutMs + 10_000);
      backoff = 500;
      if (res.status === "ready") {
        print(res);
        return EXIT.ok;
      }
    } catch (e) {
      if (e instanceof AuthError) throw e;
      process.stderr.write(`prq wait: ${(e as Error).message}; retrying\n`);
      await new Promise((r) => setTimeout(r, Math.min(backoff, Math.max(0, deadline - Date.now()))));
      backoff = Math.min(backoff * 2, 10_000);
    }
  }
  print({ status: "timeout" });
  return EXIT.timeout;
}

async function claim(): Promise<number> {
  print(await post(config, "/cli/claim", { agentId: config.agentId }, ClaimResponse, 30_000));
  return EXIT.ok;
}

async function submit(): Promise<number> {
  const kind = values.kind ?? "answer";
  const t = values.target ?? "";
  const target: JobTarget = kind === "analysis" ? { kind: "analysis", headSha: t } : { kind: "answer", messageId: t };
  const body = {
    agentId: config.agentId,
    session: values.session,
    jobId: values.job,
    claimId: values.claim,
    target,
    text: values.text ?? "",
  };
  print(await post(config, "/cli/submit", body, SubmitResponse, 30_000));
  return EXIT.ok;
}

const commands: Record<string, () => Promise<number>> = { wait, claim, submit };

async function main(): Promise<number> {
  const command = commands[positionals[0] ?? ""];
  if (!command) {
    process.stderr.write("usage: prq <wait|claim|submit> [options]\n");
    return EXIT.error;
  }
  try {
    return await command();
  } catch (e) {
    if (e instanceof AuthError) {
      process.stderr.write(`prq: authentication failed: ${e.message}\n`);
      return EXIT.auth;
    }
    if (e instanceof ConflictError) {
      print(e.body);
      return EXIT.conflict;
    }
    process.stderr.write(`prq: ${(e as Error).message}\n`);
    return EXIT.error;
  }
}

process.exitCode = await main();
