import { createHash } from 'node:crypto';
import { getConfig } from '../config.js';
import { readSyncState, writeSyncState, type Db } from '../db/index.js';
import { fetchReviewsPage } from './client.js';
import { listingHandles, seedListingsFromConfig } from './listings.js';
import { parseReviewsPage, type ParsedReview } from './parse.js';

/**
 * Keeping a local copy of a listing's reviews, including the ones it no longer
 * has.
 *
 * Two things are being asked of this module and only one of them is ordinary.
 * Noticing a *new* review is cheap: the newest page is one request, and Shopify
 * publishes the running total in the page's JSON-LD, so a crawl usually costs
 * nothing more than that. Noticing a *removed* review is not, because absence is
 * only observable by walking every page and finding a gap — and a walk that
 * fails halfway looks exactly like a listing that just lost half its reviews.
 *
 * So removals are only ever applied by a sweep that can prove it saw the whole
 * listing: every page fetched without error, walked through to the page with no
 * "next", and coming back with a count consistent with the listing's own. Fail
 * any of those and the sweep still records everything it found and simply
 * declines to conclude anything about what it did not — the asymmetry is
 * deliberate, since a missed removal is noticed on the next sweep, while a false
 * removal writes a "Removed" badge onto a review that is sitting there in
 * public, and nothing later takes it back.
 */

/**
 * How much of the listing a sweep must actually come back with before it is
 * allowed to call anything removed.
 *
 * The HTTP statuses can all be 200 and the crawl still be short — a pager that
 * stops early, a page that renders empty under load. Comparing what we found
 * against the count Shopify itself publishes is the check that does not rely on
 * the crawl's own account of how it went. The slack is for reviews posted or
 * pulled while the walk was in progress.
 */
const MIN_SWEEP_COVERAGE = 0.9;

/** Guards against a runaway pager. 500 pages is 5,000 reviews. */
const MAX_PAGES = 500;

export interface ReviewSyncOptions {
  /** Sweep every listing in full, whatever the schedule says. */
  full?: boolean;
  onProgress?: (message: string) => void;
  /**
   * Test seam: where a page comes from.
   *
   * The interesting behaviour in this module is what it concludes from a set of
   * pages — above all what it declines to conclude when a page fails — and that
   * is not reachable through a real listing on demand.
   */
  fetchPage?: (handle: string, page: number) => Promise<string>;
}

export interface ReviewSyncResult {
  apps: string[];
  added: number;
  updated: number;
  removed: number;
  /** Apps whose listing was walked end to end this run. */
  swept: string[];
}

/**
 * What "the merchant edited their review" means, reduced to a value.
 *
 * Rating and body only. The other fields on a review move on their own —
 * "7 months using the app" ticks over to eight, a store gets renamed, we reply —
 * and folding those in would report an edit every time the clock moved.
 */
function contentHash(review: ParsedReview): string {
  return createHash('sha256').update(`${review.rating}\n${review.body}`).digest('hex');
}

export type UpsertOutcome = 'added' | 'updated' | 'unchanged';

/**
 * Write one review, and say whether it is news.
 *
 * `removed_at` is cleared on the way through: a review we can see again is not
 * removed, whatever we concluded last time. Restorations are rare, but leaving a
 * stale badge on a review that is back in public is the same lie as putting one
 * there in the first place.
 */
