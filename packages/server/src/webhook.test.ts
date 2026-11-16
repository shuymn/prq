import { ErrorResponse, type PrRef, sessionName } from "@prq/protocol";
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import app from "./index.ts";
import { prSessionStub } from "./names.ts";
import { captureLogs, type LogEntry } from "./test/access.ts";
import { fetchBounded, heldBound } from "./test/cli.ts";
import { gate, jobRows, laterWakes, prSessionSeams, setPool, tracked, wakes, within } from "./test/session.ts";
import {
  BASE,
  deliver,
  deliveryRequest,
  HOST_ID,
  inbox,
  OTHER_ID,
  pullRequestEvent,
  push,
  send,
  sha,
  signature,
  takeIn,
} from "./test/webhook.ts";
import { WEBHOOK_CALL_MS } from "./webhook.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

let counter = 0;

// A pull request no other test of the file uses.
function newPr(): PrRef {
  counter += 1;
  return { owner: "Octo", repo: "Hooks", number: counter };
}

// The test bindings without one.
function without(name: string): object {
  const rest: Record<string, unknown> = { ...env };
  delete rest[name];
  return rest;
}

async function sessionCount(): Promise<number> {
  return (await listDurableObjectIds(env.PrSession)).length;
}

async function view(pr: PrRef) {
  return (await prSessionStub(env, pr)).view();
}

async function outcome(response: Promise<Response> | Response) {
  const res = await response;
  const body: unknown = await res.json();
  return { status: res.status, body, cacheControl: res.headers.get("Cache-Control") };
}

async function refused(response: Promise<Response>) {
  const res = await response;
  return { status: res.status, error: v.parse(ErrorResponse, await res.json()).error };
}

function events(logs: LogEntry[], event: string): Record<string, unknown>[] {
  return logs.map((log) => log.entry).filter((entry) => entry["event"] === event);
}

const IGNORED = { status: 200, body: { status: "ignored" }, cacheControl: "no-store" };
const RECEIVED = { status: 200, body: { status: "received" }, cacheControl: "no-store" };

