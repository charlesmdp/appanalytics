import { test } from "node:test";
import assert from "node:assert/strict";
import {
  range,
  series,
  summary,
  project,
  analytics,
} from "../src/analytics.js";
import { deriveSubscriptions } from "../../src/core/subscriptions.js";
import {
  chargeRows,
  finalUninstall,
  subscriptionDeltas,
  type RawEvent,
} from "../src/derive.js";
import { testDb } from "./db.js";
import { APPS, type Env } from "../src/config.js";
const now = new Date("2026-03-15T12:00:00Z");
test("calendar months, leap day and 365 complete days", () => {
  assert.deepEqual(range("last_month", "2022-01-21", now), {
    start: "2026-02-01",
    end: "2026-02-28",
    todayPartial: false,
    days: 28,
  });
  assert.equal(
    range("last_month", "2022-01-21", new Date("2024-03-02")).days,
    29,
  );
  assert.equal(range("last_365_days", "2022-01-21", now).days, 365);
  assert.equal(range("last_30_days", "2022-01-21", now).end, "2026-03-14");
  assert.equal(range("current_month", "2022-01-21", now).todayPartial, true);
  assert.throws(() =>
    range("custom", "2022-01-21", now, "2026-03-20", "2026-03-25"),
  );
});
test("MRR baseline survives a selected window; currencies never mix", () => {
  const empty = {
    paying_delta: 0,
    installs: 0,
    uninstalls: 0,
    reactivations: 0,
    deactivations: 0,
    gross: 0,
    net: 0,
  };
  const s = series(
    [
      { ...empty, date: "2026-01-01", currency: "USD", mrr_delta: 120 },
      { ...empty, date: "2026-02-02", currency: "USD", mrr_delta: -20 },
      { ...empty, date: "2026-02-02", currency: "EUR", mrr_delta: 900 },
      { ...empty, date: "2026-02-02", currency: "", mrr_delta: 0, installs: 4 },
    ],
    "2026-02-01",
    "2026-02-03",
    "USD",
  );
  assert.deepEqual(
    s.points.map((p) => p.mrr),
    [120, 100, 100],
  );
  assert.equal(summary(s.points, s.baseline).mrrChange, -20);
  assert.equal(s.points[1]!.installs, 4);
  assert.equal(summary(s.points, { mrr: 0, paying: 0 }).mrrGrowth, null);
});
const event = (
  type: string,
  at: string,
  extra: Partial<RawEvent> = {},
): RawEvent => ({
  app_id: "6922231",
  shop_id: "shop-1",
  type,
  occurred_at: `2026-01-${at}T00:00:00.000Z`,
  charge_id: "gid://partners/Charge/1",
  charge_name: "Pro",
  charge_amount: 120,
  charge_currency: "USD",
  charge_test: 0,
  billing_on: "2026-02-01T00:00:00.000Z",
  ...extra,
});
test("annual MRR, repeat freezes, plan changes and unique paying shop", () => {
  const events = [
    event("SUBSCRIPTION_CHARGE_ACTIVATED", "01"),
    event("SUBSCRIPTION_CHARGE_FROZEN", "05"),
    event("SUBSCRIPTION_CHARGE_UNFROZEN", "10"),
    event("SUBSCRIPTION_CHARGE_FROZEN", "15"),
    event("SUBSCRIPTION_CHARGE_UNFROZEN", "20"),
    event("SUBSCRIPTION_CHARGE_CANCELED", "25"),
    event("SUBSCRIPTION_CHARGE_ACTIVATED", "25", {
      charge_id: "gid://partners/Charge/2",
      charge_amount: 240,
    }),
  ];
  const sales = [
    {
      charge_ref: "1",
      first_sale_at: "2026-01-01T00:00:00.000Z",
      last_sale_at: "2026-01-01T00:00:00.000Z",
      paid_sale_count: 1,
      billing_interval: "ANNUAL",
    },
    {
      charge_ref: "2",
      first_sale_at: "2026-01-25T00:00:00.000Z",
      last_sale_at: "2026-01-25T00:00:00.000Z",
      paid_sale_count: 1,
      billing_interval: "ANNUAL",
    },
  ];
  const subs = deriveSubscriptions(
    chargeRows(events),
    sales,
    finalUninstall(events),
    { churnOnUninstall: true, trialMinGapDays: 2 },
    "2026-02-01T00:00:00.000Z",
  );
  const d = subscriptionDeltas(subs, events, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(
    d.map((x) => x.mrr_delta),
    [10, -10, 10, -10, 10, 10],
  );
  assert.deepEqual(
    d.map((x) => x.paying_delta),
    [1, -1, 1, -1, 1, 0],
  );
  assert.equal(subs[0]!.is_plan_change, 1);
});
test("trial cancelled before first payment contributes no MRR", () => {
  const events = [
    event("SUBSCRIPTION_CHARGE_ACTIVATED", "01", {
      billing_on: "2026-01-14T00:00:00.000Z",
    }),
    event("SUBSCRIPTION_CHARGE_CANCELED", "07"),
  ];
  const s = deriveSubscriptions(
    chargeRows(events),
    [],
    finalUninstall(events),
    { churnOnUninstall: true, trialMinGapDays: 2 },
    "2026-02-01T00:00:00.000Z",
  );
  assert.deepEqual(
    subscriptionDeltas(s, events, "2026-02-01T00:00:00.000Z"),
    [],
  );
});
test("delta replacement is atomic, idempotent and updates history", async () => {
  const { db } = testDb();
  await db
    .prepare("INSERT INTO shop_deltas VALUES(?,?,?,?,?)")
    .bind("s", "2026-01-01", "USD", 100, 1)
    .run();
  for (let i = 0; i < 2; i++)
    await db.batch([
      db.prepare("DELETE FROM shop_deltas WHERE shop_id=?").bind("s"),
      db
        .prepare("INSERT INTO shop_deltas VALUES(?,?,?,?,?)")
        .bind("s", "2026-01-01", "USD", 120, 1),
    ]);
  assert.equal(
    await db.prepare("SELECT mrr_delta FROM daily").first("mrr_delta"),
    120,
  );
  await assert.rejects(
    db.batch([
      db.prepare("DELETE FROM shop_deltas"),
      db.prepare("INSERT INTO nonexistent VALUES(1)"),
    ]),
  );
  assert.equal(
    await db.prepare("SELECT mrr_delta FROM daily").first("mrr_delta"),
    120,
  );
});
test("transaction replays do not double revenue and corrections replace amounts", async () => {
  const { db } = testDb();
  const sql =
    "INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET gross_amount=excluded.gross_amount,net_amount=excluded.net_amount";
  for (const amount of [10, 10, 15])
    await db
      .prepare(sql)
      .bind(
        "t",
        "AppSubscriptionSale",
        "app",
        "shop",
        "charge",
        "2026-01-01T00:00:00.000Z",
        "EVERY_30_DAYS",
        amount,
        amount,
        "USD",
      )
      .run();
  assert.equal(await db.prepare("SELECT gross FROM daily").first("gross"), 15);
});
test("scenarios hold stable, decrease to zero, and compound explicit rates", () => {
  assert.equal(project(100, { monthlyGrowth: 0, months: 12 }).at(-1)!.mrr, 100);
  assert.equal(
    project(100, { monthlyGrowth: -100, months: 12 }).at(-1)!.mrr,
    0,
  );
  assert.ok(
    Math.abs(
      project(100, { monthlyGrowth: 5, months: 12 }).at(-1)!.mrr - 179.5856326,
    ) < 0.001,
  );
  assert.throws(() => project(100, { monthlyGrowth: Infinity, months: 12 }));
});
test("portfolio adds two isolated databases and forecast ignores historical selector", async () => {
  const one = testDb(),
    two = testDb();
  for (const [db, value] of [
    [one.db, 100],
    [two.db, 200],
  ] as const) {
    await db
      .prepare(
        "UPDATE job SET status='complete',last_success='2026-03-15T12:00:00.000Z'",
      )
      .run();
    await db
      .prepare("INSERT INTO shop_deltas VALUES(?,?,?,?,?)")
      .bind("same-shop", "2026-01-01", "USD", value, 1)
      .run();
    await db
      .prepare("INSERT INTO shop_deltas VALUES(?,?,?,?,?)")
      .bind("same-shop", "2026-03-01", "USD", 50, 0)
      .run();
  }
  const env = { BIG_DOWNLOAD_DB: one.db, COWLENDAR_DB: two.db } as Env;
  const result = await analytics(
    env,
    new URLSearchParams({ period: "last_month" }),
    now,
  );
  assert.equal(result.summary.mrr, 300);
  assert.equal(result.forecast.mrr, 400);
  assert.equal(result.summary.paying, 2);
  assert.equal(result.complete, true);
});
