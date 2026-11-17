#!/usr/bin/env node
// prq: the local agent's CLI (docs/design.md, Local CLI). stdout carries at most one JSON line, the command's result
// with the step the AI takes next; stderr carries notices and errors, each line starting `prq:`.
import { homedir, hostname } from "node:os";
import { parseArgs } from "node:util";

import { Client, VersionNotice } from "./client.ts";
import { claim } from "./commands/claim.ts";
import { wait } from "./commands/wait.ts";
import { readConfig } from "./config.ts";
import { CliError, EXIT, type ExitCode } from "./errors.ts";
import { systemClock } from "./retry.ts";
import { State } from "./state.ts";
import { CLI_VERSION } from "./version.ts";

const USAGE = `usage: prq <command> [options]

commands:
  wait [--timeout <seconds>]  wait until the agent may have a job (default 1500 seconds)
  claim                       claim the agent's job and save it

options:
  --agent-id <id>  the agent ID (default: PRQ_AGENT_ID, else the host name)
  --help           print this help
  --version        print the version

environment:
  PRQ_URL                    the Worker's origin (https://<host>)
  PRQ_ACCESS_CLIENT_ID       the Access service token's client ID
  PRQ_ACCESS_CLIENT_SECRET   the Access service token's client secret
  PRQ_AGENT_ID               the agent ID
  PRQ_HOME                   the state directory (default: $XDG_STATE_HOME/prq, else ~/.local/state/prq)
  PRQ_VERSION_NOTICE=0       no notice when the server's version differs

exit codes: 0 done, 1 error, 2 wait timed out, 3 authentication failure, 4 claim mismatch
`;

const DEFAULT_WAIT_S = 1500;

function print(result: object): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function stderr(line: string): void {
  process.stderr.write(`prq: ${line}\n`);
}

// A usage error: the message and the usage on stderr, exit 1.
class UsageError extends Error {
  override readonly name = "UsageError";
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        "agent-id": { type: "string" },
        timeout: { type: "string" },
        help: { type: "boolean" },
        version: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

// --timeout: whole seconds, 0 or more.
function waitSeconds(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_WAIT_S;
  }
  if (!/^[0-9]{1,9}$/.test(value)) {
    throw new UsageError("--timeout takes whole seconds");
  }
  return Number(value);
}

async function main(argv: string[]): Promise<ExitCode> {
  const { values, positionals } = parse(argv);
  if (values.help === true) {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }
  if (values.version === true) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return EXIT.ok;
  }
  const [command, ...rest] = positionals;
  if (command === undefined) {
    throw new UsageError("no command");
  }
  if (rest.length > 0) {
    throw new UsageError(`unexpected argument ${JSON.stringify(rest[0])}`);
  }
  if (command !== "wait" && command !== "claim") {
    throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
  if (command !== "wait" && values.timeout !== undefined) {
    throw new UsageError("--timeout applies to wait only");
  }
  const timeoutS = command === "wait" ? waitSeconds(values.timeout) : 0;
  const config = readConfig(process.env, values["agent-id"], { hostname: hostname(), homedir: homedir() });
  const client = new Client(config, new VersionNotice(CLI_VERSION, config.versionNotice, stderr), stderr, systemClock);
  if (command === "wait") {
    return wait(client, systemClock, config.agentId, timeoutS, print);
  }
  return claim(client, new State(config.home, config.agentId), config.agentId, print, stderr);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    stderr(error.message);
    process.stderr.write(USAGE);
    process.exitCode = EXIT.error;
  } else if (error instanceof CliError) {
    stderr(error.message);
    process.exitCode = error.exitCode;
  } else {
    stderr(error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT.error;
  }
}
