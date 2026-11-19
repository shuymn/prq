// How the deployed checks decide (deployed-edge.ts, deployed-session.ts, deployed-invocation.ts), from answers made up
// here: a denial's attribution, the long poll's timing, a departure's timing, the headers the build's rules give a
// path, the stored analysis and answer a session shows, and the command line.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { JobView, PrSessionView } from "@prq/protocol";
import { describe, expect, test } from "vitest";

import {
  type CutPoll,
  departureVerdicts,
  EDGE_PACE,
  expectedHeaders,
  headerMismatches,
  headerRules,
  type KeptPoll,
  noCredentialsVerdict,
  pollVerdict,
  type Site,
  teamSignIn,
  workersDevUrls,
  wrongSecretVerdict,
} from "./deployed-edge.ts";
import { parseInvocation, prRef } from "./deployed-invocation.ts";
import { analysisVerdict, answerVerdict, answerWorkspace } from "./deployed-session.ts";
import type { Answer } from "./origin.ts";

const TEAM = "https://team.example.cloudflareaccess.com";
const SITE: Site = { origin: "https://prq.example", teamDomain: TEAM };
const SIGN_IN = `${TEAM}/cdn-cgi/access/login/prq.example`;

function outcome(status: number | null, headers: Record<string, string> = {}, body = "", switched = false) {
  return {
    at: "2026-11-19T00:00:00.000Z",
    status,
    headers,
    body,
    switched,
    reason: status === null ? "ECONNRESET" : null,
  };
}

// A JWT's part, from a synthetic value.
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("a request without valid credentials", () => {
  test("is credited to Access only by a 302 to the team's sign-in for this host", () => {
    const signIn = outcome(302, { location: `${SIGN_IN}?kid=an-aud-tag&redirect_url=%2F&meta=an-opaque-value` });
    // Recorded without its query: the application's AUD and Access's opaque value stay out of the output.
    expect(noCredentialsVerdict(signIn, SITE)).toEqual({
      verdict: "pass",
      observed: `Access's sign-in redirect: HTTP 302, Location ${SIGN_IN}`,
    });
    for (const elsewhere of [
      "https://elsewhere.example/cdn-cgi/access/login/prq.example",
      `${TEAM}/cdn-cgi/access/login/other.example`,
      `${TEAM}/cdn-cgi/access/login-other/prq.example`,
    ]) {
      expect(noCredentialsVerdict(outcome(302, { location: elsewhere }), SITE)).toMatchObject({
        verdict: "unattributed",
        observed: expect.stringContaining("neither the team's sign-in nor the Worker"),
      });
    }
    // The sign-in's Location with another status is no redirect to it.
    expect(noCredentialsVerdict(outcome(304, { location: SIGN_IN }), SITE).verdict).toBe("unattributed");
    expect(
      noCredentialsVerdict(outcome(403, { "content-type": "text/html" }, "<html>Forbidden</html>"), SITE),
    ).toMatchObject({
      verdict: "unattributed",
      observed: expect.stringContaining("denied, not by the Worker"),
    });
    expect(noCredentialsVerdict(outcome(null), SITE)).toEqual({
      verdict: "unexercised",
      observed: "no HTTP answer (ECONNRESET)",
    });
  });

  test("records a Location other than the sign-in or the origin's root as withheld", () => {
    const token = [part({ alg: "none" }), part({ sub: "synthetic" }), part({ signature: "none" })].join(".");
    const verdict = noCredentialsVerdict(outcome(302, { location: `${TEAM}/cdn-cgi/access/login/${token}` }), SITE);
    expect(verdict.observed).toContain("Location elsewhere (withheld)");
    expect(verdict.observed).not.toContain(token);
  });

  test.for([
    ["the Worker's 401", outcome(401, {}, '{"error":"unauthorized","detail":"missing Access token"}'), "error JSON"],
    ["a Prq-Version", outcome(401, { "prq-version": "v0.1.0" }), "Prq-Version"],
    ["the shell", outcome(200, { "content-type": "text/html" }, "<html><title>prq</title></html>"), "shell"],
    ["a switched WebSocket", outcome(101, {}, "", true), "switched protocols"],
    ["a 2xx", outcome(204), "HTTP 204"],
  ] as const)("fails when it shows the Worker handled it: %s", ([, handled, sign]) => {
    expect(noCredentialsVerdict(handled, SITE)).toMatchObject({
      verdict: "fail",
      observed: expect.stringContaining(sign),
    });
  });

  test("with the known Client ID and a wrong secret, expects strict mode's 401 or 403", () => {
    expect(wrongSecretVerdict(outcome(403), SITE).verdict).toBe("unattributed");
    expect(wrongSecretVerdict(outcome(401), SITE).verdict).toBe("unattributed");
    expect(wrongSecretVerdict(outcome(302, { location: SIGN_IN }), SITE)).toMatchObject({
      verdict: "fail",
      observed: expect.stringContaining("strict mode off"),
    });
    expect(wrongSecretVerdict(outcome(500), SITE).verdict).toBe("fail");
    expect(wrongSecretVerdict(outcome(401, {}, '{"error":"unauthorized"}'), SITE).verdict).toBe("fail");
    expect(wrongSecretVerdict(outcome(null), SITE).verdict).toBe("unexercised");
  });

  test("reads a sign-in by the team's origin and Access's login path for this host", () => {
    expect(teamSignIn(SIGN_IN, SITE)).toBe(true);
    expect(teamSignIn(`${TEAM}/other`, SITE)).toBe(false);
    expect(teamSignIn("/cdn-cgi/access/login/prq.example", SITE)).toBe(false);
    expect(teamSignIn(undefined, SITE)).toBe(false);
  });
});

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Answer {
  return { at: "2026-11-19T00:00:00.000Z", status, headers, body: Buffer.from(JSON.stringify(body)) };
}

