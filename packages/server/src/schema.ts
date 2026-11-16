// Each Durable Object class's schema, as ordered SQL statements. The constructor applies the ones above the version
// stored in prq_schema, all in one transaction, before the object handles any event. Steps are only appended, never
// edited or reordered: the stored version counts the steps already applied. PRAGMA user_version is not used because
// the Agents SDK keeps its own tables (cf_*) in the same database.
type SchemaSteps = readonly string[];

export const HUB_SCHEMA: SchemaSteps = [];

export const PR_SESSION_SCHEMA: SchemaSteps = [];

export function migrate(storage: DurableObjectStorage, steps: SchemaSteps): void {
  storage.transactionSync(() => {
    const { sql } = storage;
    sql.exec("CREATE TABLE IF NOT EXISTS prq_schema (version INTEGER NOT NULL)");
    const stored = sql.exec<{ version: number }>("SELECT version FROM prq_schema").toArray()[0]?.version;
    if (stored === undefined) {
      sql.exec("INSERT INTO prq_schema (version) VALUES (0)");
    }
    for (const [index, step] of steps.entries()) {
      if (index >= (stored ?? 0)) {
        sql.exec(step);
        sql.exec("UPDATE prq_schema SET version = ?", index + 1);
      }
    }
  });
}
