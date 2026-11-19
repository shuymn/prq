// The PR detail in Chrome for a local session, against the real Worker in wrangler's local runtime through the Access
// stand-in's browser door, its jobs done by the compiled prq (plan P3.2, P3.5, P3.8–P3.10, P3.12, P3.14, P3.16,
// P4.2, P4.4, P4.7, P4.8): what the page reads and when, a question from the composer, a cut connection, the waiting
// line, versions, the panel layout, the version notice under an earlier deploy's bundle, history navigation and the
// panel's back control, Retry on a claim while the job moves, the stalled line, and the rail collapsed.

import { writeFile } from "node:fs/promises";

import { type PrRef, sessionName } from "@prq/protocol";
import type { Locator, Page } from "playwright";
import * as v from "valibot";
import { describe, expect, test, vi } from "vitest";

import { useBrowser } from "../../test/browser.ts";
import { result } from "../../test/cli.ts";
import { conversation, summary } from "../../test/detail-page.ts";
import { gateUpgrades } from "../../test/door.ts";
import { latch } from "../../test/latch.ts";
import { buildOldBundle } from "../../test/old-bundle.ts";
import { ask, push, sessionView, sha, storedMessages } from "../../test/pr.ts";
import { useStack } from "../../test/stack.ts";

const stack = useStack();
const browser = useBrowser();

// Below this width the page takes the panel's layout (design/tokens.json).
const NARROW_PX = (await import("../../../../../design/tokens.json", { with: { type: "json" } })).default.breakpoint
  .narrow.$value.value;

const PR: PrRef = { owner: "shuymn", repo: "prq", number: 1 };
const DETAIL = `/pr/${PR.owner}/${PR.repo}/${PR.number}`;
const AGENT = "laptop";
const door = (path: string) => new URL(path, stack.access().door.url).href;

// The session's WebSocket, whose upgrade carries a query, and its history reads.
const sessionSocket = (path: string) => path.startsWith(`/agents/pr-session/${sessionName(PR)}?`);
const historyReads = () =>
  stack.access().door.log.filter((entry) => entry.path === `/agents/pr-session/${sessionName(PR)}/get-messages`);

// Gates the upgrades a path matches until released, over as many retries as the tests' waits take.
const gate = (match: (path: string) => boolean) => gateUpgrades(stack.access().door, match, 8);

// The agent is present first (its wait was a contact), so the pull request's session is local.
async function present(): Promise<void> {
  expect((await stack.run(["wait", "--agent-id", AGENT, "--timeout", "0"])).code).toBe(2);
}

const Claimed = v.looseObject({ job: v.looseObject({ jobId: v.string() }), answer: v.string() });

async function claim(): Promise<v.InferOutput<typeof Claimed>> {
  const exit = await stack.run(["claim", "--agent-id", AGENT]);
  expect(exit.code).toBe(0);
  return v.parse(Claimed, result(exit));
}

async function submit(): Promise<void> {
  expect((await stack.run(["submit", "--agent-id", AGENT])).code).toBe(0);
}

// The next job, claimed, answered with this text and submitted.
async function work(text: string): Promise<void> {
  const claimed = await claim();
  await writeFile(claimed.answer, text);
  await submit();
}

const question = (page: Page) => page.getByRole("textbox", { name: "Question" });
const send = (page: Page) => page.getByRole("button", { name: "Send" });

async function sendQuestion(page: Page, text: string): Promise<void> {
  await question(page).fill(text);
  await send(page).click();
}

// Whether the element has the page's focus.
async function focused(element: Locator): Promise<boolean> {
  return (await element.and(element.page().locator(":focus")).count()) === 1;
}

// An answer of some 100 kB after its first line.
const large = (label: string) => `${label}\n\n${"A line of a long answer.\n".repeat(4000)}`;

// A head's SHA as the page shows it.
const short = (label: string) => sha(label).slice(0, 7);

// The page's horizontal overflow: how far its content reaches past the viewport.
async function overflow(page: Page): Promise<number> {
  const width: unknown = await page.evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
  return v.parse(v.number(), width);
}