describe("a raw long poll", () => {
  const timeout = answer(200, { status: "timeout" }, { "prq-version": "v0.1.0" });

  test("passes when it times out near 25 s with the tag's Prq-Version", () => {
    expect(pollVerdict(timeout, 25_100, "v0.1.0", EDGE_PACE).verdict).toBe("pass");
  });

  test.for([
    ["early", 20_000],
    ["late", 30_000],
  ] as const)("fails when it ends %s", ([, ms]) => {
    expect(pollVerdict(timeout, ms, "v0.1.0", EDGE_PACE)).toMatchObject({
      verdict: "fail",
      observed: expect.stringContaining("not near"),
    });
  });

  test("fails on another version, a status or no answer", () => {
    expect(pollVerdict(timeout, 25_000, "v0.2.0", EDGE_PACE).observed).toContain("Prq-Version v0.1.0");
    expect(pollVerdict(answer(503, { error: "unavailable" }), 25_000, "v0.1.0", EDGE_PACE).verdict).toBe("fail");
    // An error by its code, never its message.
    const reset = Object.assign(new Error("socket hang up at prq.example"), { code: "ECONNRESET" });
    expect(pollVerdict(reset, 25_000, "v0.1.0", EDGE_PACE).observed).toBe("no answer (ECONNRESET)");
  });

  test("is unexercised when answered ready", () => {
    expect(pollVerdict(answer(200, { status: "ready" }), 100, "v0.1.0", EDGE_PACE).verdict).toBe("unexercised");
  });
});

const verdicts = (kept: KeptPoll, cutOff: CutPoll) => departureVerdicts(kept, cutOff, EDGE_PACE);

