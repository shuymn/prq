// The view's counts against a recount of every ledger row. The recount reads the whole ledger, so these tests have a
// file, and the Hub's storage, of their own: the thousands of rows the paging tests of src/hub-ledger.test.ts leave
// would make each recount read them all.

import type { JobCounts, LedgerRow } from "@prq/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { needsAttention } from "./ledger.ts";
import { captureLogs } from "./test/access.ts";
import { hub, ledgerRows, quiet, setPool } from "./test/session.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function jobCounts(waiting: number, running: number, failed: number): JobCounts {
  return { waiting, running, failed };
}

// The jobs of every row, added up.
function jobTotals(rows: readonly LedgerRow[]): JobCounts {
  return rows.reduce(
    (sum, { jobs }) => ({
      waiting: sum.waiting + jobs.waiting,
      running: sum.running + jobs.running,
      failed: sum.failed + jobs.failed,
    }),
    { waiting: 0, running: 0, failed: 0 },
  );
}

// The rows needing attention as their problems say.
async function attentionRows(): Promise<number> {
  return (await ledgerRows()).filter((row) => needsAttention(row.problem)).length;
}

describe("view counts", () => {
  it("keeps the needs-attention count, with a local agent present and without one, and the job counts as entries change", async () => {
    captureLogs();
    const stub = await hub();
    const check = async () => {
      await setPool([]);
      expect((await stub.view()).needsAttention).toBe(await attentionRows());
      await setPool(["desk"]);
      expect((await stub.view()).needsAttention).toBe(await attentionRows());
      expect((await stub.view()).jobs).toEqual(jobTotals(await ledgerRows()));
    };
    await stub.upsertLedger("octo~count~1", 1, quiet({ answerFailed: true, jobs: jobCounts(0, 0, 2) }));
    await stub.upsertLedger("octo~count~2", 1, quiet({ waitingWork: true, jobs: jobCounts(3, 0, 0) }));
    await stub.upsertLedger("octo~count~3", 1, quiet({ unsummarized: true, jobs: jobCounts(0, 1, 0) }));
    await stub.upsertLedger("octo~count~4", 1, quiet({ stalled: true, waitingWork: true, jobs: jobCounts(1, 1, 0) }));
    await check();
    // A row resolved, a row that fails, and a redelivery that changes nothing.
    await stub.upsertLedger("octo~count~1", 2, quiet({ jobs: jobCounts(0, 1, 0) }));
    await stub.upsertLedger("octo~count~3", 2, quiet({ summaryFailed: true, jobs: jobCounts(0, 0, 1) }));
    await stub.upsertLedger("octo~count~4", 1, quiet());
    await check();
  });
});
