import {
  type ClaimResponse,
  ContextResponse,
  ErrorResponse,
  MAX_FULL_NAME_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
  PROMPT_CHARS,
  PRQ_VERSION_HEADER,
  ROUTE_CALL_MS,
  SKILL_COUNT,
  SKILL_DESCRIPTION_CHARS,
} from "@prq/protocol";
import { runInDurableObject } from "cloudflare:test";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRESENCE_MS, STALL_MS } from "./ledger.ts";
import { CONTEXT_PAGE_BYTES, jsonBytes, take } from "./pr-session/context.ts";
import { PrSession } from "./pr-session/index.ts";
import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import {
  accepted,
  claimOver,
  fetchBounded,
  heldBound,
  claimedAgo,
  lastSeenAgo,
  localSession,
  post,
  postRequest,
  submitOver,
} from "./test/cli.ts";
import {
  clearQueue,
  clearSkills,
  gate,
  clearPrompts,
  holdInsert,
  hub,
  jobRows,
  prSessionSeams,
  retryIn,
  tracked,
  within,
} from "./test/session.ts";
import { registered, skillWith } from "./test/skills.ts";
import { BASE, push, send, sha } from "./test/webhook.ts";
import { SERVER_VERSION } from "./version.ts";

const sockets: AgentSocket[] = [];

