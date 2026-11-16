import {
  type ClaimResponse,
  type HubView,
  type LedgerRow,
  parseSessionName,
  type PoolAgent,
  type PrRef,
  WaitRequest,
  type WaitResponse,
} from "@prq/protocol";
import { Agent, type Connection } from "agents";
import * as v from "valibot";

import { refuseSubAgent, sendServerVersion } from "./agents.ts";
import {
  claimReleasedAt,
  isPresent,
  LedgerEntry,
  needsAttention,
  PRESENCE_MS,
  type Presence,
  presenceEnd,
  problemOf,
} from "./ledger.ts";
import { errorName, log } from "./log.ts";
import { prSessionStub } from "./names.ts";
import type { PrSession } from "./pr-session/index.ts";
import type { Peek } from "./pr-session/jobs.ts";
import { HUB_SCHEMA, migrate } from "./schema.ts";
import { SerialQueue, withTimeout } from "./wait.ts";

// How long a call to a PrSession may take, the session's start included.
const SESSION_CALL_MS = 10_000;
// The longest a wait lasts; the agent then waits again.
export const WAIT_MAX_MS = 25_000;

// How long a wait asked for timeoutMs lasts at most.
export function waitBoundMs(timeoutMs: number | undefined): number {
  return Math.min(timeoutMs ?? WAIT_MAX_MS, WAIT_MAX_MS);
}

type Notification = { session: string; gen: number };

type AgentPresence = Presence & { claimedAt: number[] };

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

  // Presence may have ended while the Hub was not running.
  override async onStart(): Promise<void> {
    await this.#poolChanged();
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
    this.#contact(agentId, Date.now());
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
    const now = Date.now();
    return [...this.#presences(now).values()].some((presence) => isPresent(presence, now));
  }

  // Each agent ID that may be present at now, with what its presence rests on, all on the Hub's clock.
  #presences(now: number): Map<string, AgentPresence> {
    const presences = new Map<string, AgentPresence>();
    const of = (agentId: string): AgentPresence => {
      let presence = presences.get(agentId);
      if (presence === undefined) {
        presence = { waiting: false, lastSeenAt: null, claimedAt: [] };
        presences.set(agentId, presence);
      }
      return presence;
    };
    const recent = this.#sql.exec<{ agent_id: string; last_seen_at: number }>(
      "SELECT agent_id, last_seen_at FROM prq_agents WHERE last_seen_at > ?",
      now - PRESENCE_MS,
    );
    for (const row of recent) {
      of(row.agent_id).lastSeenAt = row.last_seen_at;
    }
    for (const row of this.#sql.exec<{ agent_id: string; claimed_at: number }>(
      "SELECT agent_id, claimed_at FROM prq_claims",
    )) {
      of(row.agent_id).claimedAt.push(row.claimed_at);
    }
    for (const waiter of this.#waiters) {
      of(waiter.agentId).waiting = true;
    }
    for (const [agentId, presence] of presences) {
      presence.lastSeenAt ??=
        this.#sql
          .exec<{ last_seen_at: number }>("SELECT last_seen_at FROM prq_agents WHERE agent_id = ?", agentId)
          .toArray()[0]?.last_seen_at ?? null;
    }
    return presences;
  }

  // After any change to the pool or the ledger: the view, set only when it changed, and presenceEnded at the next
  // time an agent's presence ends. Neither failure undoes the change that called it: a later change sets both again.
  async #poolChanged(): Promise<void> {
    try {
      const view = this.view();
      if (JSON.stringify(view) !== JSON.stringify(this.state)) {
        this.setState(view);
      }
    } catch (error) {
      log("prq.hub.view_failed", { error: errorName(error) }, "error");
    }
    try {
      await this.#presenceAlarm.run(() => this.#armPresenceEnded());
    } catch (error) {
      log("prq.hub.presence_alarm_failed", { error: errorName(error) }, "error");
    }
  }

  // presenceEnded at the first whole second at or after the earliest time a present agent's presence ends, unless a
  // row for a later second than this one is due by then (a row due now may be the one running, which is ending).
  async #armPresenceEnded(): Promise<void> {
    const now = Date.now();
    const ends = [...this.#presences(now).values()].map(presenceEnd).filter((end) => end > now && end < Infinity);
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
    if (parseSessionName(session) === null || !v.is(LedgerEntry, entry)) {
      log("prq.hub.ledger_refused", {}, "warn");
      return;
    }
    const now = Date.now();
    const stored = this.ctx.storage.transactionSync(() => {
      const applied = this.#sql
        .exec(
          `INSERT INTO prq_ledger (session, rev, latest_event_at, entry) VALUES (?, ?, ?, ?)
           ON CONFLICT (session) DO UPDATE SET rev = excluded.rev, latest_event_at = excluded.latest_event_at,
             entry = excluded.entry
           WHERE excluded.rev > prq_ledger.rev RETURNING rev`,
          session,
          rev,
          entry.latestEvent?.at ?? null,
          JSON.stringify(entry),
        )
        .toArray();
      if (applied.length === 0) {
        return this.#sql.exec<{ rev: number }>("SELECT rev FROM prq_ledger WHERE session = ?", session).one().rev;
      }
      this.#replaceClaims(session, entry, now);
      return null;
    });
    if (stored !== null && rev < stored) {
      log("prq.ledger.stale_rev", { pr: session, rev, stored }, "warn");
    }
    await this.#poolChanged();
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

  // The Hub as the UI shows it: the present agents, and every row by latest event with its problem.
  view(): HubView {
    const now = Date.now();
    const agents: PoolAgent[] = [...this.#presences(now)]
      .filter(([, presence]) => isPresent(presence, now))
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([agentId, presence]) => ({
        agentId,
        lastSeenAt: presence.lastSeenAt,
        waiting: presence.waiting,
        holdsJob: presence.claimedAt.length > 0,
      }));
    const localAgentPresent = agents.length > 0;
    const prs = this.#sql
      .exec<{ session: string; entry: string }>(
        "SELECT session, entry FROM prq_ledger ORDER BY latest_event_at IS NULL, latest_event_at DESC, session",
      )
      .toArray()
      .flatMap((row) => {
        const pr = parseSessionName(row.session);
        const entry = v.safeParse(LedgerEntry, JSON.parse(row.entry));
        return pr === null || !entry.success ? [] : [ledgerRow(pr, entry.output, localAgentPresent)];
      });
    return { localAgentPresent, agents, prs, needsAttention: prs.filter((row) => needsAttention(row.problem)).length };
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
      Date.now(),
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
    return Response.json(await this.#wait(agentId, timeoutMs, request.signal));
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
    claims: entry.claims.map(({ agentId, jobId, since }) => ({ agentId, jobId, since })),
  };
}
