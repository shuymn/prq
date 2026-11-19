// The deployed checks, `pnpm run check:deployed -- <mode>` in packages/cli: the owner's checks of the real deployment.
// docs/operations.md (The deployed checks) gives the modes, their arguments, when to run each and what they print.
// This entry reads the command line and the CLI's configuration, runs the mode, prints each observation, and exits 1
// on a failure and 130 on Ctrl-C, which ends what the run started; --json <file> saves the run to a new file.

import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";

import { readConfig } from "../config.ts";
import { CliError } from "../errors.ts";
import { CLI_VERSION } from "../version.ts";
import { BUILD } from "./build.ts";
import {
  checkEdge,
  checkEndpoints,
  EDGE_PACE,
  type PrqConfig,
  runTool,
  withPrq,
  workersDevUrls,
} from "./deployed-edge.ts";
import { type Invocation, parseInvocation, UsageError } from "./deployed-invocation.ts";
import { Report } from "./deployed-report.ts";
import {
  checkAsk,
  checkSummary,
  githubHead,
  listJobs,
  PACE,
  retryJob,
  type SessionContext,
  waitForEmptyPool,
} from "./deployed-session.ts";
import { CheckError, errorKind, serviceOrigin } from "./origin.ts";

const CLIENT_DIR = fileURLToPath(new URL("../../../server/dist/client", import.meta.url));
// How long the edge's build of prq may take.
const BUILD_MS = 5 * 60_000;

async function run(
  invocation: Invocation,
  report: Report,
  signal: AbortSignal,
  config: PrqConfig | null,
): Promise<void> {
  if (invocation.mode === "endpoints") {
    if (invocation.subdomain === null) {
      report.add({
        id: "E10",
        what: "workers.dev",
        verdict: "unexercised",
        observed: "no subdomain given; the dashboard's production and preview settings are the evidence",
      });
      return;
    }
    await checkEndpoints(workersDevUrls(invocation.subdomain, invocation.version), report, signal);
    report.note(
      "also read the dashboard: Workers & Pages, prq, Settings, Domains & Routes (workers.dev and Preview URLs disabled)",
    );
    return;
  }
  if (config === null) {
    throw new CheckError("no deployment to check");
  }
  const context: SessionContext = { origin: serviceOrigin(config.url, config), report, signal, pace: PACE };
  // The deployment's hostnames, which the tools' environment does not name.
  const hosts = [new URL(config.url).hostname];
  switch (invocation.mode) {
    case "edge":
      report.note("building prq from this checkout");
      await runTool(BUILD.command, BUILD.args, {
        cwd: BUILD.cwd,
        timeoutMs: BUILD_MS,
        signal,
        withheld: [...hosts, new URL(invocation.teamDomain).hostname],
      });
      await withPrq(config, signal, (prq) =>
        checkEdge(
          {
            config,
            teamDomain: invocation.teamDomain,
            version: CLI_VERSION,
            clientDir: CLIENT_DIR,
            ...(invocation.pr === undefined ? {} : { pr: invocation.pr }),
            prq,
            pace: EDGE_PACE,
            signal,
          },
          report,
        ),
      );
      return;
    case "pool":
      await waitForEmptyPool(context);
      return;
    case "summary":
      await checkSummary(context, {
        repo: invocation.repo,
        headOf: (pr, bounded) => githubHead(pr, bounded, hosts),
      });
      return;
    case "ask":
      await checkAsk(context, invocation.pr, invocation.text);
      return;
    case "jobs":
      await listJobs(context, invocation.pr);
      return;
    case "retry":
      await retryJob(context, invocation.pr, invocation.jobId);
      return;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  let invocation: Invocation;
  try {
    invocation = parseInvocation(argv);
  } catch (error) {
    process.stderr.write(`check:deployed: ${error instanceof UsageError ? error.message : errorKind(error)}\n`);
    return 1;
  }
  let config: PrqConfig | null = null;
  let withheld = {};
  if (invocation.mode !== "endpoints") {
    try {
      config = readConfig(process.env, "deployed-check", { hostname: hostname(), homedir: homedir() });
      withheld = {
        host: new URL(config.url).host,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        ...(invocation.mode === "edge" ? { teamDomain: invocation.teamDomain } : {}),
      };
    } catch (error) {
      process.stderr.write(`check:deployed: ${error instanceof CliError ? error.message : errorKind(error)}\n`);
      return 1;
    }
  } else if (invocation.subdomain !== null) {
    withheld = { subdomain: invocation.subdomain };
  }
  const report = new Report((line) => process.stdout.write(`${line}\n`), withheld);
  const stop = new AbortController();
  const onSignal = () => {
    if (stop.signal.aborted) {
      process.exit(130);
    }
    process.stderr.write("check:deployed: stopping (again to stop at once)\n");
    stop.abort(new Error("stopped by a signal"));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const startedAt = new Date().toISOString();
  report.note(`check:deployed ${invocation.mode}, prq ${CLI_VERSION}, ${startedAt}`);
  let error: unknown = null;
  try {
    await run(invocation, report, stop.signal, config);
  } catch (caught) {
    error = caught;
    report.add({
      id: invocation.mode,
      what: "the run",
      verdict: "fail",
      observed: stop.signal.aborted
        ? "stopped by a signal"
        : `failed: ${caught instanceof CheckError ? caught.message : errorKind(caught)}`,
    });
  }
  const counts = (["pass", "fail", "unattributed", "unexercised"] as const)
    .map((verdict) => `${report.observations.filter((entry) => entry.verdict === verdict).length} ${verdict}`)
    .join(", ");
  report.note(`check:deployed ${invocation.mode}: ${counts}`);
  if (invocation.json !== undefined) {
    try {
      await report.save(invocation.json, {
        mode: invocation.mode,
        version: CLI_VERSION,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch (saveError) {
      // The path is the owner's to know; the message names only why.
      process.stderr.write(`check:deployed: the run was not saved to the --json file (${errorKind(saveError)})\n`);
      return 1;
    }
  }
  if (stop.signal.aborted) {
    return 130;
  }
  return error !== null || report.failed() ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
