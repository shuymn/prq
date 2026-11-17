import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prSessionStub } from "./names.ts";
import type { PrSession } from "./pr-session/index.ts";
import type { Delivery } from "./pr-session/jobs.ts";
import { captureLogs, type LogEntry } from "./test/access.ts";
import { appEnv } from "./test/github.ts";
import { prSessionSeams, setPool } from "./test/session.ts";
import { BASE, INSTALLATION_ID, sha } from "./test/webhook.ts";

// Head reconciliation against GitHub's truth (docs/design.md, Intake). Each run generates what happens on GitHub (pushes,
// with ties within a second and returns to an earlier head, and edits that only move updated_at), when each delivery
// is taken in or lost, when a read of GitHub's head is answered and with which snapshot (current, or lagging by whole
// seconds or within the second), and the retry wakes. Each step runs on the oracle's truth and on a real session. The
// oracle derives the head from GitHub's true push order alone, where the design decides it (E1-E5), and skips steps
// it leaves open. The real session is also checked alone after every step. fast-check shrinks a failing run and prints
// its seed, path and steps; those steps are then added to the corpus.

// --- GitHub's truth ---

const HEADS = ["A", "B", "C", "D"] as const;
type Label = (typeof HEADS)[number];

// A push's pick that returns to the head the latest push left.
const BACK = 4;

// The second of the first event; later ones follow at small steps, so ties are frequent.
const FIRST_SECOND = 100;
const MAX_EVENTS = 12;

type TruthEvent = {
  index: number;
  kind: "push" | "edit";
  second: number;
  // A push's head before it (null for the first, an opened); an edit's is null.
  before: Label | null;
  // The head after the event.
  head: Label;
};

function at(second: number): number {
  return Date.UTC(2026, 10, 3) + second * 1000;
}

type Shape = "r1" | "r2" | "r3" | "r4" | "r5a" | "r5b";
const SHAPES: readonly Shape[] = ["r1", "r2", "r3", "r4", "r5a", "r5b"];

// A read in flight: when it was sent, in truth events and in pushes taken in, and the session's head_at then.
type Read = { truthLength: number; takenAtStart: number; headAt: number | null };

// The truth so far, what the session was told of it, and what the oracle may conclude.
class Oracle {
  readonly events: TruthEvent[] = [];
  readonly delivery: ("pending" | "taken" | "lost")[] = [];
  // Push indices in the order they were taken in.
  readonly taken: number[] = [];
  // Pushes taken in or contained in an adopted snapshot.
  readonly known = new Set<number>();
  read: Read | null = null;
  lost = false;
  gaveUp = false;
  // Seconds in which a return was answered by a lagging snapshot while no push was taken in (undecided until a
  // later second).
  readonly laggingReturns = new Set<number>();
  adopted: { second: number; point: number } | null = null;
  readonly markSeconds = new Set<number>();
  readonly shapes = new Set<Shape>();
  lastHeadAt: number | null = null;

  head(point = this.events.length): Label | null {
    return point === 0 ? null : (this.events[point - 1]?.head ?? null);
  }

  pushes(): TruthEvent[] {
    return this.events.filter((event) => event.kind === "push");
  }

  pushesOf(second: number): TruthEvent[] {
    return this.pushes().filter((event) => event.second === second);
  }

  pending(): TruthEvent[] {
    return this.events.filter((event) => this.delivery[event.index] === "pending");
  }

  isTaken(index: number): boolean {
    return this.delivery[index] === "taken";
  }

  // Whether the second's `before` links, in GitHub's truth, lead from the head back to it: a return.
  onCycle(second: number, head: Label): boolean {
    const links = this.pushesOf(second).filter((push) => push.before !== null);
    const seen = new Set<Label>();
    const next: Label[] = [head];
    for (let from = next.pop(); from !== undefined; from = next.pop()) {
      for (const link of links) {
        if (link.before === from) {
          if (link.head === head) {
            return true;
          }
          if (!seen.has(link.head)) {
            seen.add(link.head);
            next.push(link.head);
          }
        }
      }
    }
    return false;
  }