describe("the session's reads", () => {
  test("a summary saved between the mount read and the first open shows once the socket opens (P3.2)", async () => {
    await present();
    await push(stack.worker(), PR, sha("h1"));
    const claimed = await claim();
    await writeFile(claimed.answer, "The summary of h1.\n");
    const upgrade = gate(sessionSocket);
    const page = browser.page();
    await page.goto(door(DETAIL));
    await upgrade.arrived.promise;
    await vi.waitFor(() => expect(historyReads()).toMatchObject([{ status: 200 }]));

    await submit();
    upgrade.release.open();
    await summary(page, "The summary of h1.").waitFor();
  });

  test("after a cut, an answer submitted before the reopen is read once: the question once, its one job, the answer (P3.5, P3.12)", async () => {
    const worker = stack.worker();
    await present();
    await push(worker, PR, sha("h1"));
    await work("The summary of h1.\n");
    const page = browser.page();
    await page.goto(door(DETAIL));
    await summary(page, "The summary of h1.").waitFor();
    await sendQuestion(page, "What changed?");
    await vi.waitFor(async () =>
      expect(await conversation(page)).toEqual([{ role: "question", state: "sent", text: "What changed?" }]),
    );
    await vi.waitFor(async () => expect(await send(page).isEnabled()).toBe(true));

    const reopen = gate(sessionSocket);
    expect(stack.access().door.cut(sessionSocket)).toBe(1);
    await page.getByText("Reconnecting… Showing the last known content.").waitFor();
    await reopen.arrived.promise;
    await work("It renames the flag.\n");
    const reads = historyReads().length;
    reopen.release.open();

    await page.locator('[data-component="ConnectionBanner"]').waitFor({ state: "detached" });
    await vi.waitFor(async () =>
      expect(await conversation(page)).toEqual([
        { role: "question", state: "sent", text: "What changed?" },
        { role: "answer", state: "complete", text: "It renames the flag." },
      ]),
    );
    expect(historyReads().slice(reads)).toMatchObject([{ status: 200 }]);
    const asked = (await storedMessages(worker, PR)).filter((message) => message.role === "user");
    expect(asked.map((message) => message.text)).toEqual(["What changed?"]);
    const jobs = (await sessionView(worker, PR)).jobs.filter((job) => job.target.kind === "answer");
    expect(jobs.map((job) => ({ target: job.target, state: job.state }))).toEqual([
      { target: { kind: "answer", messageId: asked[0]?.id }, state: "done" },
    ]);
  }, 60_000);
});

describe("a question from the composer", () => {
  test("Send sends one chat request carrying only the new question; a resend of its ID stores nothing more (P3.8)", async () => {
    const worker = stack.worker();
    await present();
    await push(worker, PR, sha("h1"));
    await work(large("The summary of h1."));

    // The answers are stored while the page is open: the session's lists give the chat client every message.
    const page = browser.page();
    const sent: string[] = [];
    page.on("websocket", (socket) => {
      const url = new URL(socket.url());
      if (sessionSocket(`${url.pathname}${url.search}`)) {
        socket.on("framesent", ({ payload }) => sent.push(String(payload)));
      }
    });
    await page.goto(door(DETAIL));
    await summary(page, "The summary of h1.").waitFor();
    for (const [id, text] of [
      ["q1", "First?"],
      ["q2", "Second?"],
    ] as const) {
      await ask(worker, PR, id, text);
      await work(large(`The answer to ${text}`));
    }
    await vi.waitFor(async () => expect(await conversation(page)).toHaveLength(4));
    await sendQuestion(page, "Third?");
    await vi.waitFor(async () => expect(await conversation(page)).toHaveLength(5));
    await vi.waitFor(async () => expect(await send(page).isEnabled()).toBe(true));

    const requests = sent
      .map((frame) => v.parse(v.looseObject({ type: v.string() }), JSON.parse(frame)))
      .filter((frame) => frame.type === "cf_agent_use_chat_request");
    expect(requests).toHaveLength(1);
    const init = v.parse(v.object({ init: v.object({ body: v.string() }) }), requests[0]).init;
    const body = v.parse(v.looseObject({ messages: v.array(v.unknown()) }), JSON.parse(init.body));
    expect(body.messages).toEqual([
      { id: expect.any(String), role: "user", parts: [{ type: "text", text: "Third?" }] },
    ]);
    const id = v.parse(v.looseObject({ id: v.string() }), body.messages[0]).id;

    // The same question under its ID again, as a resend would carry it.
    await ask(worker, PR, id, "Third?");
    const stored = (await storedMessages(worker, PR)).filter((message) => message.id === id);
    expect(stored).toEqual([{ id, role: "user", text: "Third?" }]);
    const jobs = (await sessionView(worker, PR)).jobs.filter(
      (job) => job.target.kind === "answer" && job.target.messageId === id,
    );
    expect(jobs).toHaveLength(1);
  }, 60_000);

  test("a pending question shows the waiting line with since once its agent's contact expired (P3.9)", async () => {
    const worker = stack.worker();
    await present();
    await ask(worker, PR, "q1", "What changed?");
    const page = browser.page();
    await page.goto(door(DETAIL));
    await vi.waitFor(async () =>
      expect(await conversation(page)).toEqual([{ role: "question", state: "sent", text: "What changed?" }]),
    );

    const day = 24 * 60 * 60 * 1000;
    await worker.sql("Hub", "hub", "UPDATE prq_agents SET last_seen_at = ?", Date.now() - day);
    await (await worker.durableObject("Hub", "hub"))["presenceEnded"]?.();
    const [job] = (await sessionView(worker, PR)).jobs;
    const since = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
      job?.updatedAt,
    );
    await page.getByText(`Waiting for a local agent since ${since} — continues when it returns`).waitFor();
    expect(await conversation(page)).toEqual([{ role: "question", state: "waiting-agent", text: "What changed?" }]);
  });
});

