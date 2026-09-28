import { getDb, type Db } from './db/index.js';
import { monthlyAmountFor } from './sync/derive.js';
import { mrrAt } from './metrics/asof.js';
import { resolveScopedAppIds } from './sync/index.js';
import { addDays } from './metrics/time.js';
import { getConfig } from './config.js';

/**
 * Trust checks (spec 6).
 *
 * Because no figure is stored and every series is recomputed from raw events,
 * the numbers can drift without anything visibly breaking. These checks make
 * drift loud: they re-derive the index from its sources, and they compare
 * today's view of the past against yesterday's.
 */

export type Severity = 'low' | 'high';

export interface Finding {
  check: string;
  severity: Severity;
  message: string;
  detail?: Record<string, unknown>;
}

/** Absolute epsilon alongside the percentage, so float noise is not a finding. */
const MONEY_EPSILON = 0.01;
const HIGH_MONEY_DELTA = 1;
const DRIFT_THRESHOLD = 0.01;
const DRIFT_HIGH_THRESHOLD = 0.05;

/**
 * Source to index consistency: recompute each subscription's normalized monthly
 * amount straight from the raw feeds and diff it against the derived table. A
 * mismatch means the derivation and the sources have come apart.
 */
export function checkSourceConsistency(db: Db): Finding[] {
  const findings: Finding[] = [];

  const rows = db
    .prepare(
      `SELECT s.charge_id       AS chargeId,
              s.monthly_amount  AS storedMonthly,
              s.billing_interval AS storedInterval,
              s.amount          AS storedAmount,
              (SELECT COALESCE(
                 MAX(CASE WHEN e.type = 'SUBSCRIPTION_CHARGE_ACTIVATED' THEN e.charge_amount END),
                 MAX(e.charge_amount))
               FROM app_events e WHERE e.charge_id = s.charge_id) AS sourceAmount,
              (SELECT MAX(t.billing_interval)
               FROM transactions t
               WHERE t.charge_ref = s.charge_ref AND t.type = 'AppSubscriptionSale'
                 AND t.gross_amount > 0) AS sourceInterval
       FROM subscriptions s`,
    )
    .all() as Array<{
    chargeId: string;
    storedMonthly: number;
    storedInterval: string;
    storedAmount: number;
    sourceAmount: number | null;
    sourceInterval: string | null;
  }>;

  let mismatched = 0;
  let worst = 0;
  /**
   * A stored cadence the sources actively contradict. Kept apart from the amount
   * diff because only a settled sale states a cadence at all: where the sale has
   * not landed yet, `derive.ts` infers one, and re-deriving it here would only
   * restate the inference rather than test it. Silence about an interval the
   * sources never gave is honest; disagreement with one they did give is not.
   */
  let contradicted = 0;

  for (const row of rows) {
    if (row.sourceInterval && row.sourceInterval !== row.storedInterval) contradicted += 1;
    const expectedMonthly = monthlyAmountFor(row.sourceAmount ?? 0, row.storedInterval);
    const delta = Math.abs(expectedMonthly - row.storedMonthly);
    if (delta > MONEY_EPSILON) {
      mismatched += 1;
      worst = Math.max(worst, delta);
    }
  }

  if (mismatched > 0) {
    findings.push({
      check: 'source_consistency',
      severity: worst > HIGH_MONEY_DELTA ? 'high' : 'low',
      message: `${mismatched} subscription(s) disagree with their source events on normalized monthly amount.`,
      detail: { mismatched, worstDelta: Math.round(worst * 100) / 100, total: rows.length },
    });
  }

  if (contradicted > 0) {
    findings.push({
      check: 'billing_interval_consistency',
      severity: 'high',
      message: `${contradicted} subscription(s) are stored at a billing interval their settled sales contradict.`,
      detail: { contradicted, total: rows.length },
    });
  }

  // Subscriptions gated into MRR must have an activation to be gated on.
  const orphans = db
    .prepare(
      `SELECT COUNT(*) AS n FROM subscriptions
       WHERE conversion_at IS NOT NULL AND activated_at IS NULL`,
    )
    .get() as { n: number };
  if (orphans.n > 0) {
    findings.push({
      check: 'source_consistency',
      severity: 'high',
      message: `${orphans.n} subscription(s) count toward MRR but have no activation event.`,
      detail: { count: orphans.n },
    });
  }

  return findings;
}