  // A push taken in, of the second, that left the head (its `before`).
  leftBy(second: number, head: Label): TruthEvent | undefined {
    return this.pushesOf(second).find((push) => push.before === head && this.isTaken(push.index));
  }

  newestTakenSecond(): number | null {
    const seconds = this.taken.map((index) => this.events[index]?.second ?? 0);
    return seconds.length === 0 ? null : Math.max(...seconds);
  }

  // E1 and E2: the head GitHub's order decides from the pushes known, or null where the design leaves it open.
  decided(): Label | null {
    const known = this.pushes().filter((push) => this.known.has(push.index));
    if (known.length === 0) {
      return null;
    }
    const newest = Math.max(...known.map((push) => push.second));
    const ofSecond = this.pushesOf(newest);
    // E1: the newest second holds one push in GitHub's truth.
    if (ofSecond.length === 1) {
      return ofSecond[0]?.head ?? null;
    }
    // E2: every push of that second taken in, in true order (and no lagging answer adopted inside its return).
    const takenOfSecond = this.taken.filter((index) => this.events[index]?.second === newest);
    const allTaken = ofSecond.every((push) => this.isTaken(push.index));
    const inOrder = takenOfSecond.every(
      (index, position) => position === 0 || (takenOfSecond[position - 1] ?? 0) < index,
    );
    if (allTaken && inOrder && !this.laggingReturns.has(newest)) {
      return ofSecond.at(-1)?.head ?? null;
    }
    return null;
  }
}

// --- The real session ---

type SessionRow = { head_sha: string | null; head_at: number | null; reconcile_at: number | null };

// The App's environment, one object for every run: one client, so the installation token is minted once.
const APP_ENV = { ...env, ...appEnv() };

let runs = 0;

class Real {
  readonly #instance: PrSession;
  readonly #sql: SqlStorage;
  readonly #logs: LogEntry[];
  #logged: number;
  // The held read's answer, and the settle that waits for it.
  #answer: ((response: Response) => void) | null = null;
  #reading: Promise<void> | null = null;
  #readArrived: (() => void) | null = null;

  constructor(instance: PrSession, sql: SqlStorage, logs: LogEntry[]) {
    this.#instance = instance;
    this.#sql = sql;
    this.#logs = logs;
    this.#logged = logs.length;
  }

  row(): SessionRow {
    return this.#sql.exec<SessionRow>("SELECT head_sha, head_at, reconcile_at FROM prq_session WHERE id = 1").one();
  }

  newestTakenAt(): number | null {
    return this.#sql
      .exec<{ newest: number | null }>("SELECT max(at) AS newest FROM prq_inbox WHERE processed = 1 AND push = 1")
      .one().newest;
  }

  // The fetch spy's pull request read: held until the run answers it.
  onRead(): Promise<Response> {
    return new Promise((resolve) => {
      this.#answer = resolve;
      this.#readArrived?.();
    });
  }

  // A delivery stored in the inbox, then taken in by a settle.
  async deliver(event: TruthEvent): Promise<boolean> {
    const push = event.kind === "push";
    const delivery: Delivery = {
      deliveryId: crypto.randomUUID(),
      action: push ? (event.before === null ? "opened" : "synchronize") : "edited",
      push,
      at: at(event.second),
      before: push && event.before !== null ? sha(event.before) : null,
      installationId: INSTALLATION_ID,
      details: {
        fullName: "octo/oracle",
        title: "A change",
        state: "open",
        url: "https://github.com/octo/oracle/pull/1",
        headSha: sha(event.head),
        baseSha: BASE,
      },
    };
    await this.#instance.receive(delivery);
    return this.settle();
  }

  // A settle, as a wake runs it: it ends, or it reaches a read and waits for its answer. Returns whether a read began.
  async settle(): Promise<boolean> {
    const arrived = new Promise<"read">((resolve) => {
      this.#readArrived = () => resolve("read");
    });
    const settle = this.#instance.settle();
    const first = await Promise.race([settle.then(() => "done" as const), arrived]);
    this.#readArrived = null;
    if (first === "read") {
      this.#reading = settle;
      return true;
    }
    return false;
  }