describe("versions and layouts", () => {
  // Tables wider than the panel (a long path; sixteen columns, whose cells' insets alone pass 360 px), a long unbroken
  // word, and a long code line.
  const WIDE = `The summary of h2.

| File | What changed | Why | Risk |
| --- | --- | --- | --- |
| packages/server/src/client/screens/PrDetailScreen.tsx | the session's container | the detail page | low |

| a | b | c | d | e | f | g | h | i | j | k | l | m | n | o | p |
${"| --- ".repeat(16)}|
${"| 1 ".repeat(16)}|

${"x".repeat(200)}

\`\`\`
${"const value = compute(".repeat(12)}
\`\`\`
`;

  test("the latest completed analysis shows, a pick stays through later views, answers name their SHA; the panel's menu and widths (P3.10, P3.14)", async () => {
    const worker = stack.worker();
    await present();
    await push(worker, PR, sha("h1"));
    await work("The summary of h1.\n");
    await push(worker, PR, sha("h2"));
    await work(WIDE);
    await ask(worker, PR, "q1", "What changed?");
    await work("It renames the flag.\n");

    const page = browser.page();
    await page.goto(door(DETAIL));
    await summary(page, "The summary of h2.").waitFor();
    expect(await page.locator(".conversation .answered-at").textContent()).toBe(`Answered at ${short("h2")}`);
    const context = page.locator('[data-component="Composer"] .context');
    expect(await context.count()).toBe(0);

    // A pick from the rail, with the composer naming the latest analyzed head, stays through a later view: a push.
    await page.locator('.rail [data-component="VersionItem"]', { hasText: short("h1") }).click();
    await summary(page, "The summary of h1.").waitFor();
    expect(await context.textContent()).toBe(`Questions are answered at ${short("h2")} (latest)`);
    await push(worker, PR, sha("h3"));
    await page.locator('.rail [data-component="VersionItem"]', { hasText: short("h3") }).waitFor();
    expect(await summary(page, "The summary of h1.").isVisible()).toBe(true);

    // The panel: the version menu by keyboard and by pointer, and the content within its width.
    await page.setViewportSize({ width: 360, height: 800 });
    await page.locator('.pr-detail[data-layout="panel"]').waitFor();
    const trigger = page.locator('[data-component="VersionMenu"] .trigger');
    const items = page.getByRole("menuitemradio");
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await vi.waitFor(async () => expect(await focused(items.first())).toBe(true));
    await page.keyboard.press("ArrowDown");
    expect(await focused(items.nth(1))).toBe(true);
    await page.keyboard.press("Escape");
    await items.first().waitFor({ state: "hidden" });
    expect(await focused(trigger)).toBe(true);
    await trigger.click();
    await items.filter({ hasText: short("h2") }).click();
    await summary(page, "The summary of h2.").waitFor();
    expect(await overflow(page)).toBe(0);
    // The sixteen columns scroll within the table's own box to the last one; the code wraps before the copy button.
    const contained: unknown = await page.evaluate(`(() => {
      const table = [...document.querySelectorAll('[data-component="Summary"] .table')].at(-1);
      table.scrollLeft = table.scrollWidth;
      const box = table.getBoundingClientRect();
      const last = table.querySelector("th:last-child").getBoundingClientRect();
      const pre = document.querySelector('[data-component="Summary"] [data-component="CodeBlock"] pre');
      const copy = pre.parentElement.querySelector(".copy").getBoundingClientRect();
      return {
        tableScrolls: table.scrollWidth > table.clientWidth,
        lastColumnShown: last.left >= box.left && last.right <= box.right + 1,
        codeWraps: pre.scrollWidth <= pre.clientWidth,
        codeBeforeCopy: pre.getBoundingClientRect().right <= copy.left,
      };
    })()`);
    expect(contained).toEqual({ tableScrolls: true, lastColumnShown: true, codeWraps: true, codeBeforeCopy: true });

    // Either side of the breakpoint: the table and the rail within the page.
    for (const width of [NARROW_PX - 1, NARROW_PX]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator(`.pr-detail[data-layout="${width < NARROW_PX ? "panel" : "page"}"]`).waitFor();
      expect({ width, overflow: await overflow(page) }).toEqual({ width, overflow: 0 });
    }
  }, 60_000);

  test("under an earlier deploy's bundle, with the Hub's upgrade gated, the notice shows above the PrHeader (P3.14)", async ({
    signal,
  }) => {
    const bundle = await buildOldBundle({ signal });
    try {
      await push(stack.worker(), PR, sha("h1"));
      stack.access().door.serve(bundle.dir);
      const hub = gate((path) => path.startsWith("/agents/hub/"));
      const page = browser.page();
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto(door(DETAIL));
      await hub.arrived.promise;
      const notice = page.locator('[data-component="Notice"]', { hasText: "A new version is available" });
      await notice.waitFor();
      const header = page.locator('[data-component="PrHeader"]');
      const [above, below] = await Promise.all([notice.boundingBox(), header.boundingBox()]);
      expect((above?.y ?? 0) + (above?.height ?? 0)).toBeLessThanOrEqual(below?.y ?? 0);
      hub.release.open();
    } finally {
      await bundle.close();
    }
  });
});

