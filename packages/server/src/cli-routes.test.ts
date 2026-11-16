import { type ClaimResponse, ErrorResponse, MAX_ANSWER_CHARS, PRQ_VERSION_HEADER } from "@prq/protocol";
import type { UIMessage } from "ai";
import { runInDurableObject } from "cloudflare:test";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROUTE_CALL_MS } from "./http.ts";
import { WAIT_MAX_MS } from "./hub.ts";
import app from "./index.ts";
import {
  accessToken,
  captureLogs,
  envFor,
  freshTeamDomain,
  keyFailures,
  request,
  runKey,
  serveKeys,
} from "./test/access.ts";
import { type AgentSocket, hostToken, question, storedMessages } from "./test/chat.ts";
import {
  accepted,
  claimOver,
  controlWaitTimers,
  fetchBounded,
  heldBound,
  localSession,
  post,
  postRequest,
  retryOver,
  submitOver,
  waitOver,
  waitStatus,
  watchChecks,
} from "./test/cli.ts";
import {
  clearQueue,
  gate,
  holdInsert,
  hub,
  hubSeams,
  prSessionSeams,
  type Session,
  setPool,
  submission,
  tracked,
  within,
} from "./test/session.ts";
import { SERVER_VERSION } from "./version.ts";

const sockets: AgentSocket[] = [];