  // Answers the held read and waits for its settle.
  async answer(response: Response): Promise<void> {
    if (this.#answer === null || this.#reading === null) {
      throw new Error("no read is held");
    }
    this.#answer(response);
    this.#answer = null;
    await this.#reading;
    this.#reading = null;
  }

  // The reconcile events logged since the last call.
  outcomes(): string[] {
    const fresh = this.#logs.slice(this.#logged).map((log) => String(log.entry["event"]));
    this.#logged = this.#logs.length;
    return fresh.filter((event) => event.startsWith("prq.head."));
  }
}

// --- Checks ---

function labelOf(headSha: string | null): Label | null {
  return HEADS.find((label) => sha(label) === headSha) ?? null;
}

// The real session alone: head_at never decreases and is at least every taken-in push's second; the mark is null or
// head_at.
function checkInvariant(oracle: Oracle, real: Real): void {
  const row = real.row();
  const newest = real.newestTakenAt();
  if (oracle.lastHeadAt !== null && (row.head_at === null || row.head_at < oracle.lastHeadAt)) {
    throw new Error(`head_at decreased from ${oracle.lastHeadAt} to ${row.head_at}`);
  }
  if (newest !== null && (row.head_at === null || row.head_at < newest)) {
    throw new Error(`head_at ${row.head_at} is older than a push taken in at ${newest}`);
  }
  if (row.reconcile_at !== null && row.reconcile_at !== row.head_at) {
    throw new Error(`the mark ${row.reconcile_at} is not head_at ${row.head_at}`);
  }
  oracle.lastHeadAt = row.head_at;
  if (row.reconcile_at !== null) {
    oracle.markSeconds.add(row.reconcile_at);
  }
}

function checkDecided(oracle: Oracle, real: Real, step: string): void {
  checkInvariant(oracle, real);
  const expected = oracle.decided();
  const head = labelOf(real.row().head_sha);
  if (expected !== null && head !== expected) {
    throw new Error(`after ${step}: the head is ${head}, GitHub's order decides ${expected}`);
  }
}

// --- Commands ---

type Command = fc.AsyncCommand<Oracle, Real>;

// A push on GitHub, `step` seconds after the event before it; `lost`: its delivery never comes.
class Push implements Command {
  readonly step: 0 | 1 | 2;
  readonly pick: number;
  readonly lost: boolean;

  constructor(step: 0 | 1 | 2, pick: number, lost = false) {
    this.step = step;
    this.pick = pick;
    this.lost = lost;
  }

  check(oracle: Oracle): boolean {
    return oracle.events.length < MAX_EVENTS;
  }

  async run(oracle: Oracle): Promise<void> {
    const last = oracle.events.at(-1);
    const before = oracle.head();
    // BACK returns to the head the latest push left: a force-push back.
    const left = oracle.pushes().at(-1)?.before ?? null;
    let head = this.pick === BACK && left !== null ? left : (HEADS[this.pick % HEADS.length] ?? "A");
    if (head === before) {
      head = HEADS[(this.pick + 1) % HEADS.length] ?? "A";
    }
    const index = oracle.events.length;
    oracle.events.push({
      index,
      kind: "push",
      second: last === undefined ? FIRST_SECOND : last.second + this.step,
      before,
      head,
    });
    oracle.delivery.push(this.lost ? "lost" : "pending");
    oracle.lost ||= this.lost;
  }

  toString(): string {
    return `push(+${this.step}, ${this.pick === BACK ? "back" : this.pick}${this.lost ? ", lost" : ""})`;
  }
}

class Edit implements Command {
  readonly step: 0 | 1;

  constructor(step: 0 | 1) {
    this.step = step;
  }

  check(oracle: Oracle): boolean {
    return oracle.events.length > 0 && oracle.events.length < MAX_EVENTS;
  }

  async run(oracle: Oracle): Promise<void> {
    const last = oracle.events.at(-1);
    const head = oracle.head();
    if (last === undefined || head === null) {
      return;
    }
    oracle.events.push({
      index: oracle.events.length,
      kind: "edit",
      second: last.second + this.step,
      before: null,
      head,
    });
    oracle.delivery.push("pending");
  }