/**
 * Cross-check: the reconstructed MRR at the latest instant must equal a direct
 * sum over the same contributing rows. Both sides deliberately use the shared
 * predicate, so this catches a broken composition rather than a broken filter.
 */
export function checkTotalsCrossFoot(db: Db): Finding[] {
  const appIds = resolveScopedAppIds(db);
  const { reporting } = getConfig();
  const now = new Date();

  const viaPredicate = mrrAt(db, now, {
    appIds,
    includeAnnual: reporting.includeAnnual,
    includeTrials: reporting.includeTrials,
  });

  const placeholders = appIds.map(() => '?').join(',');
  const direct = db
    .prepare(
      `SELECT COALESCE(SUM(monthly_amount), 0) AS value
       FROM subscriptions
       WHERE is_test = 0
         ${appIds.length > 0 ? `AND app_id IN (${placeholders})` : ''}
         AND conversion_at IS NOT NULL AND conversion_at <= ?
         AND (churn_at IS NULL OR churn_at > ?)
         AND NOT (frozen_at IS NOT NULL AND frozen_at <= ?
                  AND (unfrozen_at IS NULL OR unfrozen_at <= frozen_at OR unfrozen_at > ?))
         ${reporting.includeAnnual ? '' : `AND billing_interval <> 'ANNUAL'`}`,
    )
    .get(...appIds, now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString()) as {
    value: number;
  };

  // Only meaningful when trials are excluded, which is the gate the direct
  // query above hard-codes.
  if (reporting.includeTrials) return [];

  const delta = Math.abs(direct.value - viaPredicate);
  const relative = direct.value > 0 ? delta / direct.value : 0;
  if (delta > MONEY_EPSILON && relative > 0.02) {
    return [
      {
        check: 'cross_foot',
        severity: 'high',
        message: 'Reconstructed MRR does not match a direct sum over the contributing rows.',
        detail: { reconstructed: viaPredicate, direct: direct.value, delta },
      },
    ];
  }
  return [];
}

/**
 * Retroactive drift: snapshot the last 90 daily MRR points, then compare them
 * against the previous snapshot. History is allowed to change — a late
 * cancellation should rewrite the past — but a silent change is worth knowing
 * about. The trailing bucket is always excluded because it is still filling.
 */
export function checkRetroactiveDrift(db: Db, now = new Date()): Finding[] {
  const appIds = resolveScopedAppIds(db);
  const { reporting } = getConfig();
  const options = {
    appIds,
    includeAnnual: reporting.includeAnnual,
    includeTrials: reporting.includeTrials,
  };

  const capturedAt = now.toISOString();
  const points: Array<{ date: string; value: number }> = [];
  // Skip day 0: the current day is provisional.
  for (let dayOffset = 90; dayOffset >= 1; dayOffset -= 1) {
    const at = addDays(now, -dayOffset);
    points.push({ date: at.toISOString().slice(0, 10), value: mrrAt(db, at, options) });
  }

  const previous = db
    .prepare(
      `SELECT captured_at FROM drift_snapshots
       WHERE metric = 'mrr'
       ORDER BY captured_at DESC LIMIT 1`,
    )
    .get() as { captured_at: string } | undefined;

  const findings: Finding[] = [];

  if (previous) {
    const priorRows = db
      .prepare(
        `SELECT bucket_date AS date, value FROM drift_snapshots
         WHERE metric = 'mrr' AND captured_at = ?`,
      )
      .all(previous.captured_at) as Array<{ date: string; value: number }>;
    const prior = new Map(priorRows.map((row) => [row.date, row.value]));

    let drifted = 0;
    let worst = 0;
    let worstDate = '';
    for (const point of points) {
      const before = prior.get(point.date);
      if (before === undefined) continue;
      const delta = Math.abs(point.value - before);
      if (delta <= MONEY_EPSILON) continue;
      const relative = before > 0 ? delta / before : 1;
      if (relative > DRIFT_THRESHOLD) {
        drifted += 1;
        if (relative > worst) {
          worst = relative;
          worstDate = point.date;
        }
      }
    }

    if (drifted > 0) {
      findings.push({
        check: 'retroactive_drift',
        severity: worst > DRIFT_HIGH_THRESHOLD ? 'high' : 'low',
        message: `${drifted} past day(s) of MRR moved since the previous check.`,
        detail: {
          drifted,
          worstDate,
          worstChangePercent: Math.round(worst * 10000) / 100,
          comparedAgainst: previous.captured_at,
        },
      });
    }
  }

  const insert = db.prepare(
    `INSERT INTO drift_snapshots (metric, captured_at, bucket_date, value)
     VALUES ('mrr', ?, ?, ?)
     ON CONFLICT(metric, captured_at, bucket_date) DO UPDATE SET value = excluded.value`,
  );
  const write = db.transaction(() => {
    for (const point of points) insert.run(capturedAt, point.date, point.value);
    // Keep the three most recent snapshots.
    db.prepare(
      `DELETE FROM drift_snapshots WHERE metric = 'mrr' AND captured_at NOT IN (
         SELECT DISTINCT captured_at FROM drift_snapshots WHERE metric = 'mrr'
         ORDER BY captured_at DESC LIMIT 3
       )`,
    ).run();
  });
  write();

  return findings;
}

