import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
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
