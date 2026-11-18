import {
  AGENT_PAGE_BYTES,
  AGENT_PAGE_ROWS,
  type AgentPage,
  type AgentRow,
  type ClaimResponse,
  type ErrorResponse,
  type HubView,
  type Instructions,
  LEDGER_PAGE_BYTES,
  LEDGER_PAGE_ROWS,
  type LedgerPage,
  type LedgerQuery,
  type LedgerRow,
  MAX_AGENT_ID_CHARS,
  MAX_FULL_NAME_CHARS,
  MAX_LEDGER_CURSOR_CHARS,
  MAX_ROW_CLAIMS,
  parseSessionName,
  type PrRef,
  type Prompt,
  PromptKind,
  REPO_PAGE_BYTES,
  REPO_PAGE_ROWS,
  type RepoPage,
  SavePromptRequest,
  WaitRequest,
  waitBoundMs,
  type WaitResponse,
} from "@prq/protocol";
import { Agent, type Connection } from "agents";
import * as v from "valibot";

import { refuseSubAgent, sendServerVersion } from "./agents.ts";
import { readPrompts, writePrompt } from "./instructions/prompts.ts";
import {
  claimReleasedAt,
  LedgerEntry,
  needsAttention,
  PRESENCE_MS,
  type Presence,
  presenceEnd,
  problemOf,
  STALL_MS,
} from "./ledger.ts";
import { errorName, log } from "./log.ts";
import { prSessionStub } from "./names.ts";
import { jsonBytes } from "./pr-session/context.ts";
import type { PrSession } from "./pr-session/index.ts";
import type { Peek } from "./pr-session/jobs.ts";
import { HUB_SCHEMA, migrate } from "./schema.ts";
import { SerialQueue, withTimeout } from "./wait.ts";

// How long a call to a PrSession may take, the session's start included.
const SESSION_CALL_MS = 10_000;

type Notification = { session: string; gen: number };

// A stored ledger row as a page reads it.
type StoredRow = { session: string; sort_at: number; entry: string };

// A place in the list's order: a row's sort_at (its latest event's time, -1 without one) and its session.
type LedgerCursor = { at: number; session: string };

// The ledger's filters as a query applies them: the list (open rows only or all, of one repository (canonical
// owner/name) or of every one), or the rows that need attention with a local agent present or without one (the column
// that says so).
export type LedgerFilter =
  | { open: boolean; repo: string | null }
  | { attention: "attention_present" | "attention_absent" };

type Page<R> = { rows: R[]; nextCursor: string | null };

const BAD_LEDGER_CURSOR: ErrorResponse = { error: "bad_request", detail: "the cursor names no place in the ledger" };

