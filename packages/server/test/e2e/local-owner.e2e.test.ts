// Doc checks 2 and 6: a local-owned PrSession, prq wait / claim / submit, and a connected chat client.
// One wrangler dev for the file; every test uses its own session and agent IDs and leaves no open job behind.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChatClient, accessToken, api, delay, prq, sendWebhook, session, sessionState, startDev, textOf, type Dev } from "./support.ts";

let dev: Dev;
let token: string;

beforeAll(async () => {
  dev = await startDev();
  token = await accessToken("service");
  // A local agent joins the pool by connecting; sessions created afterwards are local-owned.
  const r = await prq(dev, ["wait", "--poll-ms", "200", "--max-wait-ms", "200"], { token, agentId: "warmup" });
  expect(r.code).toBe(2);
});
afterAll(async () => {
  await dev?.stop();
});

const claim = (agentId: string) => prq(dev, ["claim"], { token, agentId });
const submit = (agentId: string, job: any, claimId: string, text: string) =>
  prq(
    dev,
    [
      "submit",
      "--session", job.session,
      "--job", job.jobId,
      "--claim", claimId,
      "--kind", job.target.kind,
      "--target", job.target.messageId ?? job.target.headSha,
      "--text", text,
    ],
    { token, agentId },
  );
const answers = (messages: any[]) => messages.filter((m) => m.role === "assistant");