describe("a departure from a poll", () => {
  const keep: KeptPoll = { started: 0, waitingAt: 300, stoppedAt: 25_300, ending: "timeout" };
  const cut: CutPoll = {
    started: 0,
    waitingAt: 300,
    abortedAt: 300,
    stoppedAt: 1_300,
    ending: "no answer (AbortError)",
    begunBeforeAbort: null,
    endedByAbort: true,
  };

  test("passes when the cut poll stops within 5 s of its abort and the kept one times out near its deadline", () => {
    const { keep: kept, cut: cutOff } = verdicts(keep, cut);
    expect([kept.verdict, cutOff.verdict]).toEqual(["pass", "pass"]);
  });

  test("fails a departure that reached the Hub late, or only at the deadline", () => {
    expect(verdicts(keep, { ...cut, stoppedAt: 6_000 }).cut.verdict).toBe("fail");
    expect(verdicts(keep, { ...cut, abortedAt: 12_000, stoppedAt: 16_000 }).cut.verdict).toBe("fail");
    expect(verdicts(keep, { ...cut, stoppedAt: 25_100 }).cut.verdict).toBe("fail");
  });

  test("fails a cut poll whose answer had begun before the abort, or that ended otherwise than by it", () => {
    // The answer's status line had come, its body had not: the abort ended the read, not the poll.
    expect(verdicts(keep, { ...cut, begunBeforeAbort: { status: 503 } }).cut).toEqual({
      verdict: "fail",
      observed: "an answer (HTTP 503) had begun before the abort: no departure to observe",
    });
    // Its first bytes had come, its status line not yet whole.
    expect(verdicts(keep, { ...cut, begunBeforeAbort: { status: null } }).cut.observed).toBe(
      "an answer (its first bytes) had begun before the abort: no departure to observe",
    );
    expect(verdicts(keep, { ...cut, endedByAbort: false, ending: "HTTP 503" }).cut).toEqual({
      verdict: "fail",
      observed: "it ended with HTTP 503, not by the abort",
    });
  });

  test("fails the control when the kept poll stops away from its deadline or with no timeout answer", () => {
    expect(verdicts({ ...keep, stoppedAt: 5_000 }, cut).keep.verdict).toBe("fail");
    expect(verdicts({ ...keep, ending: "HTTP 503" }, cut).keep).toMatchObject({
      verdict: "fail",
      observed: expect.stringContaining("it ended with HTTP 503, not a timeout answer"),
    });
  });

  test("fails a poll never seen waiting or still waiting, and leaves one answered ready unexercised", () => {
    expect(verdicts({ ...keep, waitingAt: null, stoppedAt: null }, cut).keep.verdict).toBe("fail");
    expect(verdicts(keep, { ...cut, stoppedAt: null }).cut.verdict).toBe("fail");
    expect(verdicts({ ...keep, ending: "ready" }, { ...cut, ending: "ready" })).toMatchObject({
      keep: { verdict: "unexercised" },
      cut: { verdict: "unexercised" },
    });
  });

  test("credits no departure when the poll left to its deadline did not pass", () => {
    for (const control of [
      { ...keep, ending: "ready" },
      { ...keep, stoppedAt: 5_000 },
    ]) {
      expect(verdicts(control, cut).cut).toMatchObject({
        verdict: "unexercised",
        observed: expect.stringContaining("not credited: the poll left to its deadline did not pass"),
      });
    }
  });
});

describe("the build's header rules", () => {
  test("give each path the rules that match it, in order, a later rule dropping an earlier header", () => {
    const rules = headerRules(
      "# comment\n/*\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n/assets/a.js\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n",
    );
    expect(expectedHeaders(rules, "/")).toEqual({ "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    expect(expectedHeaders(rules, "/assets/a.js")).toEqual({
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
  });

  test("refuse a pattern this check does not read", () => {
    expect(() => headerRules("/assets/*\n  X: y\n")).toThrow("does not read: /assets/*");
    expect(() => headerRules("  X: y\n")).toThrow("before any path");
  });

  test("read the generated _headers: the shell revalidated with the CSP, each emitted file immutable", async () => {
    const dir = new URL("../../../server/dist/client/", import.meta.url);
    const rules = headerRules(await readFile(new URL("_headers", dir), "utf8"));
    const shell = expectedHeaders(rules, "/");
    expect(shell).toMatchObject({
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    });
    expect(shell["content-security-policy"]).toContain("default-src 'self'");
    const asset = rules.find((rule) => rule.path.startsWith("/assets/"))?.path ?? "";
    expect(expectedHeaders(rules, asset)["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(headerMismatches(shell, { ...shell, "cache-control": "max-age=60" })).toEqual([
      "another cache-control (expected no-cache)",
    ]);
    expect(fileURLToPath(dir)).toContain("dist");
  });
});

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const THIRD = "c".repeat(40);
// IDs as the Worker and the web UI make them.
const JOB_0 = "10000000-0000-4000-8000-000000000000";
const JOB_1 = "10000000-0000-4000-8000-000000000001";
const JOB_2 = "10000000-0000-4000-8000-000000000002";
const QUESTION = "20000000-0000-4000-8000-000000000001";
const ANOTHER_QUESTION = "20000000-0000-4000-8000-000000000002";

function job(overrides: Partial<JobView>): JobView {
  return {
    jobId: JOB_1,
    target: { kind: "analysis", headSha: HEAD },
    state: "done",
    agentId: null,
    since: null,
    stalled: false,
    failure: null,
    resultMessageId: `analysis-${JOB_1}`,
    createdAt: 0,
    updatedAt: 0,
    rev: 3,
    run: 1,
    ...overrides,
  };
}

function view(jobs: JobView[], headSha: string | null = HEAD): PrSessionView {
  return {
    pr: { owner: "acme", repo: "widgets", number: 7 },
    details:
      headSha === null
        ? null
        : {
            fullName: "acme/widgets",
            title: "t",
            state: "open",
            url: "https://github.com/acme/widgets/pull/7",
            headSha,
            baseSha: OTHER,
          },
    owner: "cloud",
    jobs,
  };
}

const analysisMessage = (metadata: Record<string, unknown>, text = "The summary.", id = `analysis-${JOB_1}`) => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
  metadata: { kind: "analysis", jobId: JOB_1, headSha: HEAD, ...metadata },
});