// Each test starts from an empty queue: the sessions of earlier tests may still have work.
beforeEach(async () => {
  await clearQueue();
  await clearPrompts();
  await clearSkills();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

function holding(claim: ClaimResponse) {
  if (claim.job === null) {
    throw new Error("nothing was claimed");
  }
  return { ...claim, job: claim.job };
}

type Held = ReturnType<typeof holding>;

function contextBody(pr: { owner: string; repo: string; number: number }, claim: Held, agentId: string) {
  return { agentId, pr, jobId: claim.job.jobId, claimId: claim.claimId };
}

async function contextOf(response: Promise<Response>): Promise<ContextResponse> {
  const res = await response;
  expect(res.status).toBe(200);
  expect(res.headers.get(PRQ_VERSION_HEADER)).toBe(SERVER_VERSION);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return v.parse(ContextResponse, await res.json());
}

async function refused(response: Promise<Response>) {
  const res = await response;
  return {
    status: res.status,
    error: v.parse(ErrorResponse, await res.json()).error,
    version: res.headers.get(PRQ_VERSION_HEADER),
  };
}

describe("context", () => {
  it("gives the claim's job, the pull request, its details once a webhook gave them, and the conversation", async () => {
    captureLogs();
    const { ref, token } = await localSession("context", sockets, question("q1"));
    const claim = holding(await claimOver(token, "laptop"));
    // The pull request in another case reaches the same session and comes back canonical.
    const asked = { ...ref, owner: "OCTO" };

    const before = await contextOf(post("/cli/context", token, contextBody(asked, claim, "laptop")));
    const never = { text: "", savedAt: null };
    expect(before).toEqual({
      pr: ref,
      details: null,
      job: claim.job,
      instructions: { prompts: { analysis: never, answer: never }, skills: [] },
      messages: [{ id: "q1", role: "user", text: "question q1" }],
      nextCursor: null,
    });
    expect(claim.job.workspaceSha).toBeNull();

    // The first webhook, and another agent's analysis of its head.
    await push(ref, "A");
    const analysis = holding(await claimOver(token, "desk"));
    const { messageId } = await accepted(submitOver(token, ref, analysis, "desk", "the summary"));

    const after = await contextOf(post("/cli/context", token, contextBody(asked, claim, "laptop")));
    expect(after.details).toEqual({
      fullName: `${ref.owner}/${ref.repo}`,
      title: "A change",
      state: "open",
      url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      headSha: sha("A"),
      baseSha: BASE,
    });
    // The workspace stays the one the claim fixed.
    expect(after.job).toEqual(claim.job);
    expect(after.messages).toEqual([
      { id: "q1", role: "user", text: "question q1" },
      {
        id: messageId,
        role: "assistant",
        text: "the summary",
        metadata: {
          kind: "analysis",
          jobId: analysis.job.jobId,
          headSha: sha("A"),
          run: 1,
          by: { kind: "local", agentId: "desk" },
        },
      },
    ]);
  });

  it("fixes an answer's workspace at the latest completed analysis, else the current head", async () => {
    captureLogs();
    const { ref, token, client } = await localSession("context", sockets);
    await push(ref, "A");
    await client.chat([question("q1")]);
    const beforeAnalysis = holding(await claimOver(token, "laptop"));
    expect(beforeAnalysis.job).toMatchObject({ target: { messageId: "q1" }, workspaceSha: sha("A") });

    await accepted(submitOver(token, ref, holding(await claimOver(token, "desk")), "desk"));
    await push(ref, "B");
    await client.chat([question("q1"), question("q2")]);
    const afterAnalysis = holding(await claimOver(token, "desk-2"));
    expect(afterAnalysis.job).toMatchObject({ target: { messageId: "q2" }, workspaceSha: sha("A") });
  });

  it("gives the context while the claim's own submit appends its answer", async () => {
    captureLogs();
    const { ref, token, stub } = await localSession("context", sockets, question("q1"));
    const claim = holding(await claimOver(token, "laptop"));
    const held = await holdInsert(stub, "before");
    const submit = tracked(submitOver(token, ref, claim, "laptop"));
    await held.reached();

    // The context goes through while the submit is held in its append, the job finalizing under the same claim.
    expect((await jobRows(stub)).map((row) => row.state)).toEqual(["finalizing"]);
    const read = await contextOf(post("/cli/context", token, contextBody(ref, claim, "laptop")));
    expect(read.job).toEqual(claim.job);
    expect(submit.settled()).toBe(false);

    await held.open();
    expect(await accepted(submit.promise)).toMatchObject({ status: "accepted" });
  });

  it("refuses a claim that a resume ended while the page was read", async () => {
    captureLogs();
    const { ref, token, stub } = await localSession("context", sockets, question("q1"));
    const claim = holding(await claimOver(token, "laptop"));
    // The context is held in the session after it read the conversation's IDs.
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const session = instance.sessions.session();
      const read = session.getHistoryRowStats.bind(session);
      vi.spyOn(session, "getHistoryRowStats").mockImplementationOnce(async (...args) => {
        const stats = await read(...args);
        await held.wait();
        return stats;
      });
    });
    const res = tracked(post("/cli/context", token, contextBody(ref, claim, "laptop")));
    await held.reached();

    // Meanwhile the agent claims again: a resume, under a new claim.
    const resumed = await within(claimOver(token, "laptop"), 3000);
    expect(resumed).toMatchObject({ resumed: true, job: { jobId: claim.job.jobId } });
    expect(res.settled()).toBe(false);
    await held.open();

    expect(await refused(res.promise)).toEqual({ status: 409, error: "stale_claim", version: SERVER_VERSION });
  });

  it("refuses a claim that a retry ended while the host's instructions were read", async () => {
    captureLogs();
    const { ref, token, stub } = await localSession("context", sockets, question("q1"));
    const claim = holding(await claimOver(token, "laptop"));
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const read = seams.readInstructions.bind(instance);
      vi.spyOn(seams, "readInstructions").mockImplementationOnce(async () => {
        await held.wait();
        return read();
      });
    });
    const res = tracked(post("/cli/context", token, contextBody(ref, claim, "laptop")));
    await held.reached();

    expect(await retryIn(stub, claim.job.jobId)).toEqual({ status: "retried" });
    expect(res.settled()).toBe(false);
    await held.open();

    expect(await refused(res.promise)).toEqual({ status: 409, error: "stale_claim", version: SERVER_VERSION });
  });

  it("refuses a claim that a retry ended while a read of the host's instructions failed, rather than answer 503", async () => {
    captureLogs();
    const { ref, token, stub } = await localSession("context", sockets, question("q1"));
    const claim = holding(await claimOver(token, "laptop"));
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "readInstructions").mockImplementationOnce(async () => {
        await held.wait();
        throw new Error("the Hub is away");
      });
    });
    const res = tracked(post("/cli/context", token, contextBody(ref, claim, "laptop")));
    await held.reached();

    expect(await retryIn(stub, claim.job.jobId)).toEqual({ status: "retried" });
    expect(res.settled()).toBe(false);
    await held.open();

    expect(await refused(res.promise)).toEqual({ status: 409, error: "stale_claim", version: SERVER_VERSION });
  });

  it("answers 503 when the host's instructions cannot be read, so the agent asks again", async () => {
    captureLogs();
    const { ref, token, stub } = await localSession("context", sockets, question("q1"));
    const claim = holding(await claimOver(token, "laptop"));
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "readInstructions").mockRejectedValueOnce(new Error("the Hub is away"));
    });

    expect(await refused(post("/cli/context", token, contextBody(ref, claim, "laptop")))).toEqual({
      status: 503,
      error: "unavailable",
      version: SERVER_VERSION,
    });
    expect((await contextOf(post("/cli/context", token, contextBody(ref, claim, "laptop")))).instructions).toEqual({
      prompts: { analysis: { text: "", savedAt: null }, answer: { text: "", savedAt: null } },
      skills: [],
    });
  });

  it("refuses any other claim with 409, and an unknown job with 404", async () => {
    captureLogs();
    const { ref, token } = await localSession("context", sockets, question("q1"));
    await push(ref, "A");
    const answer = holding(await claimOver(token, "laptop"));
    const analysis = holding(await claimOver(token, "desk"));
    await accepted(submitOver(token, ref, analysis, "desk"));

    const stale = { status: 409, error: "stale_claim", version: SERVER_VERSION };
    const otherClaim = { ...contextBody(ref, answer, "laptop"), claimId: crypto.randomUUID() };
    expect(await refused(post("/cli/context", token, otherClaim))).toEqual(stale);
    expect(await refused(post("/cli/context", token, contextBody(ref, answer, "desk")))).toEqual(stale);
    // A finished job's claim holds it no longer.
    expect(await refused(post("/cli/context", token, contextBody(ref, analysis, "desk")))).toEqual(stale);
    // A resume replaces the claim.
    const resumed = holding(await claimOver(token, "laptop"));
    expect(resumed).toMatchObject({ resumed: true, job: { jobId: answer.job.jobId } });
    expect(await refused(post("/cli/context", token, contextBody(ref, answer, "laptop")))).toEqual(stale);
    await contextOf(post("/cli/context", token, contextBody(ref, resumed, "laptop")));

    const unknown = { ...contextBody(ref, answer, "laptop"), jobId: crypto.randomUUID() };
    expect(await refused(post("/cli/context", token, unknown))).toEqual({
      status: 404,
      error: "unknown_job",
      version: SERVER_VERSION,
    });
  });

  it("counts a context, accepted or not, as a contact from the agent", async () => {
    captureLogs();
    const { ref, token } = await localSession("context", sockets, question("q1"));
    const claim = holding(await claimOver(token, "laptop"));

    // Neither the agent's last contact nor its claim keeps it present.
    await claimedAgo(STALL_MS + PRESENCE_MS);
    await lastSeenAgo(PRESENCE_MS + 1);
    expect(await (await hub()).isLocalPresent()).toBe(false);
    await refused(post("/cli/context", token, { ...contextBody(ref, claim, "laptop"), claimId: crypto.randomUUID() }));
    expect(await (await hub()).isLocalPresent()).toBe(true);

    await lastSeenAgo(PRESENCE_MS + 1);
    await contextOf(post("/cli/context", token, contextBody(ref, claim, "laptop")));
    expect(await (await hub()).isLocalPresent()).toBe(true);
  });
});

