import { test } from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./db.js";
import { ensureSchema } from "../src/bootstrap.js";
import { login, authorized } from "../src/auth.js";
import type { Env } from "../src/config.js";

test("empty databases initialise automatically, including complete SQL triggers", async () => {
  const { db, sqlite } = testDb(false);
  await Promise.all([ensureSchema(db), ensureSchema({ ...db })]);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM _penida_schema").get().n,
    2,
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM job").get().n, 1);
  sqlite
    .prepare("INSERT INTO shop_deltas VALUES('s','2026-01-01','USD',29,1)")
    .run();
  assert.equal(
    sqlite.prepare("SELECT mrr_delta FROM daily").get().mrr_delta,
    29,
  );
  await ensureSchema({ ...db });
  assert.equal(
    sqlite.prepare("SELECT mrr_delta FROM daily").get().mrr_delta,
    29,
  );
});

test("existing imported data survives migration from the manual installation", async () => {
  const { db, sqlite } = testDb();
  sqlite.prepare("UPDATE job SET records=91234,status='complete'").run();
  await ensureSchema(db);
  assert.equal(sqlite.prepare("SELECT records FROM job").get().records, 91234);
  assert.equal(
    sqlite.prepare("SELECT status FROM job").get().status,
    "complete",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM auth_settings").get().n,
    0,
  );
});

test("a failed initialisation can retry on the next request", async () => {
  const { db, sqlite } = testDb(false);
  let fail = true;
  const wrapper = {
    ...db,
    batch: async (statements: D1PreparedStatement[]) => {
      if (fail) {
        fail = false;
        throw new Error("temporary unavailable");
      }
      return db.batch(statements);
    },
  } as D1Database;
  await assert.rejects(ensureSchema(wrapper), /temporary unavailable/);
  await ensureSchema(wrapper);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM job").get().n, 1);
});

test("session key is generated once; only a dashboard password is required", async () => {
  const { db, sqlite } = testDb(false);
  const env = {
    BIG_DOWNLOAD_DB: db,
    DASHBOARD_PASSWORD: "a-long-unique-password",
  } as Env;
  const request = () =>
    new Request("https://test/api/login", {
      method: "POST",
      body: JSON.stringify({ password: env.DASHBOARD_PASSWORD }),
    });
  const response = await login(request(), env);
  assert.equal(response.status, 200);
  const original = sqlite
    .prepare("SELECT value FROM auth_settings WHERE key='session_key'")
    .get().value;
  assert.equal(original.length, 43);
  const cookie = response.headers.get("set-cookie")!;
  assert.ok(
    await authorized(
      new Request("https://test/api/status", { headers: { cookie } }),
      { ...env, BIG_DOWNLOAD_DB: { ...db } },
    ),
  );
  await login(request(), { ...env });
  assert.equal(
    sqlite
      .prepare("SELECT value FROM auth_settings WHERE key='session_key'")
      .get().value,
    original,
  );
  assert.equal(
    await authorized(
      new Request("https://test/api/status", { headers: { cookie } }),
      { ...env, DASHBOARD_PASSWORD: "changed-long-password" },
    ),
    false,
  );
  assert.equal(
    (await login(request(), { ...env, DASHBOARD_PASSWORD: "" })).status,
    503,
  );
});