describe("history navigation", () => {
  test("Back and Forward restore the list and the detail with their headings focused; the panel's back control goes back to the list before it, else opens the list; a mixed-case URL opens the canonical session (P3.16)", async () => {
    await push(stack.worker(), PR, sha("h1"), sha("base"), { title: "Rename the flag" });
    const page = browser.page();
    // The panel's width, where the PrHeader starts with the back control.
    await page.setViewportSize({ width: 360, height: 800 });
    const focusedText = async () =>
      v.parse(v.string(), await page.evaluate(`document.activeElement?.textContent ?? ""`));
    const index = async () => v.parse(v.number(), await page.evaluate(`navigation.currentEntry.index`));
    const row = page.locator(`a.title[href="${DETAIL}"]`);
    const heading = page.getByRole("heading", { level: 1, name: "Rename the flag" });
    const back = page.getByRole("button", { name: "Back to pull requests" });
    await page.goto(door("/"));
    const list = await index();
    await row.click();
    await heading.waitFor();
    await vi.waitFor(async () => expect(await focusedText()).toBe("Rename the flag"));

    await page.goBack();
    await row.waitFor();
    await vi.waitFor(async () => expect(await focusedText()).toBe("Pull requests"));
    await page.goForward();
    await heading.waitFor();
    await vi.waitFor(async () => expect(await focusedText()).toBe("Rename the flag"));

    // The list is the previous entry: the back control goes back to it.
    await back.click();
    await row.waitFor();
    expect(await index()).toBe(list);
    await page.goForward();
    await heading.waitFor();

    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(new URL(socket.url()).pathname));
    await page.goto(door(`/pr/Shuymn/PRQ/1`));
    await heading.waitFor();
    expect(sockets.filter((path) => path.startsWith("/agents/pr-session/"))).toEqual([
      `/agents/pr-session/${sessionName(PR)}`,
    ]);

    // A detail is the previous entry: the back control opens the list as a new entry.
    await back.click();
    await row.waitFor();
    expect(await index()).toBe(list + 3);
  });
});

// The door's log of a job's retries.
const retries = (jobId: string) =>
  stack
    .access()
    .door.log.filter((entry) => entry.path === `/api/pr/${PR.owner}/${PR.repo}/${PR.number}/jobs/${jobId}/retry`);

