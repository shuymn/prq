// check:deployed (src/test/deployed-*.ts) against the real Worker in wrangler's local runtime, through the Access
// stand-in's edge (src/test/access.ts): Access's decision first, then the door's forwarding, which carries the assets'
// bytes, conditional requests and the Hub's upgrade. The cloud agent's model is scripted. The Worker has no GitHub App,
// so a cloud analysis fails at its start: summary's runs show what it decides by (the pool, the first new row, its
// owner, its analysis at GitHub's head), and deciding on a done analysis is analysisVerdict's unit test. These are the
// fixture's verdicts; the deployment's are the owner's runs, recorded apart.

import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, test } from "vitest";

import { checkAssets, checkEdge, checkLedger, type EdgePace, readClientBuild, withPrq } from "../test/deployed-edge.ts";
import { Report } from "../test/deployed-report.ts";
import {
  checkAsk,
  checkSummary,
  listJobs,
  type Pace,
  retryJob,
  type SessionContext,
  waitForEmptyPool,
} from "../test/deployed-session.ts";
import { type Latch, latch } from "../test/latch.ts";
import { serviceOrigin } from "../test/origin.ts";
import { push, sessionView, sha } from "../test/pr.ts";
import { SCRIPTED_MODEL, serveScripted } from "../test/scripted.ts";
import { useStack } from "../test/stack.ts";
import { TEAM_DOMAIN } from "../test/worker.ts";

// Installed before the Worker starts, which hands its model requests to it; stopped after the Worker closes.
const scripted = serveScripted();
afterAll(() => scripted.stop());
const stack = useStack({ model: SCRIPTED_MODEL });

const CLIENT_DIR = fileURLToPath(new URL("../../../server/dist/client", import.meta.url));

// The edge with the service token, as the check reaches a deployment.
function edgeConfig() {
  const access = stack.access();
  return { url: access.edge.url, clientId: access.clientId, clientSecret: access.clientSecret };
}

// A report, its printed lines, and a latch per pattern that opens at the first line matching it.
function newReport(...patterns: RegExp[]): { report: Report; lines: string[]; seen: Latch[] } {
  const lines: string[] = [];
  const seen = patterns.map(() => latch());
  const { url, clientId, clientSecret } = edgeConfig();
  const report = new Report(
    (line) => {
      lines.push(line);
      for (const [index, pattern] of patterns.entries()) {
        if (pattern.test(line)) {
          seen[index]?.open();
        }
      }
    },
    { host: new URL(url).host, teamDomain: TEAM_DOMAIN, clientId, clientSecret },
  );
  return { report, lines, seen };
}

const verdicts = (report: Report, id: string) =>
  report.observations.filter((entry) => entry.id === id).map((entry) => entry.verdict);

// Polls of 3 s against the local Worker, with the margins scaled to them.
const EDGE: EdgePace = {
  waitMs: 3_000,
  nearBeforeMs: 1_000,
  nearAfterMs: 2_000,
  watchMs: 100,
  shownMs: 2_000,
  departureMs: 1_000,
  beforeDeadlineMs: 1_000,
  cliWaitSeconds: 3,
};

