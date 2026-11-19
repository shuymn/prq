// The PR detail in Chrome for a cloud session, against the real Worker in wrangler's local runtime through the Access
// stand-in's browser door, its model scripted (plan P3.6, P3.7, P4.1, P4.6): a pull request no webhook names, so its
// questions are the cloud agent's and need no workspace. Questions are seeded through the harness or asked from the
// composer; a held stream, and answers whose model fails after its text or before any, then succeeds on the retry.

import { type PrRef, sessionName } from "@prq/protocol";
import { afterAll, expect, test, vi } from "vitest";

import { useBrowser } from "../../test/browser.ts";
import { conversation } from "../../test/detail-page.ts";
import { latch } from "../../test/latch.ts";
import { ask, sessionView, storedMessages } from "../../test/pr.ts";
import { type Hold, SCRIPTED_MODEL, serveScripted } from "../../test/scripted.ts";
import { useStack } from "../../test/stack.ts";

// Installed before the Worker starts, which hands its model requests to it; stopped after the Worker closes.
const scripted = serveScripted();
afterAll(() => scripted.stop());
const stack = useStack({ model: SCRIPTED_MODEL });
const browser = useBrowser();

const PR: PrRef = { owner: "shuymn", repo: "prq", number: 3 };
const door = (path: string) => new URL(path, stack.access().door.url).href;
const sessionSocket = (path: string) => path.startsWith(`/agents/pr-session/${sessionName(PR)}`);

const Q1 = "What does the first change do?";
const Q2 = "And the second one?";
const Q3 = "Does it change the cache key?";

test("a held answer streams under its own question before, after its commit and across a reconnect; the next question queues with Send back on (P3.6, P3.7)", async () => {
  const worker = stack.worker();
  const hold: Hold = { after: 1, reached: latch(), release: latch() };
  scripted.play((request) =>
    JSON.stringify(request.messages).includes(Q2)
      ? { text: "The second one renames the flag." }
      : { text: ["The first change", " adds a cache."], hold },
  );
  try {
    await ask(worker, PR, "q1", Q1);
    await hold.reached.promise;

    const page = browser.page();
    await page.goto(door(`/pr/${PR.owner}/${PR.repo}/${PR.number}`));
    await vi.waitFor(async () =>
      expect(await conversation(page)).toEqual([
        { role: "question", state: "sent", text: Q1 },
        { role: "answer", state: "streaming", text: "The first change" },
      ]),
    );

    // The second question, from the composer: stored and queued behind the running answer, with Send on again.
    await page.getByRole("textbox", { name: "Question" }).fill(Q2);
    await page.getByRole("button", { name: "Send" }).click();
    await vi.waitFor(async () =>
      expect(await conversation(page)).toEqual([
        { role: "question", state: "sent", text: Q1 },
        { role: "answer", state: "streaming", text: "The first change" },
        { role: "question", state: "queued", text: Q2 },
      ]),
    );
    await page.getByText("Queued behind the running answer").waitFor();
    expect(await page.getByRole("button", { name: "Send" }).isEnabled()).toBe(true);

    // A cut connection: the reopened socket resumes the stream, still under the first question.
    expect(stack.access().door.cut(sessionSocket)).toBe(1);
    await page.getByText("Reconnecting").first().waitFor();
    await page.locator('[data-component="ConnectionBanner"]').waitFor({ state: "detached", timeout: 15_000 });
    await vi.waitFor(async () =>
      expect(await conversation(page)).toEqual([
        { role: "question", state: "sent", text: Q1 },
        { role: "answer", state: "streaming", text: "The first change" },
        { role: "question", state: "queued", text: Q2 },
      ]),
    );

    hold.release.open();
    await vi.waitFor(
      async () =>
        expect(await conversation(page)).toEqual([
          { role: "question", state: "sent", text: Q1 },
          { role: "answer", state: "complete", text: "The first change adds a cache." },
          { role: "question", state: "sent", text: Q2 },
          { role: "answer", state: "complete", text: "The second one renames the flag." },
        ]),
      { timeout: 10_000 },
    );
    const stored = await storedMessages(worker, PR);
    expect(stored.filter((message) => message.role === "user").map((message) => message.text)).toEqual([Q1, Q2]);
    expect((await sessionView(worker, PR)).jobs.map((job) => job.state)).toEqual(["done", "done"]);
  } finally {
    hold.release.open();
  }
}, 60_000);

test("an answer whose model fails after its text keeps it under its question with the reason and Retry; one press sends one POST from the shown rev and the retried run completes it; one that fails before any text shows the reason and Retry where it would be (P4.1, P4.6)", async () => {
  const worker = stack.worker();
  let failing = true;
  scripted.play((request) => {
    if (JSON.stringify(request.messages).includes(Q3)) {
      return { text: [], error: "spend limit reached" };
    }
    return failing
      ? { text: ["The first change", " adds"], error: "the stream broke off" }
      : { text: "The first change adds a cache." };
  });
  await ask(worker, PR, "q1", Q1);
  await vi.waitFor(async () =>
    expect((await sessionView(worker, PR)).jobs.map((job) => job.state)).toEqual(["failed"]),
  );

  const page = browser.page();
  const posts: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/retry")) {
      posts.push(JSON.parse(request.postData() ?? "null"));
    }
  });
  await page.goto(door(`/pr/${PR.owner}/${PR.repo}/${PR.number}`));
  await vi.waitFor(async () =>
    expect(await conversation(page)).toEqual([
      { role: "question", state: "sent", text: Q1 },
      { role: "answer", state: "incomplete", text: "The first change adds" },
    ]),
  );
  await page.getByText(/^Incomplete — .*the stream broke off/).waitFor();
  const [job] = (await sessionView(worker, PR)).jobs;

  failing = false;
  await page.locator('.conversation [data-component="Message"]').getByRole("button", { name: "Retry" }).click();
  await vi.waitFor(
    async () =>
      expect(await conversation(page)).toEqual([
        { role: "question", state: "sent", text: Q1 },
        { role: "answer", state: "incomplete", text: "The first change adds" },
        { role: "answer", state: "complete", text: "The first change adds a cache." },
      ]),
    { timeout: 10_000 },
  );
  expect(posts).toEqual([{ expectedRev: job?.rev }]);
  // One request reached the Worker, which took it (the retried run completed); the page may drop the request once the
  // view of the job's new rev comes, before or after the answer.
  expect(stack.access().door.log.filter((entry) => entry.path.endsWith(`/jobs/${job?.jobId}/retry`))).toHaveLength(1);

  await ask(worker, PR, "q3", Q3);
  await vi.waitFor(async () =>
    expect((await conversation(page)).slice(3)).toEqual([
      { role: "question", state: "sent", text: Q3 },
      { role: "answer", state: "incomplete", text: "" },
    ]),
  );
  const failed = page.locator('.conversation [data-component="Message"][data-state="incomplete"]').last();
  await failed.getByText(/^Incomplete — .*spend limit reached/).waitFor();
  expect(await failed.getByRole("button", { name: "Retry" }).count()).toBe(1);
}, 60_000);