  toString(): string {
    return `edit(+${this.step})`;
  }
}

class Deliver implements Command {
  readonly pick: number;

  constructor(pick: number) {
    this.pick = pick;
  }

  check(oracle: Oracle): boolean {
    return oracle.pending().length > 0;
  }

  async run(oracle: Oracle, real: Real): Promise<void> {
    const pending = oracle.pending();
    const event = pending[this.pick % pending.length];
    if (event === undefined) {
      return;
    }
    const before = real.row();
    if (event.kind === "push") {
      if (oracle.read !== null && at(event.second) === oracle.read.headAt) {
        oracle.shapes.add("r1");
      }
      const { adopted } = oracle;
      if (adopted !== null && before.head_at === at(adopted.second) && event.second === adopted.second) {
        if (event.index < adopted.point) {
          oracle.shapes.add("r2");
        }
      }
    }
    const reading = await real.deliver(event);
    oracle.delivery[event.index] = "taken";
    if (event.kind === "push") {
      oracle.taken.push(event.index);
      oracle.known.add(event.index);
    }
    if (reading) {
      startRead(oracle, real);
    }
    real.outcomes();
    checkDecided(oracle, real, this.toString());
  }

  toString(): string {
    return `deliver(${this.pick})`;
  }
}

class Lose implements Command {
  readonly pick: number;

  constructor(pick: number) {
    this.pick = pick;
  }

  check(oracle: Oracle): boolean {
    return oracle.pending().length > 0;
  }

  async run(oracle: Oracle): Promise<void> {
    const pending = oracle.pending();
    const event = pending[this.pick % pending.length];
    if (event !== undefined) {
      oracle.delivery[event.index] = "lost";
      oracle.lost = true;
    }
  }

  toString(): string {
    return `lose(${this.pick})`;
  }
}

class Wake implements Command {
  check(oracle: Oracle): boolean {
    return oracle.read === null;
  }

  async run(oracle: Oracle, real: Real): Promise<void> {
    if (await real.settle()) {
      startRead(oracle, real);
    }
    real.outcomes();
    checkDecided(oracle, real, this.toString());
  }

  toString(): string {
    return "wake";
  }
}

function startRead(oracle: Oracle, real: Real): void {
  oracle.read = { truthLength: oracle.events.length, takenAtStart: oracle.taken.length, headAt: real.row().head_at };
}

// The answer to the read in flight: GitHub's state `lag` events before the current one (at least the first push's), or
// a 503.
class Answer implements Command {
  readonly lag: number;
  readonly fail: boolean;

  constructor(lag: number, fail = false) {
    this.lag = lag;
    this.fail = fail;
  }

  check(oracle: Oracle): boolean {
    return oracle.read !== null;
  }

  async run(oracle: Oracle, real: Real): Promise<void> {
    const { read } = oracle;
    if (read === null) {
      return;
    }
    oracle.read = null;
    const pushDuring = oracle.taken.length > read.takenAtStart;
    if (this.fail) {
      await real.answer(Response.json({ message: "unavailable" }, { status: 503 }));
      this.observe(oracle, real, null);
      checkDecided(oracle, real, this.toString());
      return;
    }
    const firstPush = oracle.events.findIndex((event) => event.kind === "push") + 1;
    const point = Math.max(firstPush, oracle.events.length - this.lag);
    const head = oracle.head(point);
    const second = oracle.events[point - 1]?.second;
    if (head === null || second === undefined) {
      throw new Error("a read before any push");
    }
    const current = point === oracle.events.length;
    const headBefore = real.row();
    this.shapes(oracle, { head, second, point, current, headAt: headBefore.head_at });
    if (!current && !pushDuring && oracle.onCycle(second, head)) {
      oracle.laggingReturns.add(second);
    }
    const body = { head: { sha: sha(head) }, updated_at: new Date(at(second)).toISOString().replace(/\.\d{3}Z$/, "Z") };
    await real.answer(Response.json(body));
    const adopted = this.observe(oracle, real, { second, point });
    const after = labelOf(real.row().head_sha);

    // E4: never adopt a head a push of that second already taken in had left, unless the second returns to it.
    if (adopted && oracle.leftBy(second, head) !== undefined && !oracle.onCycle(second, head)) {
      throw new Error(`${this.toString()}: adopted ${head} of second ${second}, which a push taken in had left`);
    }
    // E3: GitHub's current state, no push taken in during the read, not older than any push taken in, every push of
    // its second taken in: the head is that state's.
    const newestTaken = oracle.newestTakenSecond();
    const allTaken = oracle.pushesOf(second).every((push) => oracle.isTaken(push.index));
    if (current && !pushDuring && (newestTaken === null || second >= newestTaken) && allTaken && after !== head) {
      throw new Error(`${this.toString()}: GitHub's current head ${head} was not taken; the head is ${after}`);
    }
    checkDecided(oracle, real, this.toString());
  }

