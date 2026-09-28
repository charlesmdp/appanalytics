import {
  deriveSubscriptions,
  priceKey,
  type ChargeRow,
  type SaleRow,
} from "../../src/core/subscriptions.js";
import { type App, day } from "./config.js";
import { rows, statement, checkpoint, type Job } from "./store.js";
export interface RawEvent {
  app_id: string;
  shop_id: string;
  type: string;
  occurred_at: string;
  charge_id: string;
  charge_name: string | null;
  charge_amount: number | null;
  charge_currency: string | null;
  charge_test: number;
  billing_on: string | null;
}
export interface Delta {
  date: string;
  currency: string;
  mrr_delta: number;
  paying_delta: number;
}
export function chargeRows(events: RawEvent[]): ChargeRow[] {
  const groups = new Map<string, RawEvent[]>();
  for (const e of events)
    if (e.charge_id) {
      const group = groups.get(e.charge_id) ?? [];
      group.push(e);
      groups.set(e.charge_id, group);
    }
  return [...groups].map(([id, group]) => {
    const activated = group.filter(
      (e) => e.type === "SUBSCRIPTION_CHARGE_ACTIVATED",
    );
    const min = (types: string[]) =>
      group
        .filter((e) => types.includes(e.type))
        .map((e) => e.occurred_at)
        .sort()[0] ?? null;
    const max = (type: string) =>
      group
        .filter((e) => e.type === type)
        .map((e) => e.occurred_at)
        .sort()
        .at(-1) ?? null;
    const value = <K extends keyof RawEvent>(key: K): RawEvent[K] | null => {
      const active = activated.map((e) => e[key]).filter((v) => v !== null);
      const values = active.length
        ? active
        : group.map((e) => e[key]).filter((v) => v !== null);
      return (
        values
          .sort((a, b) =>
            typeof a === "number" && typeof b === "number"
              ? a - b
              : String(a).localeCompare(String(b)),
          )
          .at(-1) ?? null
      );
    };
    return {
      charge_id: id,
      app_id: group[0]!.app_id,
      shop_id: group[0]!.shop_id,
      plan_name: value("charge_name"),
      amount: value("charge_amount"),
      currency: value("charge_currency"),
      is_test: Math.max(...group.map((e) => e.charge_test)),
      accepted_at: min(["SUBSCRIPTION_CHARGE_ACCEPTED"]),
      activated_at: min(["SUBSCRIPTION_CHARGE_ACTIVATED"]),
      canceled_at: min([
        "SUBSCRIPTION_CHARGE_CANCELED",
        "SUBSCRIPTION_CHARGE_EXPIRED",
        "SUBSCRIPTION_CHARGE_DECLINED",
      ]),
      frozen_at: max("SUBSCRIPTION_CHARGE_FROZEN"),
      unfrozen_at: max("SUBSCRIPTION_CHARGE_UNFROZEN"),
      billing_on: value("billing_on"),
    };
  });
}
export function finalUninstall(events: RawEvent[]) {
  const relationships = events
    .filter((e) => e.type.startsWith("RELATIONSHIP_"))
    .sort(
      (a, b) =>
        a.occurred_at.localeCompare(b.occurred_at) ||
        a.type.localeCompare(b.type),
    );
  const last = relationships.at(-1);
  const map = new Map<string, { at: string; type: string }>();
  if (
    last &&
    ["RELATIONSHIP_UNINSTALLED", "RELATIONSHIP_DEACTIVATED"].includes(last.type)
  )
    map.set(`${last.app_id} ${last.shop_id}`, {
      at: last.occurred_at,
      type: last.type,
    });
  return map;
}
/** Sweep every freeze/unfreeze, then fold shop counts. No shop × day expansion. */
export function subscriptionDeltas(
  subs: ReturnType<typeof deriveSubscriptions>,
  events: RawEvent[],
  until: string,
): Delta[] {
  const changes = new Map<
    string,
    Map<string, { money: number; count: number }>
  >();
  const add = (currency: string, at: string, money: number, count: number) => {
    const list = changes.get(currency) ?? new Map();
    const entry = list.get(at) ?? { money: 0, count: 0 };
    entry.money += money;
    entry.count += count;
    list.set(at, entry);
    changes.set(currency, list);
  };
  for (const sub of subs) {
    const start = sub.conversion_at;
    const end = sub.churn_at;
    if (
      sub.is_test ||
      !start ||
      start > until ||
      sub.monthly_amount <= 0 ||
      (end && end <= start)
    )
      continue;
    const currency = sub.currency || "UNKNOWN";
    const freezes = events
      .filter(
        (e) =>
          e.charge_id === sub.charge_id &&
          [
            "SUBSCRIPTION_CHARGE_FROZEN",
            "SUBSCRIPTION_CHARGE_UNFROZEN",
          ].includes(e.type),
      )
      .sort(
        (a, b) =>
          a.occurred_at.localeCompare(b.occurred_at) ||
          a.type.localeCompare(b.type),
      );
    let frozen = false;
    for (const e of freezes)
      if (e.occurred_at <= start)
        frozen = e.type === "SUBSCRIPTION_CHARGE_FROZEN";
    let active = !frozen;
    if (active) add(currency, start, sub.monthly_amount, 1);
    for (const e of freezes) {
      if (
        e.occurred_at <= start ||
        e.occurred_at > until ||
        (end && e.occurred_at >= end)
      )
        continue;
      const next = e.type === "SUBSCRIPTION_CHARGE_UNFROZEN";
      if (next !== active)
        add(
          currency,
          e.occurred_at,
          (next ? 1 : -1) * sub.monthly_amount,
          next ? 1 : -1,
        );
      active = next;
    }
    if (active && end && end <= until)
      add(currency, end, -sub.monthly_amount, -1);
  }
  const result: Delta[] = [];
  for (const [currency, entries] of changes) {
    let count = 0;
    const days = new Map<string, Delta>();
    for (const [at, change] of [...entries].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const before = count > 0;
      count += change.count;
      const after = count > 0;
      const date = day(at);
      const row = days.get(date) ?? {
        date,
        currency,
        mrr_delta: 0,
        paying_delta: 0,
      };
      row.mrr_delta += change.money;
      row.paying_delta += Number(after) - Number(before);
      days.set(date, row);
    }
    result.push(...days.values());
  }
  return result.filter((r) => Math.abs(r.mrr_delta) > 1e-9 || r.paying_delta);
}
export async function shopInputs(db: D1Database, shop: string) {
  const events = await rows<RawEvent>(
    db,
    "SELECT * FROM app_events WHERE shop_id=? ORDER BY occurred_at LIMIT 10001",
    shop,
  );
  if (events.length > 10000)
    throw new Error(
      "Une boutique dépasse 10 000 événements. Traitement spécialisé nécessaire, aucune donnée perdue.",
    );
  const sales = await rows<SaleRow>(
    db,
    `SELECT charge_ref,MIN(created_at) first_sale_at,MAX(created_at) last_sale_at,COUNT(*) paid_sale_count,MAX(billing_interval) billing_interval FROM transactions WHERE shop_id=? AND type='AppSubscriptionSale' AND gross_amount>0 AND charge_ref<>'' GROUP BY charge_ref`,
    shop,
  );
  return { events, charges: chargeRows(events), sales };
}
export async function learnPrices(
  db: D1Database,
  shop: string,
  job: Job,
  budget = 900,
) {
  const { charges, sales } = await shopInputs(db, shop);
  const byRef = new Map(sales.map((s) => [s.charge_ref, s]));
  const writes = [
    statement(db, "DELETE FROM price_hints WHERE shop_id=?", shop),
  ];
  for (const c of charges) {
    const interval = byRef.get(c.charge_id.split("/").pop()!)?.billing_interval;
    if (interval && !c.is_test)
      writes.push(
        statement(
          db,
          "INSERT INTO price_hints VALUES(?,?,?,?,?,?)",
          c.charge_id,
          shop,
          c.plan_name ?? "",
          c.amount ?? 0,
          c.currency ?? "",
          interval,
        ),
      );
  }
  writes.push(
    checkpoint(
      db,
      {
        phase_cursor: shop,
        units_done: job.units_done + 1,
        failures: 0,
        error: null,
      },
      job.lease!,
    ),
  );
  if (writes.length > 900)
    throw new Error(
      "Trop de forfaits sur une seule boutique. Import conservé.",
    );
  if (writes.length + 4 > budget) return 0;
  await db.batch(writes);
  return writes.length + 4;
}
export async function priceBook(db: D1Database, app: App) {
  const prices = await rows<{
    plan_name: string;
    amount: number;
    interval: string;
    variants: number;
  }>(
    db,
    "SELECT plan_name,amount,MIN(interval) interval,COUNT(DISTINCT interval) variants FROM price_hints GROUP BY plan_name,amount ORDER BY plan_name,amount",
  );
  return new Map(
    prices
      .filter((p) => p.variants === 1)
      .map((p) => [priceKey(app.appId, p.plan_name, p.amount), p.interval]),
  );
}
export async function rebuildShop(
  db: D1Database,
  app: App,
  shop: string,
  job: Job,
  prices: Map<string, string>,
  budget = 900,
) {
  const { events, charges, sales } = await shopInputs(db, shop);
  const subs = deriveSubscriptions(
    charges,
    sales,
    finalUninstall(events),
    { churnOnUninstall: true, trialMinGapDays: 2 },
    job.until_at,
    prices,
  );
  const deltas = subscriptionDeltas(subs, events, job.until_at);
  const writes = [
    statement(db, "DELETE FROM shop_deltas WHERE shop_id=?", shop),
    statement(db, "DELETE FROM due_shops WHERE shop_id=?", shop),
  ];
  for (const d of deltas)
    writes.push(
      statement(
        db,
        "INSERT INTO shop_deltas VALUES(?,?,?,?,?)",
        shop,
        d.date,
        d.currency,
        d.mrr_delta,
        d.paying_delta,
      ),
    );
  const due = charges
    .filter(
      (c) =>
        c.billing_on &&
        c.billing_on > job.until_at &&
        !c.canceled_at &&
        !c.is_test,
    )
    .map((c) => c.billing_on!)
    .sort()[0];
  if (due)
    writes.push(statement(db, "INSERT INTO due_shops VALUES(?,?)", shop, due));
  writes.push(
    statement(db, "DELETE FROM dirty_shops WHERE shop_id=?", shop),
    checkpoint(
      db,
      {
        units_done: job.units_done + 1,
        phase_cursor: shop,
        failures: 0,
        error: null,
      },
      job.lease!,
    ),
  );
  if (writes.length > 900)
    throw new Error(
      "Une boutique a trop de changements pour un seul lot. Import conservé.",
    );
  if (writes.length + 4 > budget) return 0;
  await db.batch(writes);
  return writes.length + 4;
}