// The one Hub (HUB_NAME): the pool of local agents, the queue of sessions that may have work for them, and the ledger
// of every session's row. It holds no job state: it asks each PrSession (peek, claim), each PrSession asks it about
// presence, and each sends it its ledger entry. Its view (HubView) is its Agent state.
export class Hub extends Agent<Env, HubView> {
  readonly #sql: SqlStorage;
  // The waits in flight, each with its agent ID and the wake-up a notify gives it. In memory only: a wait ends with its
  // request.
  readonly #waiters = new Set<{ agentId: string; wake(): void }>();
  // Arming presenceEnded: a check for an earlier row, then a schedule, one pool change at a time.
  readonly #presenceAlarm = new SerialQueue("the presence alarm");

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    migrate(ctx.storage, HUB_SCHEMA);
  }

  // Presence may have ended, or lost its alarm, while the Hub was not running: the view and presenceEnded are set again.
  // A failure is logged; the next contact sets both.
  override async onStart(): Promise<void> {
    try {
      await this.#poolChanged();
    } catch (error) {
      log("prq.hub.reconcile_failed", { error: errorName(error) }, "error");
    }
  }

  override onConnect(connection: Connection): void {
    sendServerVersion(connection);
  }

  override async onBeforeSubAgent(): Promise<Response> {
    return refuseSubAgent();
  }

  // The view is the server's: a client's state update is refused (the SDK answers it with cf_agent_state_error).
  override validateStateChange(_next: HubView, source: Connection | "server"): void {
    if (source !== "server") {
      log("prq.state.refused", {}, "warn");
      throw new Error("the Hub view is set by the server only");
    }
  }

  // --- The pool ---

  // A contact from a local agent: a wait (at its start and end), a claim, a submit or a context.
  async touch(agentId: string): Promise<void> {
    this.#contact(agentId, this.clock());
    await this.#poolChanged();
  }

  // Sets an agent's last contact, unless a later one is stored.
  #contact(agentId: string, at: number): void {
    this.#sql.exec(
      `INSERT INTO prq_agents (agent_id, last_seen_at) VALUES (?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET last_seen_at = max(last_seen_at, excluded.last_seen_at)`,
      agentId,
      at,
    );
  }

  // Whether any local agent is present (docs/design.md, Presence): one in a wait, one whose last contact is less than
  // PRESENCE_MS ago, or one holding a claim made less than STALL_MS + PRESENCE_MS ago.
  isLocalPresent(): boolean {
    return this.#localPresent(this.clock());
  }

  #localPresent(now: number): boolean {
    return this.#presentAgents(now).size > 0;
  }

  // Each agent ID present at now, on the Hub's clock: one with a contact or a claim recent enough to make it present
  // (isPresent), each read as a range of the index on its time (schema.ts), or one in a wait. No contact or claim older
  // than that is read, however many agents and claims came before.
  #presentAgents(now: number): Set<string> {
    const recent = this.#sql.exec<{ agent_id: string }>(
      "SELECT agent_id FROM prq_agents WHERE last_seen_at > ?",
      now - PRESENCE_MS,
    );
    const holding = this.#sql.exec<{ agent_id: string }>(
      "SELECT agent_id FROM prq_claims WHERE claimed_at > ?",
      now - STALL_MS - PRESENCE_MS,
    );
    return new Set([
      ...[...recent, ...holding].map((row) => row.agent_id),
      ...[...this.#waiters].map((waiter) => waiter.agentId),
    ]);
  }

  // Each present agent ID with what its presence rests on.
  #presences(now: number): Map<string, Presence> {
    return new Map([...this.#presentAgents(now)].map((agentId) => [agentId, this.#presenceOf(agentId)]));
  }

  // What an agent ID's presence rests on: whether it is in a wait, its last contact, and its latest claim, read as one
  // row of the index on the agent's claims by time (schema.ts), however many claims it holds.
  #presenceOf(agentId: string): Presence {
    return {
      waiting: [...this.#waiters].some((waiter) => waiter.agentId === agentId),
      lastSeenAt:
        this.#sql
          .exec<{ at: number }>("SELECT last_seen_at AS at FROM prq_agents WHERE agent_id = ?", agentId)
          .toArray()[0]?.at ?? null,
      latestClaimAt:
        this.#sql
          .exec<{ at: number }>(
            "SELECT claimed_at AS at FROM prq_claims WHERE agent_id = ? ORDER BY claimed_at DESC LIMIT 1",
            agentId,
          )
          .toArray()[0]?.at ?? null,
    };
  }

  // After any change to the pool or the ledger, and at the Hub's start: presenceEnded at the next time an agent's
  // presence ends unless a row is due by then (which also restores one lost earlier), then the view, set only when it
  // changed. In that order, the view shows no presence that nothing is armed to end. A failure of either fails the call
  // that made the change, so the change is not acknowledged and is made again: a contact's route answers 503 and the
  // agent retries, a ledger delivery is redelivered, and the scheduler runs presenceEnded again.
  async #poolChanged(): Promise<void> {
    await this.#presenceAlarm.run(() => this.#armPresenceEnded());
    const view = this.view();
    if (JSON.stringify(view) !== JSON.stringify(this.state)) {
      this.setState(view);
    }
  }

  // presenceEnded at the first whole second at or after the earliest time a present agent's presence ends, unless a
  // row for a later second than this one is due by then (a row due now may be the one running, which is ending).
  async #armPresenceEnded(): Promise<void> {
    const now = this.clock();
    const ends = [...this.#presences(now).values()].map(presenceEnd).filter((end) => end < Infinity);
    if (ends.length === 0) {
      return;
    }
    const due = Math.ceil(Math.min(...ends) / 1000) * 1000;
    const armed = await this.listSchedules({ timeRange: { start: new Date(now + 1000), end: new Date(due) } });
    if (!armed.some((schedule) => schedule.callback === "presenceEnded")) {
      await this.schedule(new Date(due), "presenceEnded", undefined, { idempotent: false });
    }
  }

  // Run when an agent's presence may have ended: the view follows, so "Waiting for a local agent" appears without any
  // other event, and the next end is armed.
  async presenceEnded(): Promise<void> {
    await this.#poolChanged();
  }

  // --- The ledger ---

  // A session's entry at its revision (its outbox generation, which only grows). The Hub keeps an entry only when it is
  // newer than the stored one, decided in the statement that stores it, so an older delivery that lands late changes
  // nothing; a stale one is logged, one at the stored revision is a redelivery. The entry's claims replace the
  // session's: each is placed on the Hub's clock by its age, and an agent whose claim is no longer listed (a submit or
  // a retry ended it) counts as seen when the claim stopped applying, so its presence ends PRESENCE_MS after that.
  async upsertLedger(session: string, rev: number, entry: LedgerEntry): Promise<void> {
    const pr = parseSessionName(session);
    if (pr === null || !v.is(LedgerEntry, entry)) {
      log("prq.hub.ledger_refused", {}, "warn");
      return;
    }
    const now = this.clock();
    // What the list's order, its filters and the totals read of the row. Whether it needs attention is kept for a local
    // agent present and for none: the counts follow each stored entry, so neither the view nor a filter parses a row.
    const row = {
      sortAt: entry.latestEvent?.at ?? -1,
      repo: repoKey(pr),
      open: Number(entry.details === null || entry.details.state === "open"),
      present: Number(needsAttention(problemOf(entry, true))),
      absent: Number(needsAttention(problemOf(entry, false))),
      ...entry.jobs,
    };
    const stored = this.ctx.storage.transactionSync(() => {
      const before = this.#sql
        .exec<{ present: number; absent: number; waiting: number; running: number; failed: number }>(
          `SELECT attention_present AS present, attention_absent AS absent, jobs_waiting AS waiting,
             jobs_running AS running, jobs_failed AS failed FROM prq_ledger WHERE session = ?`,
          session,
        )
        .toArray()[0] ?? { present: 0, absent: 0, waiting: 0, running: 0, failed: 0 };
      const applied = this.#sql
        .exec(
          `INSERT INTO prq_ledger (session, rev, entry, sort_at, repo, open, attention_present, attention_absent,
             jobs_waiting, jobs_running, jobs_failed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (session) DO UPDATE SET rev = excluded.rev, entry = excluded.entry, sort_at = excluded.sort_at,
             open = excluded.open, attention_present = excluded.attention_present,
             attention_absent = excluded.attention_absent, jobs_waiting = excluded.jobs_waiting,
             jobs_running = excluded.jobs_running, jobs_failed = excluded.jobs_failed
           WHERE excluded.rev > prq_ledger.rev RETURNING rev`,
          session,
          rev,
          JSON.stringify(entry),
          row.sortAt,
          row.repo,
          row.open,
          row.present,
          row.absent,
          row.waiting,
          row.running,
          row.failed,
        )
        .toArray();
      if (applied.length === 0) {
        return this.#sql.exec<{ rev: number }>("SELECT rev FROM prq_ledger WHERE session = ?", session).one().rev;
      }
      this.#sql.exec(
        `UPDATE prq_ledger_totals SET version = version + 1, attention_present = attention_present + ?,
           attention_absent = attention_absent + ?, jobs_waiting = jobs_waiting + ?, jobs_running = jobs_running + ?,
           jobs_failed = jobs_failed + ? WHERE id = 1`,
        row.present - before.present,
        row.absent - before.absent,
        row.waiting - before.waiting,
        row.running - before.running,
        row.failed - before.failed,
      );
      this.#storeRepo(pr, entry);
      this.#replaceClaims(session, entry, now);
      return null;
    });
    if (stored !== null && rev < stored) {
      log("prq.ledger.stale_rev", { pr: session, rev, stored }, "warn");
    }
    await this.#poolChanged();
  }

  // The row's repository, and its name in GitHub's display case once an entry gives one for it. A repository's first
  // row adds its owner to the count when no other repository has that owner.
  #storeRepo(pr: PrRef, entry: LedgerEntry): void {
    const repo = repoKey(pr);
    const added = this.#sql
      .exec(
        "INSERT INTO prq_repos (repo, owner, full_name) VALUES (?, ?, ?) ON CONFLICT (repo) DO NOTHING RETURNING repo",
        repo,
        pr.owner,
        repo,
      )
      .toArray();
    if (
      added.length > 0 &&
      this.#sql.exec<{ repos: number }>("SELECT count(*) AS repos FROM prq_repos WHERE owner = ?", pr.owner).one()
        .repos === 1
    ) {
      this.#sql.exec("UPDATE prq_ledger_totals SET owners = owners + 1 WHERE id = 1");
    }
    const fullName = entry.details?.fullName;
    if (fullName !== undefined && fullName.toLowerCase() === repo) {
      this.#sql.exec("UPDATE prq_repos SET full_name = ? WHERE repo = ? AND full_name != ?", fullName, repo, fullName);
    }
  }

  #replaceClaims(session: string, entry: LedgerEntry, now: number): void {
    const listed = new Set(entry.claims.map((claim) => `${claim.agentId}\n${claim.jobId}`));
    const before = this.#sql
      .exec<{ job_id: string; agent_id: string; claimed_at: number }>(
        "SELECT job_id, agent_id, claimed_at FROM prq_claims WHERE session = ?",
        session,
      )
      .toArray();
    for (const claim of before) {
      if (!listed.has(`${claim.agent_id}\n${claim.job_id}`)) {
        this.#contact(claim.agent_id, claimReleasedAt(claim.claimed_at, now));
      }
    }
    this.#sql.exec("DELETE FROM prq_claims WHERE session = ?", session);
    for (const claim of entry.claims) {
      this.#sql.exec(
        "INSERT INTO prq_claims (session, job_id, agent_id, claimed_at) VALUES (?, ?, ?, ?)",
        session,
        claim.jobId,
        claim.agentId,
        now - claim.ageMs,
      );
    }
  }

  // --- The view ---

  // The Hub as the UI shows it (its Agent state), the same size whatever the number of rows and agents: presence, the
  // ledger's totals and its version. Nothing in it changes on a contact alone.
  view(): HubView {
    const now = this.clock();
    const presentAgents = this.#presentAgents(now).size;
    const totals = this.#sql
      .exec<{
        version: number;
        present: number;
        absent: number;
        waiting: number;
        running: number;
        failed: number;
        owners: number;
      }>(
        `SELECT version, attention_present AS present, attention_absent AS absent, jobs_waiting AS waiting,
           jobs_running AS running, jobs_failed AS failed, owners FROM prq_ledger_totals WHERE id = 1`,
      )
      .one();
    const localAgentPresent = presentAgents > 0;
    return {
      localAgentPresent,
      presentAgents,
      jobs: { waiting: totals.waiting, running: totals.running, failed: totals.failed },
      needsAttention: localAgentPresent ? totals.present : totals.absent,
      owners: totals.owners,
      ledgerVersion: totals.version,
    };
  }

  // A page of the ledger's rows after the cursor (from the first without one) that pass the query's filters, each with
  // the problem presence gives it now, within the page's bytes and LEDGER_PAGE_ROWS. The order is the list's (latest
  // event descending, rows without one last, then the session descending) and the cursor a place in it, so a page goes
  // on after the place the cursor names whatever changed meanwhile. attention follows presence as the count does. A row
  // is bounded (its fields and MAX_ROW_CLAIMS claims), far below a page; one that did not fit would be refused rather
  // than sent over the budget.
  ledgerPage(query: LedgerQuery): LedgerPage | ErrorResponse {
    const after = query.cursor === undefined ? undefined : parseLedgerCursor(query.cursor);
    if (after === null) {
      return BAD_LEDGER_CURSOR;
    }
    const present = this.#localPresent(this.clock());
    const filter: LedgerFilter =
      query.attention === undefined
        ? { open: query.state !== "all", repo: query.repo?.toLowerCase() ?? null }
        : { attention: present ? "attention_present" : "attention_absent" };
    const select = ledgerSelect(filter, after, LEDGER_PAGE_ROWS + 1);
    const stored = this.#sql.exec<StoredRow>(select.query, ...select.bindings).toArray();
    const page = fitPage(
      stored,
      LEDGER_PAGE_ROWS,
      this.ledgerPageBytes(),
      MAX_LEDGER_CURSOR_CHARS,
      (row) => {
        const pr = parseSessionName(row.session);
        const entry = v.safeParse(LedgerEntry, JSON.parse(row.entry));
        // A row stored before the entry's shape was checked is passed over; the cursor still moves past it.
        return pr !== null && entry.success ? ledgerRow(pr, entry.output, present) : undefined;
      },
      (row) => `${row.sort_at}.${row.session}`,
    );
    return page ?? overflow("ledger", stored[0]?.session);
  }

  // The bytes a page of the ledger may take (spied on in tests).
  protected ledgerPageBytes(): number {
    return LEDGER_PAGE_BYTES;
  }

  // A page of the present agents after the cursor (an agent ID), by agent ID: each one's last contact, whether it
  // waits and whether it holds a claim. It reads the present agents as a contact does, so no agent whose presence has
  // ended is read.
  agentPage(cursor?: string): AgentPage | ErrorResponse {
    const after = cursor ?? "";
    const present = [...this.#presences(this.clock())]
      .filter(([agentId]) => agentId > after)
      .toSorted(([a], [b]) => byCodeUnit(a, b));
    const page = fitPage(
      present,
      AGENT_PAGE_ROWS,
      AGENT_PAGE_BYTES,
      MAX_AGENT_ID_CHARS,
      ([agentId, { lastSeenAt, waiting, latestClaimAt }]): AgentRow => ({
        agentId,
        lastSeenAt,
        waiting,
        holdsJob: latestClaimAt !== null,
      }),
      ([agentId]) => agentId,
    );
    return page ?? overflow("agents", present[0]?.[0]);
  }

  // A page of the repositories the ledger has rows of after the cursor (owner/name in any case), by owner/name.
  repoPage(cursor?: string): RepoPage | ErrorResponse {
    const stored = this.#sql
      .exec<{ repo: string; full_name: string }>(
        "SELECT repo, full_name FROM prq_repos WHERE repo > ? ORDER BY repo LIMIT ?",
        cursor?.toLowerCase() ?? "",
        REPO_PAGE_ROWS + 1,
      )
      .toArray();
    const page = fitPage(
      stored,
      REPO_PAGE_ROWS,
      REPO_PAGE_BYTES,
      MAX_FULL_NAME_CHARS,
      (row) => ({ fullName: row.full_name }),
      (row) => row.repo,
    );
    return page ?? overflow("repos", stored[0]?.repo);
  }

  // --- Instructions ---

  // The host's instructions (docs/design.md, Instructions and skills): both prompts, and the registered skills, of
  // which there are none yet. A cloud turn reads them at its start, and /cli/context with its first page.
  async instructions(): Promise<Instructions> {
    return { prompts: readPrompts(this.#sql), skills: [] };
  }

  // Replaces a kind's prompt and answers it as stored. A kind or a text the protocol refuses changes nothing.
  savePrompt(kind: PromptKind, text: string): Prompt | ErrorResponse {
    if (!v.is(PromptKind, kind) || !v.is(SavePromptRequest, { text })) {
      return { error: "bad_request", detail: "not a prompt kind and text" };
    }
    const saved = writePrompt(this.#sql, kind, text, this.clock());
    log("prq.prompt.saved", { kind, chars: text.length });
    return saved;
  }

  // The Hub's clock (spied on in tests, which set the time a presence ends and its alarm runs).
  protected clock(): number {
    return Date.now();
  }

  // The next value of the Hub's counter, which only grows.
  #next(): number {
    return this.#sql.exec<{ gen: number }>("UPDATE prq_hub SET gen = gen + 1 WHERE id = 1 RETURNING gen").one().gen;
  }

  #gen(): number {
    return this.#sql.exec<{ gen: number }>("SELECT gen FROM prq_hub WHERE id = 1").one().gen;
  }

  // --- The notification queue ---

  // A session may have local work. Its row takes the next value of the Hub's counter: a check that read an older
  // generation then never deletes it. Only a canonical session name is queued.
  notify(session: string): void {
    if (parseSessionName(session) === null) {
      log("prq.hub.notify_refused", {}, "warn");
      return;
    }
    const gen = this.#next();
    this.#sql.exec(
      `INSERT INTO prq_notifications (session, gen, notified_at) VALUES (?, ?, ?)
       ON CONFLICT (session) DO UPDATE SET gen = excluded.gen`,
      session,
      gen,
      this.clock(),
    );
    for (const waiter of this.#waiters) {
      waiter.wake();
    }
  }

  // The queued sessions, first notified first.
  #queue(): Notification[] {
    return this.#sql
      .exec<Notification>("SELECT session, gen FROM prq_notifications ORDER BY notified_at, session")
      .toArray();
  }

  // Whether a queued session has work for the agent: its own claimed job or a pending one. A session with no open job
  // leaves the queue, unless it was notified again during the check. A session that cannot be asked stays queued.
  async hasWork(agentId: string): Promise<boolean> {
    for (const row of this.#queue()) {
      let peek: Peek;
      try {
        peek = await this.peekSession(row.session, agentId);
      } catch (error) {
        log("prq.hub.session_failed", { pr: row.session, call: "peek", error: errorName(error) }, "error");
        continue;
      }
      if (!peek.open) {
        this.#sql.exec("DELETE FROM prq_notifications WHERE session = ? AND gen = ?", row.session, row.gen);
      }
      if (peek.resume || peek.fresh) {
        return true;
      }
    }
    return false;
  }

  // --- Wait ---

  // /cli/wait reaches the Hub as an HTTP request from the Worker; the Agents route forwards only the Hub's WebSocket, so
  // nothing else reaches this handler. A request rather than an RPC call: its signal fires when the agent's request
  // goes away, which ends the wait at once, while an RPC callee never learns that its caller is gone.
  override async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/cli/wait") {
      return new Response(null, { status: 404 });
    }
    const { agentId, timeoutMs } = v.parse(WaitRequest, await request.json());
    try {
      return Response.json(await this.#wait(agentId, timeoutMs, request.signal));
    } catch (error) {
      // A wait whose contact the Hub could not record (its view or its presence alarm) is not acknowledged: 503, which
      // the agent retries.
      log("prq.hub.wait_failed", { error: errorName(error) }, "error");
      const unavailable: ErrorResponse = { error: "unavailable" };
      return Response.json(unavailable, { status: 503 });
    }
  }

  // Ready as soon as a queued session has work for the agent, else timeout once the bound passes; it never takes a job.
  // The agent counts as present while it waits. Between checks it sleeps until a notify wakes it. A notify during a
  // check changes the Hub's counter, which the wait reads before the check and compares after it, so it checks again
  // rather than sleep past the notify.
  async #wait(agentId: string, timeoutMs: number | undefined, signal: AbortSignal): Promise<WaitResponse> {
    const waitMs = waitBoundMs(timeoutMs);
    const end = waitEnd(signal, (ended) => this.waitTimer(waitMs, ended));
    const waiter = { agentId, wake: () => {} };
    this.#waiters.add(waiter);
    try {
      // The start is a contact. Written inside the try, so a failed write still drops the waiter and the timer.
      await this.touch(agentId);
      while (!end.ended()) {
        const seen = this.#gen();
        if ((await end.race(this.hasWork(agentId))) === true) {
          return { status: "ready" };
        }
        if (!end.ended() && this.#gen() === seen) {
          await end.race(
            new Promise<void>((resolve) => {
              waiter.wake = resolve;
            }),
          );
        }
      }
      return { status: "timeout" };
    } finally {
      end.dispose();
      this.#waiters.delete(waiter);
      await this.touch(agentId);
    }
  }

  // Ends a wait after ms, and returns the timer's cancel (spied on in tests, which end waits by hand).
  protected waitTimer(ms: number, end: () => void): () => void {
    const timer = setTimeout(end, ms);
    return () => clearTimeout(timer);
  }

  // --- Claim ---

  // The agent's own claimed job first, from any queued session (a resume, under a new claimId), then the next pending
  // job, session by session. The call is one attempt, numbered from the Hub's counter: a session lets no older attempt
  // of the agent replace what a newer one claimed.
  async claim(agentId: string): Promise<ClaimResponse> {
    await this.touch(agentId);
    const attempt = this.#next();
    for (const mode of ["resume", "fresh"] as const) {
      for (const { session } of this.#queue()) {
        let response: ClaimResponse;
        try {
          response = await this.claimSession(session, agentId, mode, attempt);
        } catch (error) {
          log("prq.hub.session_failed", { pr: session, call: "claim", error: errorName(error) }, "error");
          continue;
        }
        if (response.job !== null) {
          return response;
        }
      }
    }
    return { job: null };
  }

  // A session's stub, once the session has started (spied on in tests).
  protected async sessionStub(session: string): Promise<DurableObjectStub<PrSession>> {
    return prSessionStub(this.env, sessionRef(session));
  }

  // The bound on a call to a session, its start included (spied on in tests).
  protected sessionCallMs(): number {
    return SESSION_CALL_MS;
  }

  // A session's peek (spied on in tests).
  protected async peekSession(session: string, agentId: string): Promise<Peek> {
    return this.#callSession<Peek>(session, "a session's peek", (stub) => stub.peek(agentId));
  }

  // A session's claim. One that times out keeps running and can still land: it claims nothing once a newer attempt of
  // the agent has claimed in the session, and otherwise its job is the agent's own claimed job, which the agent's next
  // claim resumes under a new claimId.
  protected async claimSession(
    session: string,
    agentId: string,
    mode: "resume" | "fresh",
    attempt: number,
  ): Promise<ClaimResponse> {
    return this.#callSession<ClaimResponse>(session, "a session's claim", (stub) => stub.claim(agentId, mode, attempt));
  }

  // A call to a session, bounded as a whole: getting the stub waits for the session's start.
  async #callSession<T>(
    session: string,
    what: string,
    call: (stub: DurableObjectStub<PrSession>) => PromiseLike<T>,
  ): Promise<T> {
    return withTimeout(this.sessionStub(session).then(call), this.sessionCallMs(), what);
  }
}