  // What the session did with the answer, from its log events. Returns whether it adopted it.
  observe(oracle: Oracle, real: Real, snapshot: { second: number; point: number } | null): boolean {
    const outcomes = real.outcomes();
    if (outcomes.includes("prq.head.reconcile_failed")) {
      oracle.gaveUp = true;
    }
    const adopted = outcomes.includes("prq.head.reconciled");
    if (adopted && snapshot !== null) {
      for (const push of oracle.pushes()) {
        if (push.index < snapshot.point) {
          oracle.known.add(push.index);
        }
      }
      oracle.adopted = snapshot;
    }
    return adopted;
  }

  shapes(
    oracle: Oracle,
    answer: { head: Label; second: number; point: number; current: boolean; headAt: number | null },
  ): void {
    const { head, second, current, headAt } = answer;
    if (headAt !== null && at(second) < headAt && oracle.markSeconds.has(at(second))) {
      oracle.shapes.add("r3");
    }
    const left = oracle.leftBy(second, head);
    if (left === undefined) {
      return;
    }
    const reached = oracle
      .pushes()
      .filter((push) => push.head === head && push.index < left.index)
      .at(-1);
    const returns = oracle
      .pushes()
      .filter((push) => push.second === second && push.head === head && push.index > left.index);
    if (current) {
      if (returns.some((push) => oracle.delivery[push.index] === "lost")) {
        oracle.shapes.add("r5a");
      }
      return;
    }
    if (headAt !== at(second) || returns.length > 0 || reached === undefined) {
      return;
    }
    oracle.shapes.add(reached.second < second ? "r4" : "r5b");
  }

  toString(): string {
    return this.fail ? "answer(503)" : `answer(lag ${this.lag})`;
  }
}

// --- Runs ---