// Messages stored straight in the session's history, as the SDK stores them.
async function store(stub: DurableObjectStub<PrSession>, messages: { id: string; text: string }[]): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    for (const { id, text } of messages) {
      await instance.sessions.session().appendMessage({ id, role: "assistant", parts: [{ type: "text", text }] });
    }
  });
}

// Every page of the conversation from the first, with `between` run after the first page; each whole response is
// checked against the page budget.
async function allPages(
  body: Record<string, unknown>,
  token: string,
  between?: () => Promise<unknown>,
): Promise<ContextResponse[]> {
  const pages: ContextResponse[] = [];
  let cursor: string | null | undefined;
  do {
    const res = await post("/cli/context", token, cursor === undefined ? body : { ...body, cursor });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(CONTEXT_PAGE_BYTES);
    const page = v.parse(ContextResponse, JSON.parse(text));
    pages.push(page);
    // A cursor that does not move on would page forever.
    expect(pages.length).toBeLessThan(64);
    cursor = page.nextCursor;
    if (pages.length === 1) {
      await between?.();
    }
  } while (cursor !== null);
  return pages;
}

describe("context pages", () => {
  it("pages a conversation larger than a call can carry, and the cursor holds while a question is added", async () => {
    captureLogs();
    const { ref, token, stub, client } = await localSession("pages", sockets, question("q1"));
    const claim = holding(await claimOver(token, "laptop"));
    // 35 messages of a million characters each: 35 MB, more than the 32 MiB one RPC call carries.
    const big = Array.from({ length: 35 }, (_, i) => ({ id: `big-${i}`, text: String(i % 10).repeat(1_000_000) }));
    await store(stub, big);

    const pages = await allPages(contextBody(ref, claim, "laptop"), token, () =>
      client.chat([question("q1"), question("q2")]),
    );

    const messages = pages.flatMap((page) => page.messages);
    expect(messages.map((message) => message.id)).toEqual(["q1", ...big.map((message) => message.id), "q2"]);
    expect(messages.slice(1, -1).map((message) => message.text)).toEqual(big.map((message) => message.text));
    expect(messages.some((message) => message.part !== undefined)).toBe(false);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.job).toEqual(claim.job);
    }
  });

  it("splits a message larger than a page into parts the agent joins", async () => {
    captureLogs();
    const { ref, token, stub } = await localSession("pages", sockets, question("q1"));
    const claim = holding(await claimOver(token, "laptop"));
    // Escaped quotes and surrogate pairs: about 12 MB as JSON, more than a page.
    const text = 'ab"\u{1F600}'.repeat(1_500_000);
    await store(stub, [
      { id: "huge", text },
      { id: "after", text: "the next one" },
    ]);

    const pages = await allPages(contextBody(ref, claim, "laptop"), token);

    const parts = pages.flatMap((page) => page.messages).filter((message) => message.id === "huge");
    expect(parts.length).toBeGreaterThan(1);
    let joined = "";
    for (const part of parts) {
      expect(part.part).toEqual({ offset: joined.length, length: text.length });
      // No part ends or starts inside a surrogate pair.
      expect(part.text.isWellFormed()).toBe(true);
      joined += part.text;
    }
    expect(joined === text).toBe(true);
    expect(pages.flatMap((page) => page.messages).at(-1)).toMatchObject({ id: "after", text: "the next one" });
  });

  it("pages a question larger than a page, which the claim and the job name by its message", async () => {
    captureLogs();
    // A character beyond Latin-1 and 12 MiB of ASCII: with the question next to a page, more than a call carries.
    const text = `\u0100${"x".repeat(12 * 1024 * 1024)}`;
    const { ref, token } = await localSession("pages", sockets, question("huge-q", text));
    const claim = holding(await claimOver(token, "laptop"));
    expect(claim.job.target).toEqual({ kind: "answer", messageId: "huge-q" });
    expect(JSON.stringify(claim).length).toBeLessThan(1024);

    const pages = await allPages(contextBody(ref, claim, "laptop"), token);

    expect(pages.length).toBeGreaterThan(1);
    const parts = pages.flatMap((page) => page.messages).filter((message) => message.id === "huge-q");
    expect(parts.map((part) => part.text).join("") === text).toBe(true);
    for (const page of pages) {
      expect(page.job).toEqual(claim.job);
    }
  });

  it("keeps the whole response within the budget with the largest details a webhook gives", async () => {
    captureLogs();
    const { ref, token, stub } = await localSession("pages", sockets, question("q1"));
    const claim = holding(await claimOver(token, "laptop"));
    // Each field at its cap, each character a six-byte escape in JSON.
    const title = "\u0001".repeat(MAX_TITLE_CHARS);
    await send(ref, {
      head: sha("A"),
      title,
      url: "\u0001".repeat(MAX_URL_CHARS),
      fullName: "\u0001".repeat(MAX_FULL_NAME_CHARS),
    });
    // A message larger than a page, under the longest ID the protocol allows: alone on a page, its part fills the page
    // to the room the rest of the response leaves, the cursor naming it included.
    const longId = "m".repeat(256);
    await store(stub, [
      { id: "small", text: "a small one" },
      { id: longId, text: "x".repeat(12 * 1024 * 1024) },
    ]);

    const pages = await allPages(contextBody(ref, claim, "laptop"), token);

    expect(pages.map((page) => page.messages.map((message) => message.id))).toEqual([
      ["q1", "small"],
      [longId],
      [longId],
    ]);
    const full = pages[1];
    expect(full?.details?.title).toBe(title);
    expect(full?.nextCursor).toContain(longId);
    expect(new TextEncoder().encode(JSON.stringify(full)).length).toBeGreaterThan(CONTEXT_PAGE_BYTES - 64);
  });

  it("carries both prompts and the skill list at their caps on the first page only, the page within the budget", async () => {
    captureLogs();
    // Each prompt and SKILL_COUNT descriptions at their caps, each character a six-byte escape in JSON; and a question
    // larger than a page, which the first page holds as much of as its room allows.
    const analysis = "\u0001".repeat(PROMPT_CHARS);
    const answer = "\u0002".repeat(PROMPT_CHARS);
    await (await hub()).savePrompt("analysis", analysis);
    await (await hub()).savePrompt("answer", answer);
    const skills = [];
    for (let index = 0; index < SKILL_COUNT; index += 1) {
      const name = `skill-${String(index).padStart(2, "0")}`;
      const description = "\u0003".repeat(SKILL_DESCRIPTION_CHARS);
      skills.push(await registered(skillWith(name, { description, sha: String(index % 10).repeat(40) })));
    }
    const { ref, token } = await localSession("pages", sockets, question("huge-q", "x".repeat(12 * 1024 * 1024)));
    const claim = holding(await claimOver(token, "laptop"));

    const pages = await allPages(contextBody(ref, claim, "laptop"), token);

    expect(pages.length).toBeGreaterThan(1);
    const [first, ...later] = pages;
    expect(first?.instructions?.prompts.analysis.text).toBe(analysis);
    expect(first?.instructions?.prompts.answer.text).toBe(answer);
    // Each registered skill, by name, with its description, revision and commit; nothing else of it.
    expect(first?.instructions?.skills).toEqual(
      skills.map((skill) => ({ name: skill.name, description: skill.description, rev: skill.rev, sha: skill.sha })),
    );
    expect(later.every((page) => page.instructions === undefined)).toBe(true);
    // The first page is filled to the room the instructions leave.
    const bytes = new TextEncoder().encode(JSON.stringify(first)).length;
    expect(bytes).toBeGreaterThan(CONTEXT_PAGE_BYTES - 64 * 1024);
    expect(bytes).toBeLessThanOrEqual(CONTEXT_PAGE_BYTES);
  });

  it("refuses a page that cannot hold the first character of its message, from a row stored before IDs were bounded", async () => {
    const logs = captureLogs();
    const { ref, token, stub } = await localSession("pages", sockets);
    await push(ref, "A");
    const claim = holding(await claimOver(token, "laptop"));
    // An ID no chat request may add now, 4.2 MB as JSON: the message and the cursor that may name it take more than a
    // page, so not even its first character fits.
    await store(stub, [{ id: "\u0001".repeat(700_000), text: "stored before the bound" }]);

    const res = await post("/cli/context", token, contextBody(ref, claim, "laptop"));

    const body = await res.text();
    expect(body.length).toBeLessThan(1024);
    expect({ status: res.status, body: v.parse(ErrorResponse, JSON.parse(body)) }).toEqual({
      status: 500,
      body: { error: "internal", detail: "the conversation from this place does not fit in a context page" },
    });
    expect(logs.map((log) => log.entry).filter((entry) => entry["event"] === "prq.context.overflow")).toMatchObject([
      { jobId: claim.job.jobId },
    ]);
  });

  it("takes a whole surrogate pair, or nothing, when the room is for one character", () => {
    const message = { id: "emoji", role: "assistant", text: "\u{1F600}".repeat(16) } as const;
    const pair = { ...message, text: "\u{1F600}", part: { offset: 0, length: 32 } };
    expect(take(message, 0, jsonBytes(pair), true)).toEqual(pair);
    expect(take(message, 0, jsonBytes(pair) - 1, true)).toBeNull();
  });

  it("takes a leading surrogate pair whole when the cut lands inside it, in mixed text", () => {
    // The shrinking cut jumps straight to one code unit here; the pair fits though half of it, escaped, does not.
    const message = { id: "x", role: "user", text: "\u{1F600}abc\u{1F600}def".repeat(4) } as const;
    expect(take(message, 0, 70, true)).toEqual({ ...message, text: "\u{1F600}", part: { offset: 0, length: 40 } });
  });

  it("never ends a part inside a surrogate pair, whatever room the page has", () => {
    const message = { id: "emoji", role: "assistant", text: "\u{1F600}".repeat(64) } as const;
    // From room for one character up: the cut falls on either half of a pair across these.
    for (let left = 100; left <= 400; left += 1) {
      let joined = "";
      while (joined.length < message.text.length) {
        const part = take(message, joined.length, left, true);
        expect({ left, wellFormed: part?.text.isWellFormed() }).toEqual({ left, wellFormed: true });
        joined += part?.text ?? "";
      }
      expect(joined === message.text).toBe(true);
    }
  });

  it("refuses a cursor that names no place in the conversation with 400", async () => {
    captureLogs();
    const { ref, token } = await localSession("pages", sockets, question("q1"));
    const claim = holding(await claimOver(token, "laptop"));
    for (const cursor of ["not a cursor", "0:no-such-message", "99:q1"]) {
      const res = refused(post("/cli/context", token, { ...contextBody(ref, claim, "laptop"), cursor }));
      expect({ cursor, ...(await res) }).toEqual({
        cursor,
        status: 400,
        error: "bad_request",
        version: SERVER_VERSION,
      });
    }
  });
});