describe("jobs and Retry", () => {
  test("a local claim offers Retry before the stall mark; a retry held at the door while prq resumes the claim ends when the page shows the new rev, sends nothing again, and Retry comes back from that rev; one held while prq submits ends the same way, and the answer shows (P4.2, P4.4)", async () => {
    const worker = stack.worker();
    await present();
    await ask(worker, PR, "q1", "What changed?");
    await claim();
    const page = browser.page();
    const posts: unknown[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/retry")) {
        posts.push(request.postDataJSON());
      }
    });
    await page.goto(door(DETAIL));
    const retry = page
      .locator('.rail [data-component="JobRow"][data-state="running"]')
      .getByRole("button", { name: "Retry" });
    await retry.waitFor();
    const [before] = (await sessionView(worker, PR)).jobs;
    const jobId = before?.jobId ?? "";
    const gated = (path: string) => path.endsWith(`/jobs/${jobId}/retry`);

    const first = { arrived: latch(), release: latch() };
    stack.access().door.plan(gated, { kind: "gate", ...first });
    await retry.click();
    await first.arrived.promise;
    const resumed = await claim();
    const [moved] = (await sessionView(worker, PR)).jobs;
    expect(moved).toMatchObject({ state: "claimed", rev: (before?.rev ?? 0) + 1 });
    // The view of the new rev ends the retry: the page drops its request before the door forwards it.
    await vi.waitFor(() => expect(retries(jobId)).toMatchObject([{ status: null, cancelled: true }]));
    first.release.open();
    await retry.and(page.locator('[data-state="rest"]')).waitFor();
    expect(await page.getByText("Couldn't retry. Try again.").count()).toBe(0);

    const second = { arrived: latch(), release: latch() };
    stack.access().door.plan(gated, { kind: "gate", ...second });
    await retry.click();
    await second.arrived.promise;
    await writeFile(resumed.answer, "It renames the flag.\n");
    await submit();
    await vi.waitFor(() =>
      expect(retries(jobId)).toMatchObject([
        { status: null, cancelled: true },
        { status: null, cancelled: true },
      ]),
    );
    second.release.open();
    await vi.waitFor(async () =>
      expect(await conversation(page)).toEqual([
        { role: "question", state: "sent", text: "What changed?" },
        { role: "answer", state: "complete", text: "It renames the flag." },
      ]),
    );
    await page.getByText("1 done").waitFor();
    expect(await page.getByRole("button", { name: "Retry" }).count()).toBe(0);
    expect(posts).toEqual([{ expectedRev: before?.rev }, { expectedRev: moved?.rev }]);
  }, 60_000);

  test("a claim past the stall deadline shows the stalled line with its agent and elapsed time, and the collapsed rail's toggle its danger dot; the rail stays collapsed across a reload, where the summary's version menu picks a version (P4.7, P4.8)", async () => {
    const worker = stack.worker();
    await present();
    await push(worker, PR, sha("h1"));
    await work("The summary of h1.\n");
    await push(worker, PR, sha("h2"));
    await work("The summary of h2.\n");
    await push(worker, PR, sha("h3"));
    await claim();
    const page = browser.page();
    await page.goto(door(DETAIL));
    await summary(page, "The summary of h2.").waitFor();
    const toggle = page.getByRole("button", { name: "Jobs and versions" });
    await toggle.click();
    // Collapsed, and once a job needs attention, the toggle's description says so.
    const attention = page
      .getByRole("button", { name: "Jobs and versions", expanded: false })
      .and(page.locator('[aria-description="A job needs attention"]'));
    await page.getByRole("button", { name: "Jobs and versions", expanded: false }).waitFor();
    expect(await attention.count()).toBe(0);

    const name = sessionName(PR);
    await worker.sql(
      "PrSession",
      name,
      "UPDATE prq_jobs SET claimed_at = ? WHERE state = 'claimed'",
      Date.now() - 64 * 60_000,
    );
    await (await worker.durableObject("PrSession", name))["settle"]?.();
    const stalled = page.locator('[data-component="Summary"] .progress[data-tone="attention"]');
    await stalled.waitFor();
    expect(await stalled.textContent()).toBe(
      `Summary of ${short("h3")} possibly stalled: no result from ${AGENT} after 1 hrRetry`,
    );
    await attention.waitFor();
    expect(await page.locator(".rail-toggle .alert").isVisible()).toBe(true);

    await page.reload();
    await summary(page, "The summary of h2.").waitFor();
    await attention.waitFor();
    expect(await page.getByRole("heading", { name: "Versions" }).count()).toBe(0);
    await page.locator('[data-component="VersionMenu"] .trigger').click();
    await page
      .getByRole("menuitemradio")
      .filter({ hasText: short("h1") })
      .click();
    await summary(page, "The summary of h1.").waitFor();
  }, 60_000);
});