describe("edge", () => {
  test("passes every assertion, crediting Access by its sign-in redirect", { timeout: 60_000 }, async () => {
    const { report, lines } = newReport();
    const config = edgeConfig();
    const signal = new AbortController().signal;

    await withPrq(config, signal, (prq) =>
      checkEdge(
        {
          config,
          teamDomain: TEAM_DOMAIN,
          version: stack.worker().version,
          clientDir: CLIENT_DIR,
          pr: { owner: "acme", repo: "widgets", number: 7 },
          prq,
          pace: EDGE,
          signal,
        },
        report,
      ),
    );

    // The local runtime's dev proxy (wrangler's ProxyWorker) forwards each request with a fetch it does not end when
    // the client leaves, so here no departure reaches the Hub: the cut poll keeps waiting to its deadline and fails,
    // which is the edge the check is there to catch. Whether the real edge passes a departure on is the deployment's run.
    expect(report.observations.filter((entry) => entry.verdict === "fail")).toMatchObject([
      {
        id: "E9",
        what: "POST /cli/wait (edge-cut) aborted once waiting",
        observed: expect.stringMatching(/stopped waiting \d\.\d s later/),
      },
    ]);
    // Every request without credentials got the team's sign-in, the WebSocket upgrades as HTTP answers too.
    expect(verdicts(report, "E1")).toEqual(Array(7).fill("pass"));
    // The known ID with a wrong secret: strict mode's 403, which Access's logs attribute; a random ID likewise.
    expect(verdicts(report, "E2")).toEqual(Array(8).fill("unattributed"));
    expect(verdicts(report, "E3")).toEqual(["pass", "pass"]);
    expect(verdicts(report, "E4")).toEqual(["pass"]);
    expect(verdicts(report, "E5")).toEqual(["pass", "pass", "pass"]);
    expect(verdicts(report, "E6")).toEqual(["pass"]);
    const build = await readClientBuild(CLIENT_DIR);
    // Two navigations, each built file, the conditional reload, /index.html and the missing asset.
    expect(verdicts(report, "E7")).toEqual(Array(2 + build.assets.length + build.rootFiles.length + 3).fill("pass"));
    expect(verdicts(report, "E8")).toEqual(["pass"]);
    expect(verdicts(report, "E9")).toEqual(["pass", "fail"]);
    // No request Access denied reached the Worker: the one its JWT check refused is E3's, under the webhook bypass. No
    // line holds the hostname or the token.
    expect(
      stack
        .worker()
        .logs()
        .filter((line) => line.includes("prq.access.rejected")),
    ).toEqual(["{ event: 'prq.access.rejected', path: '/webhook/x', reason: 'missing' }"]);
    const output = lines.join("\n");
    for (const withheld of [config.url, new URL(config.url).host, config.clientId, config.clientSecret]) {
      expect(output).not.toContain(withheld);
    }
    expect(output).toContain("<team-domain>/cdn-cgi/access/login/<host>");
    // A sign-in redirect is recorded without its query, in the lines and the evidence alike.
    expect(`${output}${JSON.stringify(report.observations)}`).not.toContain("redirect_url");
  });

  test("E4 fails when the request reaches the Worker with no token or an expired one", async () => {
    const origin = serviceOrigin(edgeConfig().url, edgeConfig());
    for (const mode of ["bare", "expired"] as const) {
      stack.access().mode = mode;
      const { report } = newReport();
      await checkLedger(origin, report, new AbortController().signal);
      expect({ mode, observations: report.observations }).toMatchObject({
        mode,
        observations: [{ id: "E4", verdict: "fail", observed: expect.stringMatching(/^HTTP 401/) }],
      });
    }
  });

  test("E7 fails when the shell comes without no-cache", async () => {
    stack.access().edge.plan((path) => path === "/", {
      kind: "rewrite",
      headers: (headers) => headers.filter(([name]) => name.toLowerCase() !== "cache-control"),
    });
    const { report } = newReport();
    const origin = serviceOrigin(edgeConfig().url, edgeConfig());
    await checkAssets(origin, await readClientBuild(CLIENT_DIR), report, new AbortController().signal);
    const failed = report.observations.filter((entry) => entry.verdict === "fail");
    expect(failed).toMatchObject([{ what: "navigation GET /", observed: expect.stringContaining("no cache-control") }]);
  });
});

const PACE: Pace = { pollMs: 100, poolMs: 4_000, poolReportMs: 1_000, newRowMs: 5_000, jobMs: 10_000 };
const REPO = "acme/widgets";

function context(report: Report, pace: Partial<Pace> = {}): SessionContext {
  const config = edgeConfig();
  return {
    origin: serviceOrigin(config.url, config),
    report,
    signal: new AbortController().signal,
    pace: { ...PACE, ...pace },
  };
}

// An agent the Hub counts as present until its last contact is made old.
async function presentAgent(agentId: string): Promise<void> {
  const exit = await stack.run(["wait", "--agent-id", agentId, "--timeout", "0"]);
  expect(exit.code).toBe(2);
}

async function agePool(): Promise<void> {
  await stack.worker().sql("Hub", "hub", "UPDATE prq_agents SET last_seen_at = 0");
}

const headOf = (head: string) => () => Promise.resolve(head);

describe("pool", () => {
  test("fails at its bound naming the agents still present", async () => {
    await presentAgent("laptop");
    const { report } = newReport();
    expect(await waitForEmptyPool(context(report, { poolMs: 300 }))).toBe(false);
    expect(report.observations).toMatchObject([
      { id: "S0", verdict: "fail", observed: expect.stringContaining("an agent (the web UI names it) (last contact") },
    ]);
  });
});