export function upsertReview(
  db: Db,
  appId: string,
  handle: string,
  review: ParsedReview,
  seenAt: string,
): UpsertOutcome {
  const existing = db
    .prepare('SELECT content_hash, rating, edited_at, prior_rating FROM app_reviews WHERE review_id = ?')
    .get(review.reviewId) as
    | { content_hash: string; rating: number; edited_at: string | null; prior_rating: number | null }
    | undefined;

  const hash = contentHash(review);
  const edited = Boolean(existing) && existing!.content_hash !== hash;

  db.prepare(
    `INSERT INTO app_reviews (
       review_id, app_id, rating, posted_on, body, store_name, country, usage_duration,
       reply_body, reply_on, permalink, content_hash, edited_at, prior_rating,
       first_seen_at, last_seen_at, removed_at
     ) VALUES (
       @reviewId, @appId, @rating, @postedOn, @body, @storeName, @country, @usageDuration,
       @replyBody, @replyOn, @permalink, @hash, @editedAt, @priorRating,
       @seenAt, @seenAt, NULL
     )
     ON CONFLICT(review_id) DO UPDATE SET
       rating         = excluded.rating,
       posted_on      = excluded.posted_on,
       body           = excluded.body,
       store_name     = excluded.store_name,
       country        = excluded.country,
       usage_duration = excluded.usage_duration,
       reply_body     = excluded.reply_body,
       reply_on       = excluded.reply_on,
       permalink      = excluded.permalink,
       content_hash   = excluded.content_hash,
       edited_at      = excluded.edited_at,
       prior_rating   = excluded.prior_rating,
       last_seen_at   = excluded.last_seen_at,
       removed_at     = NULL`,
  ).run({
    reviewId: review.reviewId,
    appId,
    rating: review.rating,
    postedOn: review.postedOn,
    body: review.body,
    storeName: review.storeName,
    country: review.country,
    usageDuration: review.usageDuration,
    replyBody: review.replyBody,
    replyOn: review.replyOn,
    permalink: `https://apps.shopify.com/${handle}/reviews/${review.reviewId}`,
    hash,
    // An unchanged review keeps whatever edit it already had on record, so a
    // rewrite noticed last month does not lose its date on every later crawl.
    editedAt: edited ? seenAt : (existing?.edited_at ?? null),
    priorRating: edited ? existing!.rating : (existing?.prior_rating ?? null),
    seenAt,
  });

  if (!existing) return 'added';
  return edited ? 'updated' : 'unchanged';
}

function recordSnapshot(
  db: Db,
  appId: string,
  capturedAt: string,
  ratingValue: number | null,
  ratingCount: number | null,
): void {
  db.prepare(
    `INSERT INTO app_review_snapshots (app_id, captured_at, rating_value, rating_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id, captured_at) DO NOTHING`,
  ).run(appId, capturedAt, ratingValue, ratingCount);
}

function liveReviewCount(db: Db, appId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM app_reviews WHERE app_id = ? AND removed_at IS NULL')
    .get(appId) as { n: number };
  return row.n;
}

/**
 * Whether this run has to walk the whole listing.
 *
 * The count check is what makes the schedule a ceiling rather than the only
 * trigger: if Shopify's published total disagrees with the number of reviews we
 * hold as live, something has appeared or disappeared and waiting out the rest
 * of the interval would only delay finding out which.
 */
function sweepDue(
  db: Db,
  appId: string,
  publishedCount: number | null,
  options: ReviewSyncOptions,
): boolean {
  if (options.full) return true;

  const { syncedThrough } = readSyncState(db, `reviews:${appId}`);
  // Never swept: the first walk is also the backfill of the listing's history.
  if (!syncedThrough) return true;

  if (publishedCount !== null && publishedCount !== liveReviewCount(db, appId)) return true;

  const { runtime } = getConfig();
  if (runtime.reviewSweepHours === 0) return true;
  const dueAt = new Date(syncedThrough).getTime() + runtime.reviewSweepHours * 3_600_000;
  return Date.now() >= dueAt;
}

/**
 * Mark every live review of this app that the sweep did not see.
 *
 * Nothing is deleted. The row keeps its rating, its text and its link to a
 * customer, and only gains the date we noticed it was gone — which is the whole
 * reason this table is not rebuilt from the source like every other one.
 */
function applyRemovals(db: Db, appId: string, seen: Set<string>, sweptAt: string): number {
  // The `seen` set is the only thing that decides this. Excluding rows by
  // `first_seen_at` as well would look like a safety net and behave like a bug:
  // a review inserted by this very sweep is already in `seen`, and two syncs
  // landing in the same millisecond would make the comparison exclude
  // everything.
  const live = db
    .prepare('SELECT review_id FROM app_reviews WHERE app_id = ? AND removed_at IS NULL')
    .all(appId) as Array<{ review_id: string }>;

  const gone = live.filter((row) => !seen.has(row.review_id));
  if (gone.length === 0) return 0;

  const mark = db.prepare('UPDATE app_reviews SET removed_at = ? WHERE review_id = ?');
  const run = db.transaction(() => {
    for (const row of gone) mark.run(sweptAt, row.review_id);
  });
  run();

  return gone.length;
}

interface AppSyncTally {
  added: number;
  updated: number;
  removed: number;
  swept: boolean;
}