// Each test starts from an empty queue: the sessions of earlier tests may still have work.
beforeEach(async () => {
  await clearQueue();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q1 = question("q1");
// Long enough that a wait that answers has not timed out; the tests' own 5 s limit is shorter.
const LONG_MS = 20_000;

async function answers(session: Session): Promise<UIMessage[]> {
  return (await storedMessages(session.path, session.token)).filter((message) => message.role === "assistant");
}

// A claim that holds a job.
function holding(claim: ClaimResponse) {
  if (claim.job === null) {
    throw new Error("nothing was claimed");
  }
  return { ...claim, job: claim.job };
}

describe("wait returns at once", () => {
  it("answers ready when a pending job waits", async () => {
    captureLogs();
    const { token } = await localSession("cli", sockets, Q1);
    expect(await within(waitStatus(waitOver(token, "laptop", LONG_MS)), 3000)).toBe("ready");
  });

  it("answers ready for the agent's own claimed job, and not for another agent", async () => {
    captureLogs();
    const { token } = await localSession("cli", sockets, Q1);
    expect((await claimOver(token, "laptop")).job).not.toBeNull();

    expect(await within(waitStatus(waitOver(token, "laptop", LONG_MS)), 3000)).toBe("ready");

    // Another agent's wait checks, finds nothing for it, and sleeps until its bound passes.
    const timers = await controlWaitTimers();
    const checks = await watchChecks();
    const other = tracked(waitStatus(waitOver(token, "desktop", LONG_MS)));
    await checks.answered();
    await timers.started();
    expect(other.settled()).toBe(false);
    await timers.expire();
    expect(await within(other.promise, 3000)).toBe("timeout");
  });
});

describe("wait does not consume", () => {
  it("answers ready to two waits in a row, and the job is still there to claim", async () => {
    captureLogs();
    const { token, stub } = await localSession("cli", sockets, Q1);
    expect(await waitStatus(waitOver(token, "laptop", LONG_MS))).toBe("ready");
    expect(await waitStatus(waitOver(token, "laptop", LONG_MS))).toBe("ready");
    expect((await stub.view()).jobs.map((job) => job.state)).toEqual(["pending"]);
    expect(await claimOver(token, "laptop")).toMatchObject({ job: { target: { messageId: "q1" } }, resumed: false });
  });

  it("leaves the job to the next wait and claim when a woken wait's request is aborted", async () => {
    captureLogs();
    const { token, client } = await localSession("cli", sockets);
    // The second check (the one the wake starts) is held after it answered.
    const checks = await watchChecks(2);
    const abort = new AbortController();
    const wait = tracked(waitOver(token, "laptop", LONG_MS, abort.signal).catch((error: unknown) => error));
    await checks.answered();

    await client.chat([Q1]);
    await checks.held.reached();
    // A sentinel call to the Hub goes through while the woken check is held there.
    expect(await (await hub()).isLocalPresent()).toBe(true);
    expect(wait.settled()).toBe(false);
    abort.abort();
    expect(await wait.promise).toBeInstanceOf(Error);
    await checks.held.open();

    expect(await within(waitStatus(waitOver(token, "laptop", LONG_MS)), 3000)).toBe("ready");
    expect(await claimOver(token, "laptop")).toMatchObject({ job: { target: { messageId: "q1" } }, resumed: false });
  });
});

describe("timeout", () => {
  it("answers 200 timeout with both headers after timeoutMs when no work arrives", async () => {
    captureLogs();
    const token = await hostToken();
    const res = await waitOver(token, "laptop", 50);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "timeout" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get(PRQ_VERSION_HEADER)).toBe(SERVER_VERSION);
  });

  it("bounds the wait at min(timeoutMs, WAIT_MAX_MS), with or without timeoutMs", async () => {
    captureLogs();
    const token = await hostToken();
    const timers = await controlWaitTimers();
    for (const [count, timeoutMs] of [50, 600_000, undefined].entries()) {
      const wait = waitStatus(waitOver(token, "laptop", timeoutMs));
      await timers.started(count + 1);
      await timers.expire();
      expect(await within(wait, 3000)).toBe("timeout");
    }
    expect(timers.timers().map((timer) => timer.ms)).toEqual([50, WAIT_MAX_MS, WAIT_MAX_MS]);
  });
});

describe("idempotent submit over HTTP", () => {
  it("answers duplicate to a resend and keeps one answer", async () => {
    captureLogs();
    const session = await localSession("cli", sockets, Q1);
    const claim = await claimOver(session.token, "laptop");

    const first = await accepted(submitOver(session.token, session.ref, claim, "laptop"));
    expect(first.status).toBe("accepted");
    const again = await accepted(submitOver(session.token, session.ref, claim, "laptop"));
    expect(again).toEqual({ status: "duplicate", messageId: first.messageId });
    expect((await answers(session)).map((message) => message.id)).toEqual([first.messageId]);
  });

  it("answers duplicate to a resend queued behind the first, and keeps the first text", async () => {
    captureLogs();
    const session = await localSession("cli", sockets, Q1);
    const claim = await claimOver(session.token, "laptop");
    const held = await holdInsert(session.stub, "before");

    const first = tracked(accepted(submitOver(session.token, session.ref, claim, "laptop", "first")));
    await held.reached();
    const second = tracked(accepted(submitOver(session.token, session.ref, claim, "laptop", "second")));
    // A sentinel read goes through while the first submit is held in its insert.
    expect((await session.stub.view()).jobs.map((job) => job.state)).toEqual(["running"]);
    expect([first.settled(), second.settled()]).toEqual([false, false]);
    await held.open();

    const firstAnswer = await first.promise;
    expect(firstAnswer.status).toBe("accepted");
    expect(await second.promise).toEqual({ status: "duplicate", messageId: firstAnswer.messageId });
    const stored = await answers(session);
    expect(stored.map((message) => message.parts)).toEqual([[{ type: "text", text: "first" }]]);
  });
});

describe("stale claim after retry", () => {
  it("rejects a submit under the claim a retry replaced with 409 stale_claim", async () => {
    captureLogs();
    const session = await localSession("cli", sockets, Q1);
    const old = holding(await claimOver(session.token, "laptop"));

    expect(await (await retryOver(session.token, session.ref, old.job.jobId)).json()).toEqual({ status: "retried" });
    expect(await failure(submitOver(session.token, session.ref, old, "laptop"))).toEqual(failed(409, "stale_claim"));

    // The same agent claims the job again: the earlier claimId stays refused while the job is claimed, and after it is
    // done.
    const next = holding(await claimOver(session.token, "laptop"));
    expect(next).toMatchObject({ job: { jobId: old.job.jobId }, resumed: false });
    expect(next.claimId).not.toBe(old.claimId);
    const stale = failed(409, "stale_claim");
    expect(await failure(submitOver(session.token, session.ref, old, "laptop", "late"))).toEqual(stale);
    expect((await accepted(submitOver(session.token, session.ref, next, "laptop"))).status).toBe("accepted");
    expect(await failure(submitOver(session.token, session.ref, old, "laptop", "late"))).toEqual(stale);
    expect(await answers(session)).toHaveLength(1);
  });
});

describe("resume after restart", () => {
  it("gives a restarted agent its job with a new claimId, and refuses the old one", async () => {
    captureLogs();
    const session = await localSession("cli", sockets, Q1);
    const before = holding(await claimOver(session.token, "laptop"));

    // The process restarts with the same agent ID: it waits, then claims.
    expect(await waitStatus(waitOver(session.token, "laptop", LONG_MS))).toBe("ready");
    const after = holding(await claimOver(session.token, "laptop"));
    expect(after).toMatchObject({ job: { jobId: before.job.jobId }, resumed: true });
    expect(after.claimId).not.toBe(before.claimId);

    expect(await failure(submitOver(session.token, session.ref, before, "laptop"))).toEqual(failed(409, "stale_claim"));
    expect((await accepted(submitOver(session.token, session.ref, after, "laptop"))).status).toBe("accepted");
  });
});

describe("submit", () => {
  it("addresses the canonical session for a pull request in any case", async () => {
    captureLogs();
    const session = await localSession("cli", sockets, Q1);
    const claim = await claimOver(session.token, "laptop");
    const pr = { ...session.ref, owner: "OCTO", repo: "Cli" };
    expect((await accepted(submitOver(session.token, pr, claim, "laptop"))).status).toBe("accepted");
    expect(await answers(session)).toHaveLength(1);
  });

  it("stores an answer of MAX_ANSWER_CHARS escape-heavy characters and refuses a longer one", async () => {
    captureLogs();
    const session = await localSession("cli", sockets, Q1);
    const claim = await claimOver(session.token, "laptop");
    // Each U+0001 is stored as a 6-byte JSON escape.
    const longest = "\u0001".repeat(MAX_ANSWER_CHARS);

    expect(await failure(submitOver(session.token, session.ref, claim, "laptop", `${longest}\u0001`))).toEqual(
      failed(400, "bad_request"),
    );
    expect(await failure(submitOver(session.token, session.ref, claim, "laptop", ""))).toEqual(
      failed(400, "bad_request"),
    );
    expect((await accepted(submitOver(session.token, session.ref, claim, "laptop", longest))).status).toBe("accepted");
    const [stored] = await answers(session);
    expect(stored?.parts).toEqual([{ type: "text", text: longest }]);
  });
});

// A response as the CLI reads it: status, body and both headers.
async function received(response: Promise<Response> | Response) {
  const res = await response;
  return {
    status: res.status,
    body: await res.json(),
    cacheControl: res.headers.get("Cache-Control"),
    version: res.headers.get(PRQ_VERSION_HEADER),
  };
}

// An error response with both headers.
async function failure(response: Promise<Response> | Response) {
  const { body, ...rest } = await received(response);
  return { ...rest, error: v.parse(ErrorResponse, body).error };
}

function failed(status: number, error: string) {
  return { status, error, cacheControl: "no-store", version: SERVER_VERSION };
}

describe("headers on every outcome", () => {
  it("200 on a claim and on a wait timeout", async () => {
    captureLogs();
    const token = await hostToken();
    const headers = { cacheControl: "no-store", version: SERVER_VERSION };
    expect(await received(post("/cli/claim", token, { agentId: "laptop" }))).toEqual({
      status: 200,
      body: { job: null },
      ...headers,
    });
    expect(await received(waitOver(token, "laptop", 0))).toEqual({
      status: 200,
      body: { status: "timeout" },
      ...headers,
    });
  });

  it("400 on a body outside the schema, and on a body that is not JSON", async () => {
    captureLogs();
    const token = await hostToken();
    for (const [path, body] of [
      ["/cli/wait", { agentId: "laptop", timeoutMs: -1 }],
      ["/cli/wait", { agentId: "has space" }],
      ["/cli/claim", {}],
      ["/cli/submit", { agentId: "laptop" }],
      ["/cli/claim", '{"agentId":'],
    ] as const) {
      expect(await failure(await post(path, token, body))).toEqual(failed(400, "bad_request"));
    }
  });

  it("names the fields at fault in a 400, without their values", async () => {
    captureLogs();
    const token = await hostToken();
    const res = await post("/cli/wait", token, { agentId: "secret value", timeoutMs: "secret" });
    const body = v.parse(ErrorResponse, await res.json());
    expect(body.detail).toBe("invalid agentId, timeoutMs");
  });

  it("401 without a token", async () => {
    captureLogs();
    expect(await failure(await post("/cli/claim", undefined, { agentId: "laptop" }))).toEqual(
      failed(401, "unauthorized"),
    );
  });

  it("404 on an unknown path and on an unknown job", async () => {
    captureLogs();
    const session = await localSession("cli", sockets, Q1);
    expect(await failure(await post("/cli/unknown", session.token, {}))).toEqual(failed(404, "not_found"));
    const claim = holding(await claimOver(session.token, "laptop"));
    const unknown = { ...claim, job: { ...claim.job, jobId: crypto.randomUUID() } };
    expect(await failure(await submitOver(session.token, session.ref, unknown, "laptop"))).toEqual(
      failed(404, "unknown_job"),
    );
  });

  it("409 on a stale claim and on a target mismatch", async () => {
    captureLogs();
    const session = await localSession("cli", sockets, Q1);
    const claim = holding(await claimOver(session.token, "laptop"));
    expect(
      await failure(await submitOver(session.token, session.ref, { ...claim, claimId: crypto.randomUUID() }, "laptop")),
    ).toEqual(failed(409, "stale_claim"));
    const other = { ...claim, job: { ...claim.job, target: { kind: "answer" as const, messageId: "q2" } } };
    expect(await failure(await submitOver(session.token, session.ref, other, "laptop"))).toEqual(
      failed(409, "target_mismatch"),
    );
  });

  it("500 when a submit fails in the session, and when the Hub's wait fails", async () => {
    const logs = captureLogs();
    const session = await localSession("cli", sockets, Q1);
    const claim = await claimOver(session.token, "laptop");
    await runInDurableObject(session.stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "waitUntilStable").mockRejectedValue(new Error("storage failed"));
    });
    expect(await failure(await submitOver(session.token, session.ref, claim, "laptop"))).toEqual(
      failed(500, "internal"),
    );

    await runInDurableObject(await hub(), (instance) => {
      vi.spyOn(instance, "onRequest").mockResolvedValue(new Response("a stack", { status: 500 }));
    });
    expect(await failure(await waitOver(session.token, "laptop", 0))).toEqual(failed(500, "internal"));
    expect(logs.some((log) => log.entry["event"] === "prq.request.failed")).toBe(true);
  });

  it("503 when Access's keys cannot be fetched", async () => {
    captureLogs();
    const teamDomain = freshTeamDomain();
    const key = await runKey();
    serveKeys(teamDomain, key).fail(keyFailures["a 500"]!);
    const req = request("/cli/claim", await accessToken(key, { iss: teamDomain }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "laptop" }),
    });
    expect(await failure(await app.fetch(req, envFor(teamDomain)))).toEqual(failed(503, "unavailable"));
  });
});