// A wait's end: its bound passing (the timer `start` sets) or its request's abort, whichever comes first.
function waitEnd(signal: AbortSignal, start: (end: () => void) => () => void) {
  let ended = false;
  let end!: () => void;
  const reached = new Promise<undefined>((resolve) => {
    end = () => {
      ended = true;
      resolve(undefined);
    };
  });
  const cancel = start(end);
  signal.addEventListener("abort", end);
  if (signal.aborted) {
    end();
  }
  return {
    ended: () => ended,
    // The promise's outcome, or undefined once the wait has ended.
    race: <T>(promise: Promise<T>): Promise<T | undefined> => Promise.race([promise, reached]),
    dispose: () => {
      cancel();
      signal.removeEventListener("abort", end);
    },
  };
}

function sessionRef(session: string): PrRef {
  const ref = parseSessionName(session);
  if (ref === null) {
    throw new TypeError("the queue holds canonical session names only");
  }
  return ref;
}

// A row of the list: the session's entry, with the problem the Hub picks from it and whether an agent is present.
function ledgerRow(pr: PrRef, entry: LedgerEntry, localAgentPresent: boolean): LedgerRow {
  return {
    pr,
    details: entry.details,
    owner: entry.owner,
    latestEvent: entry.latestEvent,
    problem: problemOf(entry, localAgentPresent),
    jobs: entry.jobs,
    claims: entry.claims.slice(0, MAX_ROW_CLAIMS).map(({ agentId, jobId, since }) => ({ agentId, jobId, since })),
  };
}

