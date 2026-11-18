import { LedgerPage, sessionName } from "@prq/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { hubStub, prSessionStub } from "./names.ts";
import { HUB_SCHEMA, migrate, PR_SESSION_SCHEMA } from "./schema.ts";

function versions(storage: DurableObjectStorage): unknown[] {
  return storage.sql.exec("SELECT version FROM prq_schema").toArray();
}

describe("schema", () => {
  it("brings a new Hub and a new PrSession to their current version", async () => {
    const hub = await runInDurableObject(await hubStub(env), (_, state) => versions(state.storage));
    const session = await runInDurableObject(
      await prSessionStub(env, { owner: "octo", repo: "schema", number: 1 }),
      (_, state) => versions(state.storage),
    );
    expect({ hub, session }).toEqual({
      hub: [{ version: HUB_SCHEMA.length }],
      session: [{ version: PR_SESSION_SCHEMA.length }],
    });
  });

  it("adds the ledger to a Hub from before it, keeping its counter, its pool and its queue", async () => {
    const stub = await hubStub(env);
    await runInDurableObject(stub, (_, { storage }) => {
      const { sql } = storage;
      // The database as the version before the ledger left it, with an agent and a queued session.
      const tables = [
        "prq_schema",
        "prq_hub",
        "prq_agents",
        "prq_notifications",
        "prq_ledger",
        "prq_claims",
        "prq_repos",
        "prq_ledger_totals",
      ];
      for (const table of tables) {
        sql.exec(`DROP TABLE ${table}`);
      }
      migrate(
        storage,
        HUB_SCHEMA.slice(
          0,
          HUB_SCHEMA.findIndex((step) => step.includes("prq_ledger")),
        ),
      );
      sql.exec("UPDATE prq_hub SET gen = 41");
      sql.exec("INSERT INTO prq_agents (agent_id, last_seen_at) VALUES ('laptop', 5)");
      sql.exec("INSERT INTO prq_notifications (session, gen, notified_at) VALUES ('octo~schema~9', 41, 6)");

      migrate(storage, HUB_SCHEMA);

      expect(versions(storage)).toEqual([{ version: HUB_SCHEMA.length }]);
      expect(sql.exec("SELECT id, gen FROM prq_hub").toArray()).toEqual([{ id: 1, gen: 41 }]);
      expect(sql.exec("SELECT agent_id, last_seen_at FROM prq_agents").toArray()).toEqual([
        { agent_id: "laptop", last_seen_at: 5 },
      ]);
      expect(sql.exec("SELECT session, gen, notified_at FROM prq_notifications").toArray()).toEqual([
        { session: "octo~schema~9", gen: 41, notified_at: 6 },
      ]);
      expect(sql.exec("SELECT * FROM prq_ledger_totals").toArray()).toEqual([
        {
          id: 1,
          version: 0,
          attention_present: 0,
          attention_absent: 0,
          jobs_waiting: 0,
          jobs_running: 0,
          jobs_failed: 0,
          owners: 0,
        },
      ]);
    });

    // The migrated Hub stores an entry, counts it and pages it.
    await stub.upsertLedger("octo~schema~9", 1, {
      details: null,
      owner: "local",
      latestEvent: { kind: "question", at: 7 },
      summaryFailed: false,
      answerFailed: true,
      stalled: false,
      waitingWork: true,
      unsummarized: false,
      jobs: { waiting: 1, running: 0, failed: 1 },
      claims: [],
    });
    expect(await stub.view()).toEqual({
      localAgentPresent: false,
      presentAgents: 0,
      jobs: { waiting: 1, running: 0, failed: 1 },
      needsAttention: 1,
      owners: 1,
      ledgerVersion: 1,
    });
    for (const query of [{ attention: "1" }, { state: "open", repo: "octo/schema" }] as const) {
      const page = v.parse(LedgerPage, await stub.ledgerPage(query));
      expect(page.rows.map((row) => [sessionName(row.pr), row.problem])).toEqual([["octo~schema~9", "answer_failed"]]);
    }
    expect(await stub.repoPage()).toEqual({ rows: [{ fullName: "octo/schema" }], nextCursor: null });
  });

  it("adds a pull request's details and the webhook inbox to a session from before them, keeping its owner and jobs", async () => {
    const stub = await prSessionStub(env, { owner: "octo", repo: "schema", number: 3 });
    await runInDurableObject(stub, (_, { storage }) => {
      const { sql } = storage;
      // The database as the version before the details left it.
      const tables = [
        "prq_schema",
        "prq_session",
        "prq_jobs",
        "prq_outbox",
        "prq_intake",
        "prq_claim_attempts",
        "prq_inbox",
        "prq_stalls",
        "prq_job_usage",
        "prq_notes",
      ];
      for (const table of tables) {
        sql.exec(`DROP TABLE ${table}`);
      }
      migrate(
        storage,
        PR_SESSION_SCHEMA.slice(0, PR_SESSION_SCHEMA.indexOf("ALTER TABLE prq_session ADD COLUMN head_sha TEXT")),
      );
      sql.exec("UPDATE prq_session SET owner = 'local'");
      sql.exec(`INSERT INTO prq_jobs (job_id, kind, target, state, created_at, updated_at)
        VALUES ('job', 'answer', 'q1', 'pending', 1, 1)`);

      migrate(storage, PR_SESSION_SCHEMA);

      expect(versions(storage)).toEqual([{ version: PR_SESSION_SCHEMA.length }]);
      expect(
        sql.exec("SELECT owner, head_sha, title, pr_state, head_at, details_at FROM prq_session").toArray(),
      ).toEqual([{ owner: "local", head_sha: null, title: null, pr_state: null, head_at: null, details_at: null }]);
      expect(sql.exec("SELECT count(*) AS rows FROM prq_inbox").one()).toEqual({ rows: 0 });
      expect(sql.exec("SELECT job_id, state, rev, run FROM prq_jobs").toArray()).toEqual([
        { job_id: "job", state: "pending", rev: 0, run: 1 },
      ]);
      expect(() => sql.exec("UPDATE prq_session SET pr_state = 'draft'")).toThrow(/CHECK/);
    });
  });

  it("adds the ledger's columns and outbox kind to a session from before them, keeping its outbox row and failures", async () => {
    const stub = await prSessionStub(env, { owner: "octo", repo: "schema", number: 4 });
    await runInDurableObject(stub, (_, { storage }) => {
      const { sql } = storage;
      // The database as the version before the ledger left it.
      const tables = [
        "prq_schema",
        "prq_session",
        "prq_jobs",
        "prq_outbox",
        "prq_intake",
        "prq_claim_attempts",
        "prq_inbox",
        "prq_stalls",
        "prq_job_usage",
        "prq_notes",
      ];
      for (const table of tables) {
        sql.exec(`DROP TABLE ${table}`);
      }
      migrate(
        storage,
        PR_SESSION_SCHEMA.slice(
          0,
          PR_SESSION_SCHEMA.findIndex((step) => step.includes("latest_event_kind")),
        ),
      );
      sql.exec("INSERT INTO prq_outbox (kind, gen) VALUES ('notify', 7)");
      sql.exec(`INSERT INTO prq_jobs (job_id, kind, target, state, failure, created_at, updated_at)
        VALUES ('failed', 'answer', 'q1', 'failed', 'cloud agent not configured', 1, 1),
               ('pending', 'answer', 'q2', 'pending', NULL, 1, 1)`);

      migrate(storage, PR_SESSION_SCHEMA);

      expect(versions(storage)).toEqual([{ version: PR_SESSION_SCHEMA.length }]);
      expect(sql.exec("SELECT kind, gen FROM prq_outbox").toArray()).toEqual([{ kind: "notify", gen: 7 }]);
      sql.exec("INSERT INTO prq_outbox (kind, gen) VALUES ('ledger', 8)");
      expect(() => sql.exec("INSERT INTO prq_outbox (kind, gen) VALUES ('other', 9)")).toThrow(/CHECK/);
      expect(sql.exec("SELECT job_id, unresolved_failure FROM prq_jobs ORDER BY job_id").toArray()).toEqual([
        { job_id: "failed", unresolved_failure: 1 },
        { job_id: "pending", unresolved_failure: 0 },
      ]);
      expect(sql.exec("SELECT latest_event_kind, latest_event_at FROM prq_session").toArray()).toEqual([
        { latest_event_kind: null, latest_event_at: null },
      ]);
    });
  });

  it("applies each step once, in order, and leaves the version where a failed step started", async () => {
    const stub = await prSessionStub(env, { owner: "octo", repo: "schema", number: 2 });
    await runInDurableObject(stub, (_, { storage }) => {
      // From a database no step has been applied to.
      storage.sql.exec("DROP TABLE prq_schema");
      const rows = () => storage.sql.exec("SELECT x FROM steps ORDER BY rowid").toArray();
      const steps = ["CREATE TABLE steps (x INTEGER)", "INSERT INTO steps VALUES (1)"];

      migrate(storage, steps);
      expect({ versions: versions(storage), rows: rows() }).toEqual({ versions: [{ version: 2 }], rows: [{ x: 1 }] });

      migrate(storage, [...steps, "INSERT INTO steps VALUES (2)"]);
      expect({ versions: versions(storage), rows: rows() }).toEqual({
        versions: [{ version: 3 }],
        rows: [{ x: 1 }, { x: 2 }],
      });

      const failing = [
        ...steps,
        "INSERT INTO steps VALUES (2)",
        "INSERT INTO steps VALUES (3)",
        "INSERT INTO missing VALUES (1)",
      ];
      expect(() => migrate(storage, failing)).toThrow(/missing/);
      expect({ versions: versions(storage), rows: rows() }).toEqual({
        versions: [{ version: 3 }],
        rows: [{ x: 1 }, { x: 2 }],
      });
    });
  });
});