describe("contacts", () => {
  it("counts a claim and a submit, accepted or not, as a contact from the agent", async () => {
    captureLogs();
    const session = await localSession("cli", sockets, Q1);
    await setPool([]);
    const claim = holding(await claimOver(session.token, "laptop"));
    expect(await (await hub()).isLocalPresent()).toBe(true);

    await setPool([]);
    const stale = { ...claim, claimId: crypto.randomUUID() };
    expect((await submitOver(session.token, session.ref, stale, "laptop")).status).toBe(409);
    expect(await (await hub()).isLocalPresent()).toBe(true);
  });
});

describe("route time limits", () => {
  it("answers 503 when the Hub's claim does not answer in time; the late claim is the agent's to resume", async () => {
    captureLogs();
    const session = await localSession("cli", sockets, Q1);
    // The Hub's first call into the session (its resume pass) is held.
    const held = await gate(await hub());
    await runInDurableObject(await hub(), (instance) => {
      const seams = hubSeams(instance);
      const claim = seams.claimSession.bind(instance);
      vi.spyOn(seams, "claimSession").mockImplementationOnce(async (...args) => {
        await held.wait();
        return claim(...args);
      });
    });
    const limit = heldBound();
    const res = tracked(fetchBounded(limit.bound, postRequest("/cli/claim", session.token, { agentId: "laptop" })));
    await held.reached();
    // A sentinel call to the Hub goes through while the claim is held there.
    expect(await (await hub()).isLocalPresent()).toBe(true);
    expect(res.settled()).toBe(false);

    limit.expire();
    expect(await failure(within(res.promise, 3000))).toEqual(failed(503, "unavailable"));
    expect(limit.bounds).toEqual([{ ms: ROUTE_CALL_MS, what: "the Hub's claim" }]);
    await held.open();
    await vi.waitFor(async () => expect((await session.stub.view()).jobs[0]?.state).toBe("claimed"), { timeout: 3000 });
    expect(await claimOver(session.token, "laptop")).toMatchObject({ resumed: true });
  });

  it("answers 503 when a submit does not answer in time; the late submit stores the answer once", async () => {
    captureLogs();
    const session = await localSession("cli", sockets, Q1);
    const claim = holding(await claimOver(session.token, "laptop"));
    const held = await holdInsert(session.stub, "before");
    const limit = heldBound();
    const body = { ...submission(claim, "laptop"), pr: session.ref };
    const res = tracked(fetchBounded(limit.bound, postRequest("/cli/submit", session.token, body)));
    await held.reached();
    // A sentinel read of the session goes through while the submit is held in its append.
    expect((await session.stub.view()).jobs.map((job) => job.state)).toEqual(["running"]);
    expect(res.settled()).toBe(false);

    limit.expire();
    expect(await failure(within(res.promise, 3000))).toEqual(failed(503, "unavailable"));
    expect(limit.bounds).toEqual([{ ms: ROUTE_CALL_MS, what: "the submit" }]);
    await held.open();
    // The agent sends it again: it waits for the late submit and gets its result.
    expect(await accepted(submitOver(session.token, session.ref, claim, "laptop"))).toEqual({
      status: "duplicate",
      messageId: `answer-${claim.job.jobId}`,
    });
    expect(await answers(session)).toHaveLength(1);
  });

  it("answers 503 when the Hub's wait does not answer in time, and ends that wait in the Hub", async () => {
    captureLogs();
    const token = await hostToken();
    const held = await gate(await hub());
    let aborted = false;
    await runInDurableObject(await hub(), (instance) => {
      vi.spyOn(instance, "onRequest").mockImplementationOnce(async (hubRequest) => {
        hubRequest.signal.addEventListener("abort", () => {
          aborted = true;
        });
        await held.wait();
        return Response.json({ status: "timeout" });
      });
    });
    const limit = heldBound();
    const req = postRequest("/cli/wait", token, { agentId: "laptop", timeoutMs: 1000 });
    const res = tracked(fetchBounded(limit.bound, req));
    await held.reached();
    expect(res.settled()).toBe(false);

    limit.expire();
    expect(await failure(within(res.promise, 3000))).toEqual(failed(503, "unavailable"));
    expect(limit.bounds).toEqual([{ ms: 1000 + ROUTE_CALL_MS, what: "the Hub's wait" }]);
    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 3000 });
    await held.open();
  });
});