// The end of a run: every delivery not lost is taken in, the replica serves the current state, and the wakes run
// until the session holds no mark. E5: without a lost delivery, a mark given up, or a lagging answer adopted inside the
// newest second's return, the head is then GitHub's.
async function finish(oracle: Oracle, real: Real): Promise<void> {
  const current = () => {
    const head = oracle.head();
    const second = oracle.events.at(-1)?.second;
    return Response.json({
      head: { sha: sha(head ?? "A") },
      updated_at: new Date(at(second ?? FIRST_SECOND)).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
  };
  const settleRead = async (reading: boolean) => {
    if (reading) {
      startRead(oracle, real);
    }
    if (oracle.read !== null) {
      oracle.read = null;
      await real.answer(current());
      if (real.outcomes().includes("prq.head.reconcile_failed")) {
        oracle.gaveUp = true;
      }
    }
  };
  await settleRead(false);
  for (const event of oracle.pending()) {
    const reading = await real.deliver(event);
    oracle.delivery[event.index] = "taken";
    if (event.kind === "push") {
      oracle.taken.push(event.index);
    }
    await settleRead(reading);
  }
  for (let wake = 0; wake < 8 && real.row().reconcile_at !== null; wake += 1) {
    await settleRead(await real.settle());
  }
  checkInvariant(oracle, real);
  if (real.row().reconcile_at !== null) {
    throw new Error("the session is still marked after 8 wakes with the replica current");
  }
  const newest = oracle.pushes().at(-1)?.second;
  if (oracle.lost || oracle.gaveUp || newest === undefined || oracle.laggingReturns.has(newest)) {
    return;
  }
  const head = labelOf(real.row().head_sha);
  if (head !== oracle.head()) {
    throw new Error(`at the end: the head is ${head}, GitHub's is ${oracle.head()}`);
  }
}

const pushes = fc
  .tuple(fc.constantFrom<0 | 1 | 2>(0, 0, 0, 1, 2), fc.constantFrom(0, 1, 2, 3, BACK, BACK), fc.nat(7))
  .map(([step, pick, lost]) => new Push(step, pick, lost === 0));
const edits = fc.constantFrom<0 | 1>(0, 1, 1).map((step) => new Edit(step));
const loses = fc.nat(3).map((pick) => new Lose(pick));
// Deliveries mostly in the order GitHub sent them.
const delivers = fc.constantFrom(0, 0, 0, 1, 2, 3).map((pick) => new Deliver(pick));
const answers = fc
  .tuple(fc.constantFrom(0, 0, 1, 1, 2, 3), fc.nat(9))
  .map(([lag, failure]) => new Answer(lag, failure === 0));

const commands = fc.commands(
  [
    pushes,
    pushes,
    pushes,
    edits,
    edits,
    delivers,
    delivers,
    delivers,
    loses,
    fc.constant(new Wake()),
    answers,
    answers,
  ],
  { maxCommands: 60, size: "max" },
);

// The corpus: the shapes the design's rules were written for, run first through `examples`.
const CORPUS: Record<Shape, Command[]> = {
  // A tie (C kept out against A), a read held, and B moving the head in the same second while it is in flight.
  r1: [
    new Push(0, 0),
    new Push(0, 1),
    new Push(0, 2),
    new Deliver(0),
    new Deliver(1),
    new Deliver(0),
    new Answer(1),
    new Wake(),
    new Answer(0),
  ],
  // GitHub answers C at second 101; the late delivery of D, an older push stamped 101, then ties.
  r2: [
    new Push(0, 0),
    new Push(0, 1),
    new Push(1, 3),
    new Push(0, 2),
    new Deliver(0),
    new Deliver(0),
    new Answer(0),
    new Deliver(0),
    new Answer(0),
    new Deliver(0),
  ],
  // A tie at 100, a later-second push before the read of it, then a tie at 101 answered as of second 100.
  r3: [
    new Push(0, 0),
    new Push(0, 1),
    new Push(1, 2),
    new Push(0, 3),
    new Push(0, 0),
    new Deliver(0),
    new Deliver(0),
    new Deliver(0),
    new Answer(0),
    new Deliver(1),
    new Answer(3),
    new Wake(),
    new Answer(0),
  ],
  // B, then C (before B) and D at second 101, answered with B as of an edit of second 101.
  r4: [
    new Push(0, 1),
    new Edit(1),
    new Push(0, 2),
    new Push(0, 3),
    new Deliver(0),
    new Deliver(1),
    new Deliver(1),
    new Answer(2),
    new Wake(),
    new Answer(0),
  ],
  // A, B, A within one second; the return's delivery is lost and GitHub answers A: undecided (the accepted limit).
  r5a: [
    new Push(0, 0),
    new Push(0, 1),
    new Push(0, 0),
    new Deliver(0),
    new Lose(1),
    new Deliver(0),
    new Answer(0),
    new Wake(),
    new Answer(0),
  ],
  // A, B within one second with no return, and a lagging answer A: the head stays B (E2, E4).
  r5b: [new Push(0, 0), new Push(0, 1), new Deliver(0), new Deliver(0), new Answer(1), new Wake(), new Answer(0)],
};

const corpusShape = new Map<Iterable<Command>, Shape>(SHAPES.map((shape) => [CORPUS[shape], shape]));

// Shapes the generated runs completed (not the corpus's).
const generatedShapes = new Map<Shape, number>(SHAPES.map((shape) => [shape, 0]));

// One run on a fresh session: the commands, then the end.
async function runOracle(cmds: Iterable<Command>, logs: LogEntry[]): Promise<void> {
  runs += 1;
  const stub = await prSessionStub(env, { owner: "octo", repo: "oracle", number: runs });
  await stub.view();
  await runInDurableObject(stub, async (instance, state) => {
    Reflect.set(instance, "env", APP_ENV);
    const seams = prSessionSeams(instance);
    // Wakes are the run's steps: the scheduler runs none in the background.
    vi.spyOn(instance, "schedule").mockResolvedValue({
      id: "oracle",
      callback: "settle",
      payload: undefined,
      time: 0,
      type: "delayed",
      delayInSeconds: 0,
    });
    vi.spyOn(seams, "deliver").mockResolvedValue();
    vi.spyOn(seams, "readPool").mockResolvedValue(true);
    let oracle: Oracle | null = null;
    let real: Real | null = null;
    current = null;
    await fc.asyncModelRun(() => {
      oracle = new Oracle();
      real = new Real(instance, state.storage.sql, logs);
      current = real;
      return { model: oracle, real };
    }, cmds);
    if (oracle === null || real === null) {
      throw new Error("the run was not set up");
    }
    await finish(oracle, real);
    const expected = corpusShape.get(cmds);
    const shapes: Set<Shape> = (oracle as Oracle).shapes;
    if (expected !== undefined) {
      if (!shapes.has(expected)) {
        throw new Error(
          `the corpus case ${expected} did not complete its shape (completed: ${[...shapes].join(", ")})`,
        );
      }
    } else {
      for (const shape of shapes) {
        generatedShapes.set(shape, (generatedShapes.get(shape) ?? 0) + 1);
      }
    }
  });
}

// The run whose reads the fetch spy holds.
let current: Real | null = null;

function serveReads(): void {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && /^\/app\/installations\/[0-9]+\/access_tokens$/.test(pathname)) {
      return Response.json({ token: "ghs_oracle", expires_at: expiresAt, permissions: {} }, { status: 201 });
    }
    if (request.method === "GET" && pathname === "/repos/octo/oracle/pulls/" + String(runs) && current !== null) {
      return current.onRead();
    }
    throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Each test stays well under the default timeout: CI is slower than a laptop.
const BATCHES = 6;
const RUNS_PER_BATCH = 80;
// The batches' seeds: every machine generates the same runs, so the shape check below is the same everywhere. A
// failure prints its seed and path, which replay it.
const SEED = 20_261_117;

describe("head reconciliation against GitHub's truth", () => {
  it("runs the corpus", async () => {
    const logs = captureLogs();
    serveReads();
    await setPool(["laptop"]);
    // fc.assert rejects with the seed, the path and the shrunk steps of a failing run.
    await expect(
      fc.assert(
        fc.asyncProperty(commands, (cmds) => runOracle(cmds, logs)),
        {
          examples: Object.values(CORPUS).map((cmds): [Iterable<Command>] => [cmds]),
          // Examples count among the runs: only the corpus runs here.
          numRuns: Object.keys(CORPUS).length,
        },
      ),
    ).resolves.toBeUndefined();
  });

  for (let batch = 1; batch <= BATCHES; batch += 1) {
    it(`runs generated interleavings, batch ${batch} of ${BATCHES}`, async () => {
      const logs = captureLogs();
      serveReads();
      await setPool(["laptop"]);
      await expect(
        fc.assert(
          fc.asyncProperty(commands, (cmds) => runOracle(cmds, logs)),
          {
            numRuns: RUNS_PER_BATCH,
            seed: SEED + batch,
          },
        ),
      ).resolves.toBeUndefined();
    });
  }

  it("generated every shape of the corpus", () => {
    // The arbitraries stay able to reach what the corpus pins: each shape completed in some generated run.
    expect(SHAPES.filter((shape) => (generatedShapes.get(shape) ?? 0) === 0)).toEqual([]);
  });
});
