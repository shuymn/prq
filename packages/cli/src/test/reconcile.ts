// A manual check of head reconciliation through the Worker (reconcile-check.ts): the real Worker in wrangler's local
// runtime with the GitHub App configured, and two signed deliveries of a real pull request that tie within one second
// (the second moves the head through `before`), so the session marks itself. Then settle's reconcile step mints an
// installation token in workerd and reads the pull request from GitHub's API. The check prints the Worker's requests to
// GitHub (method, path and status only), GitHub's answer, the session's inbox, head, head_at, mark and tries, and its
// prq.head.* events, and passes when the head and head_at are GitHub's answer, read with one token.

import { setTimeout as sleep } from "node:timers/promises";

import { type PrRef, sessionName } from "@prq/protocol";
import * as v from "valibot";

import { deliver, sha } from "./pr.ts";
import { type GithubAppSettings, startWorker, type Worker } from "./worker.ts";

const API = "https://api.github.com";
const TOKEN_PATH = /^\/app\/installations\/[0-9]+\/access_tokens$/;
// The tie's second: before GitHub existed, so GitHub's answer is newer than both deliveries and is adopted.
const TIE_AT = "2008-01-01T00:00:00Z";
// Longer than two GitHub calls at their 10 s bound.
const READ_MS = 30_000;
const POLL_MS = 250;

const Pull = v.object({ head: v.object({ sha: v.string() }), updated_at: v.string() });
const SessionRow = v.object({
  head_sha: v.nullable(v.string()),
  head_at: v.nullable(v.number()),
  reconcile_at: v.nullable(v.number()),
  reconcile_tries: v.number(),
});
const InboxRow = v.object({
  at: v.number(),
  before_sha: v.nullable(v.string()),
  head_sha: v.nullable(v.string()),
  processed: v.number(),
});

export type GithubApp = { settings: GithubAppSettings; installationId: number };

type Answer = { headSha: string; updatedAt: string };

// The Worker's requests to GitHub's API, seen where the harness hands them to this process's fetch: each request's
// method, path and status, and the pull request GitHub answered. Nothing else of a request or response is kept.
function watchGithub(): { requests: string[]; tokens: () => number; answer: () => Answer | null; stop: () => void } {
  const requests: string[] = [];
  let tokens = 0;
  let answer: Answer | null = null;
  const passThrough = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== API) {
      return passThrough(input, init);
    }
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (TOKEN_PATH.test(url.pathname)) {
      tokens += 1;
    }
    let response: Response;
    try {
      response = await passThrough(input, init);
    } catch (error) {
      requests.push(`${method} ${url.pathname}: failed (${error instanceof Error ? error.name : "error"})`);
      throw error;
    }
    requests.push(`${method} ${url.pathname}: ${response.status}`);
    if (method === "GET" && response.ok && url.pathname.includes("/pulls/")) {
      const pull = v.safeParse(Pull, await response.clone().json());
      if (pull.success) {
        answer = { headSha: pull.output.head.sha, updatedAt: pull.output.updated_at };
      }
    }
    return response;
  };
  return {
    requests,
    tokens: () => tokens,
    answer: () => answer,
    stop: () => {
      globalThis.fetch = passThrough;
    },
  };
}

async function session(worker: Worker, pr: PrRef): Promise<v.InferOutput<typeof SessionRow>> {
  const [row] = await worker.sql(
    "PrSession",
    sessionName(pr),
    "SELECT head_sha, head_at, reconcile_at, reconcile_tries FROM prq_session WHERE id = 1",
  );
  return v.parse(SessionRow, row);
}

function iso(ms: number | null): string {
  return ms === null ? "none" : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function checkReconcile(app: GithubApp, pr: PrRef, print: (line: string) => void): Promise<boolean> {
  print(
    `reconcile check: App ${app.settings.GITHUB_APP_ID}, installation ${app.installationId}, ` +
      `${pr.owner}/${pr.repo}#${pr.number}, the Worker in a local runtime`,
  );
  // Installed before the Worker starts, so the Worker's own fetch wrapper passes GitHub's requests through it.
  const github = watchGithub();
  try {
    const worker = await startWorker({ githubApp: app.settings });
    try {
      const [first, second] = [sha("reconcile-check-1"), sha("reconcile-check-2")];
      const installation = app.installationId;
      await deliver(worker, pr, { action: "opened", head: first, at: TIE_AT, installation });
      await deliver(worker, pr, { action: "synchronize", before: first, head: second, at: TIE_AT, installation });
      const started = Date.now();
      const stub = await worker.durableObject("PrSession", sessionName(pr));
      await stub["settle"]?.();
      let state = await session(worker, pr);
      while (
        (state.reconcile_at !== null || !github.requests.some((request) => request.includes("/pulls/"))) &&
        state.reconcile_tries === 0 &&
        Date.now() - started < READ_MS
      ) {
        await sleep(POLL_MS);
        state = await session(worker, pr);
      }

      const inbox = v.parse(
        v.array(InboxRow),
        await worker.sql("PrSession", sessionName(pr), "SELECT at, before_sha, head_sha, processed FROM prq_inbox"),
      );
      print("deliveries taken in:");
      for (const row of inbox) {
        const move = row.before_sha === null ? `${row.head_sha}` : `${row.before_sha} -> ${row.head_sha}`;
        print(`  ${iso(row.at)} ${move}${row.processed === 1 ? "" : " (not processed)"}`);
      }
      print("the Worker's requests to GitHub:");
      for (const request of github.requests) {
        print(`  ${request}`);
      }
      const answer = github.answer();
      print(
        answer === null
          ? "GitHub's answer: none"
          : `GitHub's answer: head ${answer.headSha}, updated_at ${answer.updatedAt}`,
      );
      print(
        `session: head ${state.head_sha ?? "none"}, head_at ${iso(state.head_at)}, ` +
          `mark ${iso(state.reconcile_at)}, tries ${state.reconcile_tries}`,
      );
      print("events:");
      for (const line of worker.logs()) {
        if (/prq\.(head|config)\./.test(line)) {
          print(`  ${line.replace(/\s+/g, " ")}`);
        }
      }
      print(`token requests: ${github.tokens()}`);
      const ok =
        answer !== null &&
        state.head_sha === answer.headSha &&
        state.head_at === Date.parse(answer.updatedAt) &&
        state.reconcile_at === null &&
        state.reconcile_tries === 0 &&
        github.tokens() === 1;
      print(ok ? "as expected" : "NOT as expected");
      return ok;
    } finally {
      await worker.close();
    }
  } finally {
    github.stop();
  }
}