// A cloud turn's text kept after the turn failed: the job's earlier run, before the retry whose result is stored.
const INCOMPLETE = { incomplete: { reason: "the provider stopped" } };

describe("summary's analysis at GitHub's head", () => {
  const cloud = {
    by: { kind: "cloud", model: "deepseek-flash" },
    usage: { inputTokens: 900, outputTokens: 80, cachedInputTokens: 0 },
  };
  const partial = analysisMessage({ ...cloud, ...INCOMPLETE }, "The sum", `analysis-${JOB_1}-r1-incomplete`);

  test("passes the job's result, a done cloud analysis of that head, naming the model and tokens", () => {
    expect(analysisVerdict(view([job({})]), [partial, analysisMessage(cloud)], HEAD)).toMatchObject({
      done: true,
      ok: true,
      observed: `analysis ${JOB_1} done at ${HEAD} by the cloud agent (model named in its metadata), 900 input (0 cached), 80 output tokens, 12 characters`,
    });
  });

  test("keeps waiting while the head's analysis has not ended, or exists only for another head", () => {
    expect(analysisVerdict(view([job({ state: "running" })]), [], HEAD).done).toBe(false);
    expect(analysisVerdict(view([job({ target: { kind: "analysis", headSha: OTHER } })]), [], HEAD).done).toBe(false);
    expect(analysisVerdict(view([]), [], HEAD).done).toBe(false);
  });

  test.for([
    [
      "failed, by its failure's category alone",
      [job({ state: "failed", failure: "workspace: git fetch said fatal: prq.example" })],
      [],
      "failed: workspace (the rest in the web UI)",
    ],
    ["superseded", [job({ state: "superseded" })], [], "was superseded"],
    ["done without a stored message", [job({})], [], "no message stores its result"],
    ["done with only an earlier run's partial text", [job({})], [partial], "no message stores its result"],
    [
      "whose result is the partial text",
      [job({ resultMessageId: `analysis-${JOB_1}-r1-incomplete` })],
      [partial],
      "is incomplete",
    ],
    ["of another job", [job({})], [analysisMessage({ ...cloud, jobId: JOB_0 })], "no metadata of the job"],
    [
      "written by a local agent",
      [job({})],
      [analysisMessage({ by: { kind: "local", agentId: "laptop" } })],
      "a local agent wrote it",
    ],
    ["stored without text", [job({})], [analysisMessage(cloud, " ")], "it has no text"],
  ] as const)("fails an analysis %s", ([, jobs, messages, observed]) => {
    expect(analysisVerdict(view([...jobs]), [...messages], HEAD)).toMatchObject({
      done: true,
      ok: false,
      observed: expect.stringContaining(observed),
    });
  });
});

const storedAnswer = (metadata: Record<string, unknown>, text = "Because.", id = `answer-${JOB_2}`) => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
  metadata: {
    kind: "answer",
    jobId: JOB_2,
    questionId: QUESTION,
    sha: HEAD,
    by: { kind: "cloud", model: "m" },
    ...metadata,
  },
});