async function syncReviewsForApp(
  db: Db,
  appId: string,
  handle: string,
  options: ReviewSyncOptions,
): Promise<AppSyncTally> {
  const onProgress = options.onProgress ?? (() => {});
  const fetchPage = options.fetchPage ?? fetchReviewsPage;
  const startedAt = new Date().toISOString();
  const tally: AppSyncTally = { added: 0, updated: 0, removed: 0, swept: false };

  const first = parseReviewsPage(await fetchPage(handle, 1));
  recordSnapshot(db, appId, startedAt, first.ratingValue, first.ratingCount);

  const seen = new Set<string>();
  const absorb = (reviews: ParsedReview[]): number => {
    let fresh = 0;
    for (const review of reviews) {
      seen.add(review.reviewId);
      const outcome = upsertReview(db, appId, handle, review, startedAt);
      if (outcome === 'added') {
        tally.added += 1;
        fresh += 1;
      } else if (outcome === 'updated') {
        tally.updated += 1;
      }
    }
    return fresh;
  };

  const firstFresh = absorb(first.reviews);
  const sweeping = sweepDue(db, appId, first.ratingCount, options);

  // A page whose reviews were *all* new means it did not reach back far enough
  // to cover everything posted since the last crawl, so keep going. One familiar
  // review is proof we have caught up with ourselves. A sweep ignores all of
  // this and walks to the end regardless.
  const exhausted = (fresh: number, reviews: ParsedReview[]): boolean =>
    reviews.length === 0 || fresh < reviews.length;

  let hasNext = first.hasNextPage;
  let keepGoing = sweeping || !exhausted(firstFresh, first.reviews);
  let page = 1;

  while (hasNext && keepGoing && page < MAX_PAGES) {
    page += 1;
    const next = parseReviewsPage(await fetchPage(handle, page));
    const fresh = absorb(next.reviews);

    hasNext = next.hasNextPage;
    keepGoing = sweeping || !exhausted(fresh, next.reviews);

    if (sweeping) {
      onProgress(`  reviews (${handle}): ${page} pages, ${seen.size} reviews`);
    }
  }

  // Reaching a page with no "next" is the only proof the walk saw the end of the
  // listing. Running out of page budget or stopping early is not.
  const complete = !hasNext;

  if (!sweeping) return tally;

  // Everything below decides whether this walk earned the right to conclude that
  // a review it did not see is gone.
  const covered =
    first.ratingCount === null || seen.size >= first.ratingCount * MIN_SWEEP_COVERAGE;

  if (!complete || !covered) {
    onProgress(
      `  reviews (${handle}): sweep incomplete (${seen.size} seen, listing says ` +
        `${first.ratingCount ?? 'unknown'}) — recording what was found, not marking removals`,
    );
    return tally;
  }

  tally.removed = applyRemovals(db, appId, seen, startedAt);
  tally.swept = true;
  writeSyncState(db, `reviews:${appId}`, { syncedThrough: startedAt });

  return tally;
}

/**
 * Crawl every app that has a listing mapped to it.
 *
 * The mapping comes from `app_listings`, which the dashboard writes — an
 * organization has many apps and nothing in the Partner API says which listing
 * any of them is published under, so it is the partner's answer we are reading
 * back, not configuration.
 *
 * One app failing does not stop the others: a handle typo or a listing that has
 * been taken down should cost that app's reviews, not the whole run's.
 */
export async function syncReviews(db: Db, options: ReviewSyncOptions = {}): Promise<ReviewSyncResult> {
  const onProgress = options.onProgress ?? (() => {});
  const result: ReviewSyncResult = { apps: [], added: 0, updated: 0, removed: 0, swept: [] };

  // Anything named in APP_STORE_HANDLES that has no row yet becomes one, so a
  // container coming up on an empty volume can sync before anyone opens the UI.
  seedListingsFromConfig(db);

  for (const [appId, handle] of Object.entries(listingHandles(db))) {
    onProgress(`Syncing reviews for app ${appId} (${handle})...`);
    try {
      const tally = await syncReviewsForApp(db, appId, handle, options);
      result.apps.push(appId);
      result.added += tally.added;
      result.updated += tally.updated;
      result.removed += tally.removed;
      if (tally.swept) result.swept.push(appId);
      onProgress(
        `  reviews (${handle}): ${tally.added} new, ${tally.updated} edited, ${tally.removed} removed`,
      );
    } catch (cause) {
      onProgress(`  reviews (${handle}): failed — ${String(cause)}`);
    }
  }

  return result;
}