// The canonical owner/name of a pull request's repository.
function repoKey(pr: PrRef): string {
  return `${pr.owner}/${pr.repo}`;
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The query for up to `limit` rows of the list after a place in its order, under the filter. Each filter has an index
// that holds the rows it keeps, and only those, in the list's order (schema.ts), so a page is one range of that index
// read backwards and reads no row it leaves out. The query names that index (INDEXED BY), so no planner, whatever its
// version or statistics, trades it for one that leaves rows to skip; it carries a partial index's condition as a
// literal, which the index needs to apply, and the place as a row value.
export function ledgerSelect(
  filter: LedgerFilter,
  after: LedgerCursor | undefined,
  limit: number,
): { query: string; bindings: unknown[] } {
  const { index, where, bindings } = ledgerIndex(filter);
  if (after !== undefined) {
    where.push("(sort_at, session) < (?, ?)");
    bindings.push(after.at, after.session);
  }
  const conditions = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return {
    query: `SELECT session, sort_at, entry FROM prq_ledger INDEXED BY ${index} ${conditions}
      ORDER BY sort_at DESC, session DESC LIMIT ?`,
    bindings: [...bindings, limit],
  };
}

// A filter's index and the conditions that keep its rows.
function ledgerIndex(filter: LedgerFilter): { index: string; where: string[]; bindings: unknown[] } {
  if ("attention" in filter) {
    return { index: `prq_ledger_${filter.attention}`, where: [`${filter.attention} = 1`], bindings: [] };
  }
  const open = filter.open ? ["open = 1"] : [];
  if (filter.repo === null) {
    return { index: filter.open ? "prq_ledger_open" : "prq_ledger_order", where: open, bindings: [] };
  }
  return {
    index: filter.open ? "prq_ledger_repo_open" : "prq_ledger_repo",
    where: [...open, "repo = ?"],
    bindings: [filter.repo],
  };
}

// The rows of a page: `stored` in order (up to limit + 1 of them, the last only telling that more follow), each as
// `show` gives it (undefined passes it over, the cursor still moving past it), while the page's JSON stays within
// `budget` bytes with a cursor of maxCursor characters. null when the first row alone does not fit.
function fitPage<S, R>(
  stored: readonly S[],
  limit: number,
  budget: number,
  maxCursor: number,
  show: (row: S) => R | undefined,
  cursorOf: (row: S) => string,
): Page<R> | null {
  const rows: R[] = [];
  let left = budget - jsonBytes({ rows: [], nextCursor: "x".repeat(maxCursor) });
  let last: S | undefined;
  for (const row of stored.slice(0, limit)) {
    const shown = show(row);
    if (shown !== undefined) {
      const bytes = jsonBytes(shown) + (rows.length > 0 ? 1 : 0);
      if (bytes > left) {
        return last === undefined ? null : { rows, nextCursor: cursorOf(last) };
      }
      left -= bytes;
      rows.push(shown);
    }
    last = row;
  }
  return { rows, nextCursor: stored.length > limit && last !== undefined ? cursorOf(last) : null };
}

// A page whose first row does not fit: refused, which the row bounds rule out.
function overflow(page: string, first: string | undefined): ErrorResponse {
  log("prq.page.overflow", { page, first }, "error");
  return { error: "internal", detail: "a row does not fit in a page" };
}

// A cursor is a row's place in the list's order: its sort_at, a dot, and its session.
function parseLedgerCursor(text: string): LedgerCursor | null {
  const match = /^(-1|0|[1-9][0-9]*)\.(.+)$/.exec(text);
  const at = Number(match?.[1]);
  const session = match?.[2];
  if (session === undefined || parseSessionName(session) === null || !Number.isSafeInteger(at)) {
    return null;
  }
  return { at, session };
}
