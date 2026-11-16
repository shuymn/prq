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
