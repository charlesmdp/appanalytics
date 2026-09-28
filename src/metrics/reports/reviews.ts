import { bucketsCte } from '../asof.js';
import type { MetricContext } from '../context.js';
import { buildResponse, type MetricResponse } from '../response.js';

/**
 * App Store reviews.
 *
 * These reports are reconstructed the same way every other report here is —
 * asked as "what was true at this instant" rather than read off a running total
 * — which reviews happen to support unusually well. Every review carries the
 * date it was posted, and a removal carries the date we noticed it, so the set
 * that was live at any past instant is a range predicate over two columns.
 *
 * One honest limit, and it only touches removals. The listing shows post dates
 * for reviews that are still on it, so *posted* history is complete back to the
 * beginning. It shows nothing at all about reviews that were taken down before
 * we first crawled, so those are simply not in the store and never will be —
 * they are indistinguishable from reviews that never existed. In practice that
 * means the live count and the average rating drift slightly high in the period
 * before the first sweep, and are exact after it. `meta.removalsKnownFrom`
 * carries that horizon on every response rather than leaving a reader to assume
 * the whole series is equally trustworthy.
 *
 * A removal is also never attributed. Shopify purging a review, a merchant
 * deleting their own, and a store closing all present as the same absence.
 */

/**
 * The listing publishes a date with no time. Comparing it against a bucket
 * boundary means putting both in the same form: a bare `2024-03-01` sorts
 * *before* `2024-03-01T00:00:00.000Z` lexically, so a review would land in the
 * bucket before its own.
 */
const POSTED_AT = "(r.posted_on || 'T00:00:00.000Z')";

interface Fragment {
  sql: string;
  params: Record<string, unknown>;
}

/**
 * The scope every review report reads through: the apps in reporting scope, and
 * the star rating the reader has narrowed to.
 *
 * One fragment rather than two so the rating can never be applied to the count
 * and forgotten on the average sitting next to it.
 */
function scopeFilter(context: MetricContext, alias = 'r'): Fragment {
  const apps = appsFilter(context, alias);
  if (context.rating === null) return apps;
  return {
    sql: `${apps.sql} AND ${alias}.rating = @rrating`,
    params: { ...apps.params, rrating: context.rating },
  };
}

/**
 * Reporting scope alone.
 *
 * Split out because one table here — `app_review_snapshots`, which holds the
 * listing's own published aggregate — has no rating to filter on and no column
 * for one. Reaching for `scopeFilter` there is a SQL error waiting for the first
 * reader who picks a star.
 */
function appsFilter(context: MetricContext, alias = 'r'): Fragment {
  const params: Record<string, unknown> = {};
  const names = context.appIds.map((id, index) => {
    params[`rapp${index}`] = id;
    return `@rapp${index}`;
  });
  return {
    sql: names.length > 0 ? `AND ${alias}.app_id IN (${names.join(', ')})` : '',
    params,
  };
}

/**
 * The earliest instant from which a removal would have been noticed.
 *
 * Before the first review we ever recorded there is no history to be missing;
 * after it, anything already gone was gone before we looked.
 */
function removalsKnownFrom(context: MetricContext): string | null {
  const apps = scopeFilter(context);
  const row = context.db
    .prepare(`SELECT MIN(first_seen_at) AS at FROM app_reviews r WHERE 1 = 1 ${apps.sql}`)
    .get(apps.params) as { at: string | null };
  return row.at;
}

/**
 * Reviews posted inside each bucket.
 *
 * A plain count. This used to break down by star band, which asked the chart to
 * answer two questions at once — how many, and how good — and answered neither
 * at a glance. The rating filter now scopes the whole page instead, so "how many
 * one-stars this month" is the same card with a filter set, and it moves the
 * other three cards with it.
 */
export function reviewsPostedReport(context: MetricContext): MetricResponse {
  const cte = bucketsCte(context.window.buckets);
  const apps = scopeFilter(context);

  const rows = context.db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx, COUNT(r.review_id) AS total
       FROM buckets b
       LEFT JOIN app_reviews r
         ON ${POSTED_AT} >= b.bucket_from
        AND ${POSTED_AT} < b.as_of
        ${apps.sql}
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...apps.params }) as Array<{ idx: number; total: number }>;

  const byIndex = new Map(rows.map((row) => [row.idx, row.total]));

  return buildResponse({
    metric: 'reviews_posted',
    kind: 'flow',
    format: 'count',
    window: context.window,
    values: context.window.buckets.map((_, idx) => byIndex.get(idx) ?? 0),
    meta: {
      definition: 'Reviews posted in the period, by the date shown on the listing.',
      source: 'Public App Store listing; the Partner API exposes no review data.',
      ...(context.rating === null ? {} : { rating: context.rating }),
    },
  });
}