/**
 * Ledger to reconstruction: the clean lifecycle events accumulate MRR forward
 * as a running balance, while the reports rebuild it backwards from
 * subscription state. Two independent paths over the same facts, so they must
 * land on the same number.
 *
 * This is the check that catches a misclassified event. A cancel wrongly read
 * as churn, a plan change counted twice, a trial credited at activation instead
 * of at its first paid charge — none of those break a query or fail a type, but
 * every one of them moves the ledger away from the reconstruction. Compared per
 * install rather than in total, because two opposite errors sum to zero.
 */
export function checkEventLedger(db: Db, now = new Date()): Finding[] {
  const rows = db
    .prepare(
      `WITH ledger AS (
         SELECT app_id, shop_id, SUM(net_change) AS balance
         FROM customer_events
         WHERE suppressed = 0 AND net_change IS NOT NULL
         GROUP BY app_id, shop_id
       ),
       live AS (
         SELECT s.app_id AS app_id, s.shop_id AS shop_id,
                SUM(s.monthly_amount) AS mrr
         FROM subscriptions s
         WHERE s.is_test = 0
           AND s.conversion_at IS NOT NULL AND s.conversion_at < @now
           AND (s.churn_at IS NULL OR s.churn_at >= @now)
           AND NOT (s.frozen_at IS NOT NULL AND s.frozen_at < @now
                    AND (s.unfrozen_at IS NULL OR s.unfrozen_at <= s.frozen_at
                         OR s.unfrozen_at >= @now))
         GROUP BY s.app_id, s.shop_id
       )
       SELECT COALESCE(l.app_id, v.app_id) AS appId,
              COALESCE(l.shop_id, v.shop_id) AS shopId,
              COALESCE(l.balance, 0) AS balance,
              COALESCE(v.mrr, 0) AS mrr
       FROM ledger l
       FULL OUTER JOIN live v ON v.app_id = l.app_id AND v.shop_id = l.shop_id
       WHERE ABS(COALESCE(l.balance, 0) - COALESCE(v.mrr, 0)) > @epsilon`,
    )
    .all({ now: now.toISOString(), epsilon: MONEY_EPSILON }) as Array<{
    appId: string;
    shopId: string;
    balance: number;
    mrr: number;
  }>;

  if (rows.length === 0) return [];

  const worst = rows.reduce(
    (max, row) => Math.max(max, Math.abs(row.balance - row.mrr)),
    0,
  );
  const total = rows.reduce((sum, row) => sum + (row.balance - row.mrr), 0);

  return [
    {
      check: 'event_ledger',
      severity: worst > HIGH_MONEY_DELTA ? 'high' : 'low',
      message:
        `${rows.length} install(s) where the customer-event ledger disagrees with the ` +
        `MRR reconstruction. A lifecycle event is being classified wrongly.`,
      detail: {
        installs: rows.length,
        worstDelta: Math.round(worst * 100) / 100,
        netDelta: Math.round(total * 100) / 100,
        examples: rows.slice(0, 5).map((row) => ({
          appId: row.appId,
          shopId: row.shopId,
          ledger: Math.round(row.balance * 100) / 100,
          mrr: Math.round(row.mrr * 100) / 100,
        })),
      },
    },
  ];
}

export function runValidators(now = new Date()): Finding[] {
  const db = getDb();
  return [
    ...checkSourceConsistency(db),
    ...checkTotalsCrossFoot(db),
    ...checkEventLedger(db, now),
    ...checkRetroactiveDrift(db, now),
  ];
}