describe("ask's stored answer", () => {
  const answerJob = job({
    jobId: JOB_2,
    target: { kind: "answer", messageId: QUESTION },
    resultMessageId: `answer-${JOB_2}`,
  });
  const partial = storedAnswer(INCOMPLETE, "Becau", `answer-${JOB_2}-r1-incomplete`);
  // Two completed analyses: of OTHER, then of HEAD.
  const first = job({ jobId: JOB_0, target: { kind: "analysis", headSha: OTHER }, updatedAt: 1 });
  const second = job({ updatedAt: 2 });

  test("is at the head of the latest completed analysis when the question is asked, else at the session's head", () => {
    expect(answerWorkspace(view([first, second]))).toBe(HEAD);
    // Completed later, though created earlier: the Hub orders by completion.
    expect(
      answerWorkspace(
        view([
          { ...first, updatedAt: 2 },
          { ...second, updatedAt: 1 },
        ]),
      ),
    ).toBe(OTHER);
    expect(answerWorkspace(view([], OTHER))).toBe(OTHER);
    expect(answerWorkspace(view([], null))).toBeNull();
  });

  test("passes the job's result, the answer to the question at the workspace it was asked at", () => {
    expect(answerVerdict(view([first, second, answerJob]), [partial, storedAnswer({})], QUESTION, HEAD)).toMatchObject({
      done: true,
      verdict: "pass",
    });
    // No push seen: no commit.
    expect(answerVerdict(view([answerJob], null), [storedAnswer({ sha: null })], QUESTION, null)).toMatchObject({
      done: true,
      verdict: "pass",
    });
  });

  test.for([
    ["of another question", [storedAnswer({ questionId: ANOTHER_QUESTION })], `it answers ${ANOTHER_QUESTION}`],
    [
      "at an earlier completed analysis than the one it was asked at",
      [storedAnswer({ sha: OTHER })],
      `it was written at ${OTHER}, not at ${HEAD}, the workspace when it was asked`,
    ],
    [
      "at no commit though asked at a head",
      [storedAnswer({ sha: null })],
      `it was written at no commit, not at ${HEAD}`,
    ],
    ["without text", [storedAnswer({}, " ")], "it has no text"],
    ["stored as the user's message", [{ ...storedAnswer({}), role: "user" }], "is not the assistant's message"],
    ["with only an earlier run's partial text", [partial], "no message stores its result"],
  ] as const)("fails an answer %s", ([, messages, observed]) => {
    expect(answerVerdict(view([first, second, answerJob]), [...messages], QUESTION, HEAD)).toMatchObject({
      verdict: "fail",
      observed: expect.stringContaining(observed),
    });
  });

  test("fails an answer whose result is the partial text", () => {
    expect(
      answerVerdict(
        view([first, second, { ...answerJob, resultMessageId: `answer-${JOB_2}-r1-incomplete` }]),
        [partial],
        QUESTION,
        HEAD,
      ),
    ).toMatchObject({ verdict: "fail", observed: expect.stringContaining("is incomplete") });
  });

  test("names a job or a message only by an ID in its producer's form", () => {
    const aud = "a1b2".repeat(16);
    expect(analysisVerdict(view([job({ jobId: aud, state: "superseded" })]), [], HEAD)).toMatchObject({
      observed: "the analysis [a job ID of another form] was superseded",
    });
    expect(
      answerVerdict(view([first, second, answerJob]), [storedAnswer({ questionId: aud })], QUESTION, HEAD),
    ).toMatchObject({ observed: expect.stringContaining("it answers [a message ID of another form]") });
    // A failed run's text, under the Worker's ID for it.
    expect(
      answerVerdict(
        view([first, second, { ...answerJob, resultMessageId: `answer-${JOB_2}-r1-incomplete` }]),
        [partial],
        QUESTION,
        HEAD,
      ),
    ).toMatchObject({ observed: expect.stringContaining(`result answer-${JOB_2}-r1-incomplete is incomplete`) });
  });

  test("leaves the commit undecided when an analysis completed while the question waited", () => {
    // Asked at OTHER; HEAD's analysis completed before the answer: the job may have started at either.
    for (const sha of [OTHER, HEAD]) {
      expect(answerVerdict(view([first, second, answerJob]), [storedAnswer({ sha })], QUESTION, OTHER)).toMatchObject({
        verdict: "unexercised",
        observed: expect.stringContaining(`the workspace moved from ${OTHER} while it waited (now ${HEAD})`),
      });
    }
    // Asked at THIRD; an earlier read saw HEAD, this one OTHER: the job may have started at HEAD, at neither end.
    expect(
      answerVerdict(
        view([second, { ...first, updatedAt: 3 }, answerJob]),
        [storedAnswer({ sha: HEAD })],
        QUESTION,
        THIRD,
        true,
      ),
    ).toMatchObject({ verdict: "unexercised" });
    // The workspace back where the question was asked, but moved in an earlier read.
    expect(
      answerVerdict(view([first, second, answerJob]), [storedAnswer({ sha: OTHER })], QUESTION, HEAD, true),
    ).toMatchObject({ verdict: "unexercised" });
  });

  test("keeps waiting until its job ends, and fails one that failed", () => {
    expect(answerVerdict(view([{ ...answerJob, state: "claimed" }]), [], QUESTION, HEAD).done).toBe(false);
    expect(
      answerVerdict(view([{ ...answerJob, state: "failed", failure: "provider refused" }]), [], QUESTION, HEAD),
    ).toMatchObject({
      verdict: "fail",
      observed: expect.stringContaining("provider refused"),
    });
  });
});