describe("summary", () => {
  test(
    "waits for the pool, takes the first new pull request, and decides by its analysis at GitHub's head, not by its row",
    { timeout: 60_000 },
    async () => {
      // A pull request of the repository from before the check: not the one it takes.
      await push(stack.worker(), { owner: "acme", repo: "widgets", number: 1 }, sha("old"));
      await presentAgent("laptop");
      const { report, lines, seen } = newReport(/waiting for an empty pool/, /open a new pull request/);
      // GitHub's head is read before the session has it: h1, then h2 once the session names h2.
      const heads = [sha("h1"), sha("h2")];
      const run = checkSummary(context(report), {
        repo: REPO,
        headOf: () => Promise.resolve(heads.length > 1 ? (heads.shift() ?? "") : (heads[0] ?? "")),
      });

      await seen[0]?.promise;
      expect(report.observations).toEqual([]);
      await agePool();
      await seen[1]?.promise;
      const pr = { owner: "acme", repo: "widgets", number: 2 };
      await push(stack.worker(), pr, sha("h2"));
      await run;

      expect(report.observations).toMatchObject([
        { id: "S0", verdict: "pass" },
        { id: "S2", what: "the owner of acme/widgets#2", verdict: "pass", observed: "the cloud agent" },
        {
          id: "S2",
          what: "the analysis of acme/widgets#2",
          verdict: "fail",
          observed: expect.stringMatching(
            /^the analysis \S+ failed: .+; once the cause is fixed: check:deployed retry acme\/widgets#2 \S+$/,
          ),
        },
      ]);
      const failed = (await sessionView(stack.worker(), pr)).jobs[0];
      expect(failed).toMatchObject({ state: "failed", target: { kind: "analysis", headSha: sha("h2") } });
      expect(lines.join("\n")).toContain(`GitHub's head moved to ${sha("h2")}`);

      // jobs lists it with its revision; retry retries it from that revision.
      const listed = newReport();
      await listJobs(context(listed.report), pr);
      expect(listed.lines.join("\n")).toContain(
        `${failed?.jobId} analysis of ${sha("h2")}: failed, rev ${failed?.rev}`,
      );
      const retried = newReport();
      await retryJob(context(retried.report), pr, failed?.jobId ?? "");
      expect(retried.report.observations).toMatchObject([
        { id: "retry", verdict: "pass", observed: "retried: the job waits again" },
      ]);
      const unknown = newReport();
      await retryJob(context(unknown.report), pr, "no-such-job");
      expect(unknown.report.observations).toMatchObject([
        { id: "retry", verdict: "fail", observed: "the session lists no such job" },
      ]);
    },
  );

  test("fails a pull request a local agent owns", { timeout: 30_000 }, async () => {
    const { report, seen } = newReport(/open a new pull request/);
    const run = checkSummary(context(report), { repo: REPO, headOf: headOf(sha("h3")) });
    await seen[0]?.promise;
    // An agent arrives before the pull request's first job.
    await presentAgent("laptop");
    await push(stack.worker(), { owner: "acme", repo: "widgets", number: 3 }, sha("h3"));
    await run;
    expect(report.observations).toMatchObject([
      { id: "S0", verdict: "pass" },
      {
        id: "S2",
        what: "the owner of acme/widgets#3",
        verdict: "fail",
        observed: "a local agent owns it: open another pull request once the pool is empty",
      },
    ]);
  });

  test("fails with the subscription hint when no new pull request comes", async () => {
    const { report } = newReport();
    await checkSummary(context(report, { newRowMs: 300 }), { repo: REPO, headOf: headOf(sha("h4")) });
    expect(report.observations).toMatchObject([
      { id: "S0", verdict: "pass" },
      { id: "S2", verdict: "fail", observed: expect.stringContaining("Recent deliveries show no event") },
    ]);
  });
});

describe("ask", () => {
  test("decides by the stored answer to its question, not by the acknowledgement", { timeout: 30_000 }, async () => {
    const hold = { after: 0, reached: latch(), release: latch() };
    scripted.play(() => ({ text: "It adds the deployed checks.", hold }));
    const { report, lines, seen } = newReport(/acknowledged/, /the answer to check-\S+: job \S+ running/);
    let ended = false;
    const run = checkAsk(
      context(report),
      { owner: "acme", repo: "widgets", number: 9 },
      "What does this change?",
    ).finally(() => {
      ended = true;
    });
    // Acknowledged, the model called and the job seen running, with the answer held back: no verdict yet.
    await Promise.race([Promise.all([seen[0]?.promise, hold.reached.promise, seen[1]?.promise]), run]);
    expect(ended).toBe(false);
    expect(report.observations).toEqual([]);
    hold.release.open();
    await run;

    expect(report.observations).toMatchObject([
      {
        id: "S4",
        verdict: "pass",
        observed: expect.stringMatching(
          /^answer answer-\S+ to check-\S+ by the cloud agent \(model named in its metadata\) at no commit, \d+ input \(0 cached\), 8 output tokens, 28 characters$/,
        ),
      },
    ]);
    expect(lines.join("\n")).toMatch(/question check-\S+ acknowledged at /);
  });
});
