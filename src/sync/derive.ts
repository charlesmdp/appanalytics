import { getConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { buildCustomerEvents } from "./events.js";
import { buildReviewEvents } from "../appstore/events.js";
import { matchReviewsToShops } from "../appstore/match.js";

/**
 * Write-time normalization (spec 1.5). The Partner API hands back a stream of
 * lifecycle events and a stream of money; neither is queryable as "state at a
 * date". This module collapses both into two derived tables whose columns are
 * already normalized, so every read-time query is sums and date comparisons.
 *
 * Rebuilt wholesale after each sync. A full rebuild over a Partner-API-sized
 * dataset is seconds, and it means a late-arriving correction flows into all of
 * history automatically rather than needing a patch path.
 */

import {
  deriveSubscriptions,
  type ChargeRow,
  type SaleRow,
} from "../core/subscriptions.js";
export {
  monthlyAmountFor,
  PLAN_CHANGE_WINDOW_SECONDS,
} from "../core/subscriptions.js";
const CANCEL_TYPES = [
  "SUBSCRIPTION_CHARGE_CANCELED",
  "SUBSCRIPTION_CHARGE_EXPIRED",
  "SUBSCRIPTION_CHARGE_DECLINED",
];
const INSTALL_TYPES = ["RELATIONSHIP_INSTALLED", "RELATIONSHIP_REACTIVATED"];
const UNINSTALL_TYPES = [
  "RELATIONSHIP_UNINSTALLED",
  "RELATIONSHIP_DEACTIVATED",
];

function buildSubscriptions(db: Db, now: string): number {
  const { reporting } = getConfig();

  const charges = db
    .prepare(
      `SELECT
         charge_id,
         MIN(app_id) AS app_id,
         MAX(shop_id) AS shop_id,
         COALESCE(
           MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACTIVATED' THEN charge_name END),
           MAX(charge_name)
         ) AS plan_name,
         COALESCE(
           MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACTIVATED' THEN charge_amount END),
           MAX(charge_amount)
         ) AS amount,
         MAX(charge_currency) AS currency,
         MAX(charge_test) AS is_test,
         MIN(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACCEPTED' THEN occurred_at END) AS accepted_at,
         MIN(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACTIVATED' THEN occurred_at END) AS activated_at,
         MIN(CASE WHEN type IN (${CANCEL_TYPES.map(() => "?").join(",")}) THEN occurred_at END) AS canceled_at,
         MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_FROZEN' THEN occurred_at END) AS frozen_at,
         MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_UNFROZEN' THEN occurred_at END) AS unfrozen_at,
         COALESCE(
           MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACTIVATED' THEN billing_on END),
           MAX(billing_on)
         ) AS billing_on
       FROM app_events
       WHERE charge_id <> '' AND type LIKE 'SUBSCRIPTION_CHARGE_%'
       GROUP BY charge_id`,
    )
    .all(...CANCEL_TYPES) as ChargeRow[];

  const sales = db
    .prepare(
      `SELECT charge_ref,
              MIN(created_at) AS first_sale_at,
              MAX(created_at) AS last_sale_at,
              COUNT(*) AS paid_sale_count,
              MAX(billing_interval) AS billing_interval
       FROM transactions
       WHERE type = 'AppSubscriptionSale' AND charge_ref <> '' AND gross_amount > 0
       GROUP BY charge_ref`,
    )
    .all() as SaleRow[];

  /**
   * The uninstall a shop has *not* come back from, per app+shop: the latest
   * uninstall with no later install or reactivation.
   *
   * Only this final uninstall may end a subscription. Merchants routinely
   * uninstall and reinstall while their charge keeps billing, so treating any
   * uninstall as churn silently kills long-running paying customers. A genuine
   * mid-history cancellation still arrives as its own
   * SUBSCRIPTION_CHARGE_CANCELED event and is handled above.
   *
   * Read straight from the events rather than from install_intervals, so an
   * uninstall whose matching install predates SYNC_START_DATE still counts.
   */
  const finalUninstall = new Map<string, { at: string; type: string }>();
  if (reporting.churnOnUninstall) {
    const rows = db
      .prepare(
        `SELECT g.app_id AS app_id, g.shop_id AS shop_id, g.ended_at AS ended_at,
                (SELECT CASE WHEN SUM(t.type = 'RELATIONSHIP_UNINSTALLED') > 0
                             THEN 'RELATIONSHIP_UNINSTALLED'
                             ELSE 'RELATIONSHIP_DEACTIVATED' END
                   FROM app_events t
                  WHERE t.app_id = g.app_id AND t.shop_id = g.shop_id
                    AND t.occurred_at = g.ended_at
                    AND t.type IN (${UNINSTALL_TYPES.map(() => "?").join(",")})) AS ended_by
           FROM (
        SELECT u.app_id AS app_id, u.shop_id AS shop_id, MAX(u.occurred_at) AS ended_at
         FROM app_events u
         WHERE u.type IN (${UNINSTALL_TYPES.map(() => "?").join(",")}) AND u.shop_id <> ''
         GROUP BY u.app_id, u.shop_id
         HAVING MAX(u.occurred_at) > COALESCE((
           SELECT MAX(i.occurred_at) FROM app_events i
           WHERE i.app_id = u.app_id AND i.shop_id = u.shop_id
             AND i.type IN (${INSTALL_TYPES.map(() => "?").join(",")})
         ), '')
         ) g`,
      )
      .all(...UNINSTALL_TYPES, ...UNINSTALL_TYPES, ...INSTALL_TYPES) as Array<{
      app_id: string;
      shop_id: string;
      ended_at: string;
      ended_by: string;
    }>;
    for (const row of rows) {
      finalUninstall.set(`${row.app_id} ${row.shop_id}`, {
        at: row.ended_at,
        // An uninstall and a deactivation stamped at the same instant is the
        // merchant leaving, not the platform closing the shop around them.
        type: row.ended_by,
      });
    }
  }

  const derived = deriveSubscriptions(
    charges,
    sales,
    finalUninstall,
    reporting,
    now,
  );
  type Derived = (typeof derived)[number];

  const statement = db.prepare(
    `INSERT INTO subscriptions (
       charge_id, charge_ref, app_id, shop_id, plan_name, amount, currency,
       billing_interval, monthly_amount, is_test, accepted_at, activated_at,
       conversion_at, churn_at, churn_reason, frozen_at, unfrozen_at,
       trial_started_at, trial_ends_at, trial_status, is_plan_change,
       paid_sale_count, first_sale_at, last_sale_at
     ) VALUES (
       @charge_id, @charge_ref, @app_id, @shop_id, @plan_name, @amount, @currency,
       @billing_interval, @monthly_amount, @is_test, @accepted_at, @activated_at,
       @conversion_at, @churn_at, @churn_reason, @frozen_at, @unfrozen_at,
       @trial_started_at, @trial_ends_at, @trial_status, @is_plan_change,
       @paid_sale_count, @first_sale_at, @last_sale_at
     )`,
  );

  const write = db.transaction((rows: Derived[]) => {
    db.prepare("DELETE FROM subscriptions").run();
    for (const row of rows) {
      statement.run({
        charge_id: row.charge_id,
        charge_ref: row.charge_ref,
        app_id: row.app_id,
        shop_id: row.shop_id,
        plan_name: row.plan_name,
        amount: row.amount ?? 0,
        currency: row.currency,
        billing_interval: row.billing_interval,
        monthly_amount: row.monthly_amount,
        is_test: row.is_test ? 1 : 0,
        accepted_at: row.accepted_at,
        activated_at: row.activated_at,
        conversion_at: row.conversion_at,
        churn_at: row.churn_at,
        churn_reason: row.churn_reason,
        frozen_at: row.frozen_at,
        unfrozen_at: row.unfrozen_at,
        trial_started_at: row.trial_started_at,
        trial_ends_at: row.trial_ends_at,
        trial_status: row.trial_status,
        is_plan_change: row.is_plan_change,
        paid_sale_count: row.paid_sale_count,
        first_sale_at: row.first_sale_at,
        last_sale_at: row.last_sale_at,
      });
    }
  });

  write(derived);
  return derived.length;
}

function buildInstallIntervals(db: Db): number {
  const rows = db
    .prepare(
      `SELECT app_id, shop_id, type, occurred_at
       FROM app_events
       WHERE type IN (${[...INSTALL_TYPES, ...UNINSTALL_TYPES].map(() => "?").join(",")})
         AND shop_id <> ''
       ORDER BY app_id, shop_id, occurred_at`,
    )
    .all(...INSTALL_TYPES, ...UNINSTALL_TYPES) as Array<{
    app_id: string;
    shop_id: string;
    type: string;
    occurred_at: string;
  }>;

  interface Interval {
    app_id: string;
    shop_id: string;
    started_at: string;
    ended_at: string | null;
    /** Which of the two install types opened it. See the schema comment. */
    started_by: "installed" | "reactivated";
  }

  const intervals: Interval[] = [];
  let open: Interval | null = null;
  let currentKey = "";

  for (const row of rows) {
    const key = `${row.app_id}\u0000${row.shop_id}`;
    if (key !== currentKey) {
      if (open) intervals.push(open);
      open = null;
      currentKey = key;
    }

    if (INSTALL_TYPES.includes(row.type)) {
      // Repeat installs without an intervening uninstall keep the first start.
      if (!open) {
        open = {
          app_id: row.app_id,
          shop_id: row.shop_id,
          started_at: row.occurred_at,
          ended_at: null,
          started_by:
            row.type === "RELATIONSHIP_REACTIVATED"
              ? "reactivated"
              : "installed",
        };
      } else if (
        row.type === "RELATIONSHIP_INSTALLED" &&
        open.started_by === "reactivated"
      ) {
        // A real install landing inside an interval a reopening opened. The
        // interval keeps its start — the app has been live since the shop came
        // back — but it stops being attributed to the reopening, because a
        // merchant did choose the app and the funnel should see it.
        open.started_by = "installed";
      }
    } else if (open) {
      open.ended_at = row.occurred_at;
      intervals.push(open);
      open = null;
    }
    // An uninstall with no open interval means the install predates
    // SYNC_START_DATE; there is no start to attribute, so it is dropped.
  }
  if (open) intervals.push(open);

  const statement = db.prepare(
    `INSERT INTO install_intervals (app_id, shop_id, started_at, ended_at, started_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(app_id, shop_id, started_at) DO UPDATE SET
       ended_at = excluded.ended_at,
       started_by = excluded.started_by`,
  );

  const write = db.transaction((batch: Interval[]) => {
    db.prepare("DELETE FROM install_intervals").run();
    for (const interval of batch) {
      statement.run(
        interval.app_id,
        interval.shop_id,
        interval.started_at,
        interval.ended_at,
        interval.started_by,
      );
    }
  });

  write(intervals);
  return intervals.length;
}

export function rebuildDerivedTables(db: Db): {
  subscriptions: number;
  installs: number;
  customerEvents: number;
  reviewEvents: number;
} {
  const now = new Date().toISOString();
  const subscriptions = buildSubscriptions(db, now);
  const installs = buildInstallIntervals(db);
  // Strictly after the subscription index: the lifecycle compiler reads it as
  // the authority on normalized money and on which cancels were plan changes.
  const customerEvents = buildCustomerEvents(db);

  // Reviews come last, and in this order for two reasons: the matcher searches
  // shops that installed the app, which `install_intervals` has only just
  // finished rebuilding, and `buildCustomerEvents` clears the table these are
  // then appended to.
  matchReviewsToShops(db);
  const reviewEvents = buildReviewEvents(db);

  db.prepare("DELETE FROM metric_cache").run();
  return { subscriptions, installs, customerEvents, reviewEvents };
}