describe("the command line", () => {
  test("reads each mode with its arguments", () => {
    expect(parseInvocation(["--", "endpoints", "acct", "--version", "0123abcd-0000-4000-8000-000000000000"])).toEqual({
      mode: "endpoints",
      subdomain: "acct",
      version: "0123abcd-0000-4000-8000-000000000000",
      json: undefined,
    });
    expect(parseInvocation(["endpoints", "none"])).toMatchObject({ subdomain: null });
    expect(parseInvocation(["edge", "--team-domain", TEAM, "--pr", "Acme/Widgets#7", "--json", "run.json"])).toEqual({
      mode: "edge",
      teamDomain: TEAM,
      pr: { owner: "Acme", repo: "Widgets", number: 7 },
      json: "run.json",
    });
    expect(parseInvocation(["summary", "acme/widgets"])).toMatchObject({ repo: "acme/widgets" });
    expect(parseInvocation(["ask", "acme/widgets#7", "Why?"])).toMatchObject({ text: "Why?" });
    expect(parseInvocation(["retry", "acme/widgets#7", "job-1"])).toMatchObject({ jobId: "job-1" });
  });

  test.for([
    [["deploy"], "usage: check:deployed <endpoints"],
    [["edge"], "--team-domain takes"],
    [["edge", "--team-domain", `${TEAM}/`], "--team-domain takes"],
    [["edge", "--team-domain", "http://team.example"], "--team-domain takes"],
    [["pool", "--pr", "a/b#1"], "--pr does not apply to pool"],
    [["endpoints", "none", "--version", "0123abcd-0000-4000-8000-000000000000"], "--version needs the subdomain"],
    [["endpoints", "Not_A_Label"], "a DNS label"],
    [["ask", "acme/widgets#7", " "], "the question is empty"],
    [["jobs", "acme/widgets"], "the pull request is not"],
    [["summary", "acme"], "the repository is not"],
    [["pool", "--bogus"], "an option this command does not take"],
  ] as const)("refuses %j", ([argv, message]) => {
    expect(() => parseInvocation(argv)).toThrow(message);
  });

  test("names no refused argument by its value", () => {
    const value = "prq.private.example-0123456789abcdef";
    for (const argv of [
      [value],
      ["summary", value],
      ["jobs", value],
      ["pool", `--${value}`],
      ["edge", "--pr", value],
    ]) {
      expect(() => parseInvocation(argv)).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining(value) }),
      );
    }
  });

  test("reads a pull request as owner/repo#number", () => {
    expect(prRef("a/b#12")).toEqual({ owner: "a", repo: "b", number: 12 });
    expect(() => prRef("a/b#0")).toThrow("the pull request is not");
  });

  test("names workers.dev's production URL, and a version's preview URL by its first 8 characters", () => {
    expect(workersDevUrls("acct", undefined)).toEqual([
      { what: "the production URL", url: "https://prq.acct.workers.dev/" },
    ]);
    expect(workersDevUrls("acct", "0123abcd-0000-4000-8000-000000000000")[1]).toEqual({
      what: "the version's preview URL",
      url: "https://0123abcd-prq.acct.workers.dev/",
    });
  });
});