describe("context time limit", () => {
  it("answers 503 when the session does not answer in time; the late context changes nothing", async () => {
    captureLogs();
    const { ref, token, stub } = await localSession("context", sockets, question("q1"));
    const claim = holding(await claimOver(token, "laptop"));
    const rows = await jobRows(stub);
    // The session's context is held as it starts. RPC calls a method from the class, so the spy is on the prototype.
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const context = instance.context.bind(instance);
      vi.spyOn(PrSession.prototype, "context").mockImplementationOnce(async (...args) => {
        await held.wait();
        return context(...args);
      });
    });
    const limit = heldBound();
    const res = tracked(
      fetchBounded(limit.bound, postRequest("/cli/context", token, contextBody(ref, claim, "laptop"))),
    );
    await held.reached();
    // A sentinel read of the session goes through while the context is held.
    expect((await stub.view()).jobs.map((job) => job.state)).toEqual(["claimed"]);
    expect(res.settled()).toBe(false);

    limit.expire();
    expect(await refused(within(res.promise, 3000))).toEqual({
      status: 503,
      error: "unavailable",
      version: SERVER_VERSION,
    });
    expect(limit.bounds).toEqual([{ ms: ROUTE_CALL_MS, what: "the context" }]);
    await held.open();
    expect(await limit.late()).toMatchObject({ job: claim.job });
    // The agent's resend reads it again; the job is as it was.
    await contextOf(post("/cli/context", token, contextBody(ref, claim, "laptop")));
    expect(await jobRows(stub)).toEqual(rows);
  });
});
