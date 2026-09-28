import SQLite from "better-sqlite3";
import { readFileSync } from "node:fs";
export function testDb(preload = true) {
  const sqlite = new SQLite(":memory:");
  if (preload)
    sqlite.exec(
      readFileSync(
        new URL("../migrations/0001_analytics.sql", import.meta.url),
        "utf8",
      ),
    );
  class Prepared {
    constructor(
      public sql: string,
      public values: unknown[] = [],
    ) {
      if (values.length > 100)
        throw new Error("D1 maximum 100 bound parameters");
    }
    bind(...values: unknown[]) {
      return new Prepared(this.sql, values);
    }
    async first(column?: string) {
      const row = sqlite.prepare(this.sql).get(...this.values) as any;
      return (column ? row?.[column] : row) ?? null;
    }
    async all() {
      return {
        results: sqlite.prepare(this.sql).all(...this.values),
        success: true,
      };
    }
    async run() {
      const r = sqlite.prepare(this.sql).run(...this.values);
      return { success: true, meta: { changes: r.changes } };
    }
  }
  const db = {
    prepare: (sql: string) => new Prepared(sql),
    batch: async (statements: Prepared[]) =>
      sqlite.transaction(() =>
        statements.map((s) => {
          const p = sqlite.prepare(s.sql);
          if (p.reader)
            return {
              success: true,
              results: p.all(...s.values),
              meta: { changes: 0 },
            };
          const r = p.run(...s.values);
          return { success: true, meta: { changes: r.changes } };
        }),
      )(),
  } as unknown as D1Database;
  return { db, sqlite };
}
