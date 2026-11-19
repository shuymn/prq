// The ledger reader's generations (plan §1.5): what a superseded pass or continuation brings is discarded, even when it
// arrives after its abort, and the query a filter makes is the protocol's.

import { LedgerRow } from "@prq/protocol";
import * as v from "valibot";
import { describe, expect, test } from "vitest";

import { LedgerReader, ledgerSearch } from "./ledger.ts";
import { controlledFetch, settled } from "./test/fetch.ts";

const row = (number: number) =>
  v.parse(LedgerRow, {
    pr: { owner: "shuymn", repo: "prq", number },
    details: null,
    owner: "local",
    latestEvent: null,
    problem: null,
    jobs: { waiting: 0, running: 0, failed: 0 },
    claims: [],
  });

const page = (numbers: number[], nextCursor: string | null = null) => ({ rows: numbers.map(row), nextCursor });
const numbers = (reader: LedgerReader) => reader.snapshot().rows?.map((r) => r.pr.number) ?? null;

const OPEN = { attention: false, state: "open", repo: null } as const;
const hub = (ledgerVersion: number) => ({ view: { ledgerVersion, localAgentPresent: false }, opens: 1 });

describe("the ledger reader", () => {
  test("never writes a superseded pass's rows, whenever they arrive", async () => {
    const fetch = controlledFetch();
    const reader = new LedgerReader(fetch.fetch, OPEN);
    reader.start(hub(1));
    const first = await fetch.request(0);
    reader.hubChanged(hub(2));
    const second = await fetch.request(1);
    expect(first.signal.aborted).toBe(true);

    first.respond(page([1]));
    await settled();
    expect(reader.snapshot().rows).toBeNull();
    second.respond(page([2]));
    await settled();
    expect(numbers(reader)).toEqual([2]);

    // And one superseded after the rows it would replace arrived.
    reader.hubChanged(hub(3));
    const third = await fetch.request(2);
    reader.hubChanged(hub(4));
    (await fetch.request(3)).respond(page([4]));
    await settled();
    third.respond(page([3]));
    await settled();
    expect(numbers(reader)).toEqual([4]);
  });

  test("never appends a superseded continuation's page", async () => {
    const fetch = controlledFetch();
    const reader = new LedgerReader(fetch.fetch, OPEN);
    reader.start(hub(1));
    (await fetch.request(0)).respond(page([1], "c1"));
    await settled();
    reader.loadMore();
    const next = await fetch.request(1);
    expect(reader.snapshot().loadingMore).toBe(true);

    reader.hubChanged(hub(2));
    expect(reader.snapshot().loadingMore).toBe(false);
    next.respond(page([9]));
    await settled();
    expect(numbers(reader)).toEqual([1]);
    expect(reader.snapshot().loadingMore).toBe(false);
  });

  test("discards what arrives after it stops", async () => {
    const fetch = controlledFetch();
    const reader = new LedgerReader(fetch.fetch, OPEN);
    reader.start(hub(1));
    const first = await fetch.request(0);
    reader.stop();
    expect(first.signal.aborted).toBe(true);
    first.respond(page([1]));
    await settled();
    expect(reader.snapshot().rows).toBeNull();
  });
});

describe("the ledger's query", () => {
  test("asks for attention alone", () => {
    expect(ledgerSearch({ attention: "1" })).toBe("attention=1");
    expect(ledgerSearch({ state: "all", repo: "shuymn/prq", cursor: "c1" })).toBe(
      "state=all&repo=shuymn%2Fprq&cursor=c1",
    );
    // @ts-expect-error The protocol refuses attention with a state.
    ledgerSearch({ attention: "1", state: "open" });
    // @ts-expect-error The protocol refuses attention with a repository.
    ledgerSearch({ attention: "1", repo: "shuymn/prq" });
  });
});
