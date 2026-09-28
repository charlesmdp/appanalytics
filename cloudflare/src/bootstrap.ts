import { migrations } from "./schema-migrations.js";

const ready = new WeakMap<D1Database, Promise<void>>();

async function migrate(db: D1Database) {
  const exists = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_penida_schema'",
    )
    .first();
  const applied = exists
    ? new Set(
        (
          await db
            .prepare("SELECT name FROM _penida_schema")
            .all<{ name: string }>()
        ).results.map((row) => row.name),
      )
    : new Set<string>();
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    // D1 batch is transactional. Initial migrations are idempotent so concurrent
    // first requests never leave a half-created database or reset imported data.
    await db.batch([
      db.prepare(
        "CREATE TABLE IF NOT EXISTS _penida_schema(name TEXT PRIMARY KEY) WITHOUT ROWID",
      ),
      ...migration.statements.map((sql) => db.prepare(sql)),
      db
        .prepare("INSERT OR IGNORE INTO _penida_schema(name) VALUES(?)")
        .bind(migration.name),
    ]);
  }
}

export function ensureSchema(db: D1Database): Promise<void> {
  let promise = ready.get(db);
  if (!promise) {
    promise = migrate(db).catch((error) => {
      ready.delete(db);
      throw error;
    });
    ready.set(db, promise);
  }
  return promise;
}