describe("local owner", () => {
  it("routes a UI question to prq without a model turn, and the chat client receives the submitted answer", async () => {
    const name = "octo~demo~1";
    const agentId = "laptop-1";
    const waiting = prq(dev, ["wait", "--poll-ms", "2000"], { token, agentId });
    await delay(300);
    const chat = await ChatClient.connect(dev, name);
    const { messageId, requestId } = chat.send("what does this PR change?");

    // No model turn: the request completes with no streamed text.
    await chat.waitFor(() => chat.streamed(requestId).done);
    expect(chat.streamed(requestId).text).toBe("");

    const w = await waiting;
    expect(w.code).toBe(0);
    expect(w.json).toEqual({ status: "ready" });

    const c = await claim(agentId);
    expect(c.json.job).toMatchObject({ session: name, target: { kind: "answer", messageId }, question: "what does this PR change?" });
    const s = await submit(agentId, c.json.job, c.json.claimId, "It adds the parser.");
    expect(s.code).toBe(0);
    expect(s.json.status).toBe("accepted");

    // The persisted answer reaches the connected client (persistMessages broadcast, no turn).
    const got = await chat.waitFor(() => chat.messages.find((m) => m.id === s.json.messageId));
    expect(textOf(got)).toBe("It adds the parser.");
    expect((await sessionState(dev, name)).owner).toBe("local");
    await chat.close();
  });

  it("takes a second question while the first is pending, and answers both in order", async () => {
    const name = "octo~demo~2";
    const agentId = "laptop-2";
    const chat = await ChatClient.connect(dev, name);
    const q1 = chat.send("first?");
    await chat.waitFor(() => chat.streamed(q1.requestId).done);
    const q2 = chat.send("second?");
    await chat.waitFor(() => chat.streamed(q2.requestId).done);

    const jobs = (await sessionState(dev, name)).jobs;
    expect(jobs.map((j: any) => [j.target, j.state])).toEqual([
      [q1.messageId, "pending"],
      [q2.messageId, "pending"],
    ]);

    const c1 = await claim(agentId);
    expect(c1.json.job.target.messageId).toBe(q1.messageId);
    expect((await submit(agentId, c1.json.job, c1.json.claimId, "answer 1")).code).toBe(0);
    // After one answer, wait returns again at once for the second.
    const w2 = await prq(dev, ["wait", "--poll-ms", "2000", "--max-wait-ms", "3000"], { token, agentId });
    expect(w2.json).toEqual({ status: "ready" });
    const c2 = await claim(agentId);
    expect(c2.json.job.target.messageId).toBe(q2.messageId);
    expect((await submit(agentId, c2.json.job, c2.json.claimId, "answer 2")).code).toBe(0);

    await chat.waitFor(() => answers(chat.messages).length === 2);
    expect(chat.messages.map((m) => textOf(m))).toEqual(["first?", "second?", "answer 1", "answer 2"]);
    await chat.close();
  });

  it("treats a resubmit of the same jobId and claimId as idempotent: same result, no second message", async () => {
    const name = "octo~demo~3";
    const agentId = "laptop-3";
    const chat = await ChatClient.connect(dev, name);
    const q = chat.send("idempotent?");
    await chat.waitFor(() => chat.streamed(q.requestId).done);
    const c = await claim(agentId);
    const first = await submit(agentId, c.json.job, c.json.claimId, "once");
    const again = await submit(agentId, c.json.job, c.json.claimId, "once");
    // Two concurrent resends as well.
    const [x, y] = await Promise.all([
      submit(agentId, c.json.job, c.json.claimId, "once"),
      submit(agentId, c.json.job, c.json.claimId, "once"),
    ]);
    expect(first.json).toEqual({ status: "accepted", messageId: `answer-${c.json.job.jobId}` });
    for (const r of [again, x, y]) {
      expect(r.code).toBe(0);
      expect(r.json).toEqual({ status: "duplicate", messageId: first.json.messageId });
    }
    const st = await sessionState(dev, name);
    expect(answers(st.messages)).toHaveLength(1);
    await chat.close();
  });

  it("rejects the old claimId after retry, and accepts the new claim", async () => {
    const name = "octo~demo~4";
    const agentId = "laptop-4";
    const chat = await ChatClient.connect(dev, name);
    const q = chat.send("retry?");
    await chat.waitFor(() => chat.streamed(q.requestId).done);
    const c1 = await claim(agentId);
    const retried = await api(dev, `/api/session/${session(name)}/jobs/${c1.json.job.jobId}/retry`, { method: "POST" });
    expect(retried).toEqual({ ok: true });

    const late = await submit(agentId, c1.json.job, c1.json.claimId, "late answer");
    expect(late.code).toBe(4);
    expect(late.json.error).toBe("stale_claim");

    const c2 = await claim(agentId);
    expect(c2.json.job.jobId).toBe(c1.json.job.jobId);
    expect(c2.json.claimId).not.toBe(c1.json.claimId);
    expect((await submit(agentId, c2.json.job, c2.json.claimId, "fresh answer")).json.status).toBe("accepted");
    const st = await sessionState(dev, name);
    expect(answers(st.messages).map(textOf)).toEqual(["fresh answer"]);
    await chat.close();
  });

  it("gives a restarted process with the same agent ID its claimed job first, with a new claimId; the old one is rejected", async () => {
    const name = "octo~demo~5";
    const agentId = "laptop-5";
    const chat = await ChatClient.connect(dev, name);
    const q1 = chat.send("resume 1");
    await chat.waitFor(() => chat.streamed(q1.requestId).done);
    const before = await claim(agentId); // the process that dies
    const q2 = chat.send("resume 2"); // a newer pending job exists when it comes back
    await chat.waitFor(() => chat.streamed(q2.requestId).done);

    // The restarted process: wait returns at once, and claim returns the unfinished job, not the newer one.
    const w = await prq(dev, ["wait", "--poll-ms", "2000", "--max-wait-ms", "3000"], { token, agentId });
    expect(w.json).toEqual({ status: "ready" });
    const after = await claim(agentId);
    expect(after.json.resumed).toBe(true);
    expect(after.json.job.jobId).toBe(before.json.job.jobId);
    expect(after.json.claimId).not.toBe(before.json.claimId);

    const old = await submit(agentId, before.json.job, before.json.claimId, "from the dead process");
    expect(old.code).toBe(4);
    expect(old.json.error).toBe("stale_claim");
    expect((await submit(agentId, after.json.job, after.json.claimId, "answer 1")).json.status).toBe("accepted");

    const next = await claim(agentId);
    expect(next.json.resumed).toBe(false);
    expect(next.json.job.target.messageId).toBe(q2.messageId);
    expect((await submit(agentId, next.json.job, next.json.claimId, "answer 2")).json.status).toBe("accepted");
    await chat.close();
  });

  it("never gives a job claimed by one agent ID to another", async () => {
    const name = "octo~demo~6";
    const chat = await ChatClient.connect(dev, name);
    const q = chat.send("whose job?");
    await chat.waitFor(() => chat.streamed(q.requestId).done);
    const a = await claim("agent-a");
    expect(a.json.job.target.messageId).toBe(q.messageId);

    const b = await claim("agent-b");
    expect(b.json).toEqual({ job: null });
    const bw = await prq(dev, ["wait", "--poll-ms", "500", "--max-wait-ms", "800"], { token, agentId: "agent-b" });
    expect(bw.code).toBe(2);
    const steal = await submit("agent-b", a.json.job, a.json.claimId, "stolen");
    expect(steal.code).toBe(4);
    expect(steal.json.error).toBe("stale_claim");

    expect((await submit("agent-a", a.json.job, a.json.claimId, "mine")).json.status).toBe("accepted");
    await chat.close();
  });

  it("keeps the job when the waiter disconnects right after the notify", async () => {
    const name = "octo~demo~7";
    const agentId = "laptop-7";
    // 1) A waiter is killed mid-poll; the question arrives while nobody is connected.
    const doomed = prq(dev, ["wait", "--poll-ms", "5000"], { token, agentId });
    await delay(500);
    doomed.child.kill("SIGKILL");
    await doomed;
    const chat = await ChatClient.connect(dev, name);
    const q = chat.send("still there?");
    await chat.waitFor(() => chat.streamed(q.requestId).done);

    // 2) The next waiter returns at once; it receives the notify and then dies before claiming.
    const t0 = Date.now();
    const w1 = await prq(dev, ["wait", "--poll-ms", "5000", "--max-wait-ms", "6000"], { token, agentId });
    expect(w1.json).toEqual({ status: "ready" });
    expect(Date.now() - t0).toBeLessThan(3000);

    // 3) wait does not consume: the job is still there for the next wait and claim.
    const w2 = await prq(dev, ["wait", "--poll-ms", "5000", "--max-wait-ms", "6000"], { token, agentId });
    expect(w2.json).toEqual({ status: "ready" });
    const c = await claim(agentId);
    expect(c.json.job.target.messageId).toBe(q.messageId);
    expect((await submit(agentId, c.json.job, c.json.claimId, "yes")).json.status).toBe("accepted");
    await chat.close();
  });

  it("wakes a waiting prq as soon as a question arrives", async () => {
    const name = "octo~demo~8";
    const agentId = "laptop-8";
    const waiting = prq(dev, ["wait", "--poll-ms", "10000"], { token, agentId });
    await delay(1000);
    const chat = await ChatClient.connect(dev, name);
    const sent = Date.now();
    const q = chat.send("wake up");
    const w = await waiting;
    expect(w.json).toEqual({ status: "ready" });
    expect(Date.now() - sent).toBeLessThan(3000);
    await chat.waitFor(() => chat.streamed(q.requestId).done);
    const c = await claim(agentId);
    expect((await submit(agentId, c.json.job, c.json.claimId, "awake")).json.status).toBe("accepted");
    await chat.close();
  });

  it("exits with the auth code on 401/403, distinct from the timeout code", async () => {
    const bad = await prq(dev, ["wait", "--poll-ms", "500", "--max-wait-ms", "1000"], {
      token: await accessToken("service", { secret: "wrong-secret" }),
      agentId: "auth",
    });
    expect(bad.code).toBe(3);
    expect(bad.stderr).toContain("authentication failed: 401");
    const user = await prq(dev, ["wait", "--poll-ms", "500", "--max-wait-ms", "1000"], {
      token: await accessToken("user"),
      agentId: "auth",
    });
    expect(user.code).toBe(3);
    expect(user.stderr).toContain("authentication failed: 403");
    const none = await prq(dev, ["wait", "--poll-ms", "500", "--max-wait-ms", "1000"], { token: "", agentId: "auth" });
    expect(none.code).toBe(3);
    const timeout = await prq(dev, ["wait", "--poll-ms", "500", "--max-wait-ms", "1200"], { token, agentId: "auth" });
    expect(timeout.code).toBe(2);
    expect(timeout.json).toEqual({ status: "timeout" });
  });

  it("queues webhook analyses for prq: answers first, duplicate deliveries dropped, unstarted analyses coalesced", async () => {
    const repo = "octo/hooks";
    const name = "octo~hooks~9";
    const agentId = "laptop-9";
    const r1 = await sendWebhook(dev, { repo, number: 9, headSha: "aaa", action: "opened" }, { deliveryId: "dl-1" });
    expect(await r1.json()).toMatchObject({ status: "accepted" });
    const dup = await sendWebhook(dev, { repo, number: 9, headSha: "aaa" }, { deliveryId: "dl-1" });
    expect(await dup.json()).toEqual({ status: "duplicate" });
    const a = await claim(agentId); // analysis A is in progress
    expect(a.json.job.target).toEqual({ kind: "analysis", headSha: "aaa" });
    await sendWebhook(dev, { repo, number: 9, headSha: "bbb" });
    await sendWebhook(dev, { repo, number: 9, headSha: "ccc" });
    const chat = await ChatClient.connect(dev, name);
    const q = chat.send("question during analysis");
    await chat.waitFor(() => chat.streamed(q.requestId).done);

    expect((await submit(agentId, a.json.job, a.json.claimId, "analysis of aaa")).json.status).toBe("accepted");
    const order: string[] = [];
    for (;;) {
      const c = await claim(agentId);
      if (!c.json.job) break;
      order.push(c.json.job.target.kind === "answer" ? "question" : c.json.job.target.headSha);
      expect((await submit(agentId, c.json.job, c.json.claimId, `done ${order.at(-1)}`)).json.status).toBe("accepted");
    }
    expect(order).toEqual(["question", "ccc"]);
    const st = await sessionState(dev, name);
    expect(st.jobs.map((j: any) => [j.kind, j.target, j.state])).toEqual([
      ["analysis", "aaa", "done"],
      ["analysis", "bbb", "superseded"],
      ["analysis", "ccc", "done"],
      ["answer", q.messageId, "done"],
    ]);
    // A webhook for someone else's PR is ignored even when they sent it to the owner's repo.
    const other = await sendWebhook(dev, { repo, number: 10, headSha: "zzz", authorId: 42 });
    expect(await other.json()).toEqual({ status: "ignored" });
    const forged = await sendWebhook(dev, { repo, number: 9, headSha: "evil" }, { secret: "wrong" });
    expect(forged.status).toBe(401);
    await chat.close();
  });
});