/** Reviews that stopped appearing on the listing during each bucket. */
export function reviewsRemovedReport(context: MetricContext): MetricResponse {
  const cte = bucketsCte(context.window.buckets);
  const apps = scopeFilter(context);

  const rows = context.db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx, COUNT(r.review_id) AS total
       FROM buckets b
       LEFT JOIN app_reviews r
         ON r.removed_at IS NOT NULL
        AND r.removed_at >= b.bucket_from
        AND r.removed_at < b.as_of
        ${apps.sql}
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...apps.params }) as Array<{ idx: number; total: number }>;

  const byIndex = new Map(rows.map((row) => [row.idx, row.total]));

  return buildResponse({
    metric: 'reviews_removed',
    kind: 'flow',
    format: 'count',
    window: context.window,
    values: context.window.buckets.map((_, idx) => byIndex.get(idx) ?? 0),
    meta: {
      definition: 'Reviews that were on the listing and no longer are, dated to when a full sweep first missed them.',
      attribution:
        'Not attributable. Shopify removing a review, the merchant deleting it, and the store closing are indistinguishable from the listing.',
      removalsKnownFrom: removalsKnownFrom(context),
    },
  });
}

/** Per-bucket live count and average rating, reconstructed as of each instant. */
function liveSeries(context: MetricContext): Map<number, { live: number; average: number }> {
  const cte = bucketsCte(context.bucketsWithLead);
  const apps = scopeFilter(context);

  const rows = context.db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx,
              COUNT(r.review_id) AS live,
              COALESCE(AVG(r.rating), 0) AS average
       FROM buckets b
       LEFT JOIN app_reviews r
         ON ${POSTED_AT} < b.as_of
        AND (r.removed_at IS NULL OR r.removed_at >= b.as_of)
        ${apps.sql}
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...apps.params }) as Array<{
    idx: number;
    live: number;
    average: number;
  }>;

  return new Map(rows.map((row) => [row.idx, { live: row.live, average: row.average }]));
}

/** How many reviews the listing carried at each instant. */
export function reviewsLiveReport(context: MetricContext): MetricResponse {
  const series = liveSeries(context);
  const values = context.bucketsWithLead.map((_, idx) => series.get(idx)?.live ?? 0);
  const [leading, ...visible] = values;

  return buildResponse({
    metric: 'reviews_live',
    kind: 'stock',
    format: 'count',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    meta: {
      definition: 'Reviews posted on or before the instant and not removed by it.',
      removalsKnownFrom: removalsKnownFrom(context),
      note: 'Reviews removed before the first crawl are unknowable, so points before that date read slightly high.',
    },
  });
}

/**
 * The average rating of the reviews that were live at each instant.
 *
 * Ours, not Shopify's. `app_review_snapshots` keeps the figure they publish
 * alongside it, and the two can legitimately differ — their rounding and their
 * eligibility rules are not ours to reproduce. Recomputing from the rows is what
 * makes the number move with the same history every other series here is built
 * from, rather than being a fourth-hand copy that cannot be reconciled.
 */
export function reviewsAverageRatingReport(context: MetricContext): MetricResponse {
  const series = liveSeries(context);
  const values = context.bucketsWithLead.map((_, idx) => series.get(idx)?.average ?? 0);
  const [leading, ...visible] = values;

  /**
   * Shopify's published figure, for comparison — and only when no rating filter
   * is on.
   *
   * `app_review_snapshots` holds the listing's own whole-listing average, so it
   * has no rating to filter by (nor a column for one). Reporting it beside an
   * average that *is* filtered would invite reading the gap as drift between us
   * and Shopify, when it is only the filter.
   */
  const apps = appsFilter(context, 's');
  const published =
    context.rating !== null
      ? undefined
      : (context.db
          .prepare(
            `SELECT rating_value AS value, captured_at AS at
               FROM app_review_snapshots s
              WHERE rating_value IS NOT NULL ${apps.sql}
              ORDER BY captured_at DESC
              LIMIT 1`,
          )
          .get(apps.params) as { value: number; at: string } | undefined);

  return buildResponse({
    metric: 'reviews_average_rating',
    kind: 'stock',
    format: 'number',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    meta: {
      definition: 'Mean rating of the reviews live at the instant, computed from the stored reviews.',
      removalsKnownFrom: removalsKnownFrom(context),
      ...(context.rating !== null
        ? { rating: context.rating }
        : {
            publishedRating: published?.value ?? null,
            publishedAt: published?.at ?? null,
            note: 'The listing publishes its own rounded figure, kept in meta.publishedRating; small differences are expected.',
          }),
    },
  });
}