// The HMAC-SHA1 a `sha1=` header carries.
async function sha1Signature(body: string): Promise<string> {
  const secret = new TextEncoder().encode(env.WEBHOOK_SECRET);
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha1=${[...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("signature", () => {
  it("takes GitHub's documented example", async () => {
    // GitHub's "Validating webhook deliveries": this secret (vitest.config.ts), this body and this signature.
    expect(env.WEBHOOK_SECRET).toBe("It's a Secret to Everybody");
    const res = deliver({
      body: "Hello, World!",
      event: "ping",
      signature: "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    });
    expect(await outcome(res)).toEqual(IGNORED);
  });

  // A delivery for a pull request of the host's, which would be taken in were it signed: its body, then the body sent
  // and the signature header (null: none).
  const variants: Record<string, (body: string) => Promise<[string, string | null]>> = {
    "a wrong signature": async (body) => [body, (await signature(body)).replace(/.$/, (c) => (c === "0" ? "1" : "0"))],
    "another secret's signature": async (body) => [body, await signature(body, "another secret")],
    "a sha1= signature": async (body) => [body, await sha1Signature(body)],
    "a digest without sha256=": async (body) => [body, (await signature(body)).slice("sha256=".length)],
    "a body one byte off": async (body) => [body.replace('"A change"', '"A chance"'), await signature(body)],
    "no signature": async (body) => [body, null],
    "an empty body": async () => ["", await signature("x")],
  };

  it.for(Object.entries(variants))("refuses %s with 401 and creates no PrSession", async ([, variant]) => {
    const logs = captureLogs();
    const before = await sessionCount();
    const [body, signed] = await variant(JSON.stringify(pullRequestEvent(newPr())));

    const res = deliver({ body, signature: signed });

    expect(await outcome(res)).toEqual({
      status: 401,
      body: { error: "unauthorized", detail: "invalid signature" },
      cacheControl: "no-store",
    });
    expect(await sessionCount()).toBe(before);
    expect(events(logs, "prq.webhook.rejected")).toEqual([{ event: "prq.webhook.rejected", reason: "signature" }]);
  });

  it("takes in the same delivery signed with the secret", async () => {
    captureLogs();
    const pr = newPr();
    const before = await sessionCount();
    expect(await outcome(deliver({ body: JSON.stringify(pullRequestEvent(pr)) }))).toEqual(RECEIVED);
    expect(await sessionCount()).toBe(before + 1);
    await takeIn(pr);
    expect((await view(pr)).jobs).toMatchObject([{ target: { kind: "analysis", headSha: sha("head") } }]);
  });
});

describe("author, not sender", () => {
  it("ignores a pull request someone else authored, though the host sent the event", async () => {
    const logs = captureLogs();
    const before = await sessionCount();
    const body = JSON.stringify(pullRequestEvent(newPr(), { author: OTHER_ID, sender: HOST_ID }));

    expect(await outcome(deliver({ body }))).toEqual(IGNORED);
    expect(await sessionCount()).toBe(before);
    expect(events(logs, "prq.webhook.ignored")).toEqual([
      { event: "prq.webhook.ignored", action: "synchronize", reason: "author" },
    ]);
  });

  it("takes in the host's pull request when someone else sent the event", async () => {
    captureLogs();
    const pr = newPr();
    const body = JSON.stringify(pullRequestEvent(pr, { author: HOST_ID, sender: OTHER_ID }));

    expect(await outcome(deliver({ body }))).toEqual(RECEIVED);
    await takeIn(pr);
    expect((await view(pr)).jobs).toMatchObject([{ state: expect.any(String), target: { headSha: sha("head") } }]);
  });
});

describe("deliveries that reach no session", () => {
  it("ignores another event, and another action, with 200", async () => {
    const logs = captureLogs();
    const before = await sessionCount();
    const body = JSON.stringify(pullRequestEvent(newPr()));

    expect(await outcome(deliver({ body, event: "issues" }))).toEqual(IGNORED);
    const labeled = JSON.stringify(pullRequestEvent(newPr(), { action: "labeled" }));
    expect(await outcome(deliver({ body: labeled }))).toEqual(IGNORED);

    expect(await sessionCount()).toBe(before);
    expect(events(logs, "prq.webhook.ignored").map((entry) => entry["reason"])).toEqual(["event", "action"]);
  });

  it("refuses a signed body that is not a pull_request payload with 400", async () => {
    captureLogs();
    const before = await sessionCount();
    const event = pullRequestEvent(newPr());

    expect(await refused(deliver({ body: "not json" }))).toEqual({ status: 400, error: "bad_request" });
    const noHead = { ...event, pull_request: { ...event.pull_request, head: { sha: "main" } } };
    expect(await refused(deliver({ body: JSON.stringify(noHead) }))).toEqual({ status: 400, error: "bad_request" });
    const noTime = { ...event, pull_request: { ...event.pull_request, updated_at: "yesterday" } };
    expect(await refused(deliver({ body: JSON.stringify(noTime) }))).toEqual({ status: 400, error: "bad_request" });
    const noId = deliver({ body: JSON.stringify(event), deliveryId: null });
    expect(await refused(noId)).toEqual({ status: 400, error: "bad_request" });

    expect(await sessionCount()).toBe(before);
  });

  it("refuses every delivery with 500 while the webhook's secrets are not configured, and Access routes still work", async () => {
    const logs = captureLogs();
    const before = await sessionCount();
    const body = JSON.stringify(pullRequestEvent(newPr()));
    const noSecret = await app.fetch(await deliveryRequest({ body }), without("WEBHOOK_SECRET"));
    expect(await refused(Promise.resolve(noSecret))).toEqual({ status: 500, error: "internal" });
    const badId = await app.fetch(await deliveryRequest({ body }), { ...env, HOST_GITHUB_ID: "octocat" });
    expect(await refused(Promise.resolve(badId))).toEqual({ status: 500, error: "internal" });

    expect(await sessionCount()).toBe(before);
    expect(events(logs, "prq.config.invalid").map((entry) => entry["issues"])).toEqual([
      ["WEBHOOK_SECRET is missing"],
      ["HOST_GITHUB_ID is not a numeric GitHub user ID"],
    ]);
    // The Access check needs neither: a protected path without a token is still a 401.
    const res = await app.fetch(
      new Request("https://prq.example/cli/claim", { method: "POST" }),
      without("WEBHOOK_SECRET"),
    );
    expect(res.status).toBe(401);
  });
});

describe("edited and closed", () => {
  it("updates the title and the state, keeps the head where the pushes put it, and makes no job", async () => {
    captureLogs();
    await setPool([]);
    const pr = newPr();
    await push(pr, "A");
    await push(pr, "B");
    const jobs = (await view(pr)).jobs;

    // A late edit carries an older head; only a push moves it.
    await send(pr, { action: "edited", head: sha("A"), title: "A better title" });
    expect((await view(pr)).details).toEqual({
      fullName: "Octo/Hooks",
      title: "A better title",
      state: "open",
      url: `https://github.com/Octo/Hooks/pull/${pr.number}`,
      headSha: sha("B"),
      baseSha: BASE,
    });
    await send(pr, { action: "closed", head: sha("B"), state: "closed", merged: false });
    expect((await view(pr)).details?.state).toBe("closed");
    await send(pr, { action: "reopened", head: sha("B") });
    expect((await view(pr)).details?.state).toBe("open");
    await send(pr, { action: "closed", head: sha("B"), state: "closed", merged: true });
    expect((await view(pr)).details?.state).toBe("merged");

    expect((await view(pr)).jobs).toEqual(jobs);
  });

  it("takes the details of a first event that is an edit, with its head, and decides no owner", async () => {
    captureLogs();
    const pr = newPr();
    await send(pr, { action: "edited", head: sha("A"), title: "Edited first" });
    expect(await view(pr)).toMatchObject({
      details: { title: "Edited first", headSha: sha("A") },
      owner: null,
      jobs: [],
    });
  });
});

describe("logs", () => {
  it("logs prq.webhook.received with the session, the action and the head, and never the body", async () => {
    const logs = captureLogs();
    await setPool([]);
    const pr = newPr();
    const title = "a title only the body holds";

    await send(pr, { action: "opened", head: sha("A"), title });
    await deliver({ body: JSON.stringify(pullRequestEvent(pr, { title })), signature: null });

    expect(events(logs, "prq.webhook.received")).toEqual([
      { event: "prq.webhook.received", pr: sessionName(pr), action: "opened", headSha: sha("A") },
    ]);
    expect(JSON.stringify(logs)).not.toContain(title);
    expect(JSON.stringify(logs)).not.toContain(env.WEBHOOK_SECRET);
  });
});

describe("inbox", () => {
  it("answers once the delivery is stored, and takes it in later", async () => {
    captureLogs();
    await setPool([]);
    const pr = newPr();

    expect(await outcome(deliver({ body: JSON.stringify(pullRequestEvent(pr, { head: sha("A") })) }))).toEqual(
      RECEIVED,
    );

    // Stored, with a wake armed to take it in; nothing taken in yet.
    expect(await inbox(pr)).toMatchObject([{ action: "synchronize", head_sha: sha("A"), processed: 0 }]);
    expect(await wakes(await prSessionStub(env, pr))).toBeGreaterThan(0);
    expect(await view(pr)).toMatchObject({ details: null, owner: null, jobs: [] });

    await takeIn(pr);
    expect(await inbox(pr)).toMatchObject([{ processed: 1 }]);
    expect(await view(pr)).toMatchObject({ details: { headSha: sha("A") }, jobs: [{ target: { headSha: sha("A") } }] });
  });

  it("keeps a delivery whose taking in fails, arms a retry, and takes it in on the next settle", async () => {
    const logs = captureLogs();
    await setPool(["laptop"]);
    const pr = newPr();
    const stub = await prSessionStub(env, pr);
    await runInDurableObject(stub, (instance) => {
      vi.spyOn(prSessionSeams(instance), "readPool").mockRejectedValueOnce(new Error("the Hub is away"));
    });
    await deliver({ body: JSON.stringify(pullRequestEvent(pr, { head: sha("A") })) });

    await takeIn(pr);
    expect(await inbox(pr)).toMatchObject([{ processed: 0 }]);
    expect(await laterWakes(stub)).toBeGreaterThan(0);
    expect(events(logs, "prq.settle.failed")).toMatchObject([{ step: "inbox", error: "Error" }]);
    expect((await view(pr)).jobs).toEqual([]);

    await takeIn(pr);
    expect(await inbox(pr)).toMatchObject([{ processed: 1 }]);
    expect((await view(pr)).jobs).toMatchObject([{ state: "pending", target: { headSha: sha("A") } }]);
  });

  it("answers a delivery whose ID it has as a duplicate and takes it in once", async () => {
    const logs = captureLogs();
    await setPool([]);
    const pr = newPr();
    const deliveryId = crypto.randomUUID();
    const body = JSON.stringify(pullRequestEvent(pr, { head: sha("A") }));
    const duplicate = { status: 200, body: { status: "duplicate" }, cacheControl: "no-store" };

    expect(await outcome(deliver({ body, deliveryId }))).toEqual(RECEIVED);
    expect(await outcome(deliver({ body, deliveryId }))).toEqual(duplicate);
    await takeIn(pr);
    const after = await jobRows(await prSessionStub(env, pr));
    expect(await outcome(deliver({ body, deliveryId }))).toEqual(duplicate);
    await takeIn(pr);

    expect(await inbox(pr)).toHaveLength(1);
    expect(events(logs, "prq.inbox.taken")).toHaveLength(1);
    expect(await jobRows(await prSessionStub(env, pr))).toEqual(after);
  });

  it("answers 503 when the session does not store the delivery in time; the delivery stored before is taken in once", async () => {
    captureLogs();
    await setPool(["laptop"]);
    const pr = newPr();
    const stub = await prSessionStub(env, pr);
    // The session is held after storing the delivery, while it arms the wake.
    const held = await gate(stub);
    await runInDurableObject(stub, (instance) => {
      const schedule = instance.schedule.bind(instance);
      vi.spyOn(instance, "schedule").mockImplementationOnce(async (...args) => {
        await held.wait();
        return schedule(...args);
      });
    });
    const deliveryId = crypto.randomUUID();
    const body = JSON.stringify(pullRequestEvent(pr, { head: sha("A") }));
    const limit = heldBound();
    const res = tracked(fetchBounded(limit.bound, await deliveryRequest({ body, deliveryId })));
    await held.reached();
    // A sentinel read of the session goes through while the call is held: the delivery is stored.
    expect(await inbox(pr)).toMatchObject([{ processed: 0 }]);
    expect(res.settled()).toBe(false);

    limit.expire();
    expect(await refused(within(res.promise, 3000))).toEqual({ status: 503, error: "unavailable" });
    expect(limit.bounds).toEqual([{ ms: WEBHOOK_CALL_MS, what: "the session's inbox" }]);
    // The owner's redelivery from GitHub carries the same ID; the stored delivery is taken in, then the held call ends.
    expect(await outcome(deliver({ body, deliveryId }))).toMatchObject({ status: 200, body: { status: "duplicate" } });
    await takeIn(pr);
    await held.open();
    expect(await limit.late()).toBe("received");
    await takeIn(pr);

    expect((await jobRows(stub)).filter((row) => row.kind === "analysis")).toMatchObject([
      { target: sha("A"), state: "pending", run: 1 },
    ]);
    expect(await inbox(pr)).toMatchObject([{ processed: 1 }]);
  });
});
