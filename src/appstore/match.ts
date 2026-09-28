import type { Db } from '../db/index.js';

/**
 * Deciding which customer left a review.
 *
 * This is a guess, and the code is arranged so that it is never mistaken for
 * anything else. A review publishes the merchant's **store name** and their
 * country. It does not publish the myshopify domain, and PartnerDex keys every
 * customer on a Partner API shop id — so there is no join, only a name that two
 * different systems happen to spell the same way.
 *
 * Two things make the guess defensible:
 *
 *   1. **Only installers are candidates.** You cannot review an app you never
 *      installed, so the search runs against shops with an install interval for
 *      that app rather than against every shop on record. On a normal account
 *      that turns thousands of possible names into a handful.
 *
 *   2. **Only a unique answer is accepted.** Two installers sharing a store name
 *      is recorded as `ambiguous` and left unlinked, because attributing a
 *      one-star review to whichever of them sorted first is worse than
 *      attributing it to nobody.
 *
 * Everything else is left for a human. A person who recognises the store can
 * link it by hand, and `manual` is the one verdict this function will not
 * overwrite — re-running on every sync would otherwise quietly undo the
 * correction the moment it was made.
 */

/**
 * Store names compared with case, spacing and Unicode form folded away.
 *
 * Punctuation is deliberately *not* stripped. "Bob's Bikes" and "Bobs Bikes"
 * really can be two different shops, and widening the net here would trade
 * unlinked reviews — which are visible and fixable — for wrong ones, which are
 * neither.
 */
export function normalizeStoreName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export type MatchMethod = 'auto' | 'manual' | 'ambiguous' | 'none';

export interface MatchResult {
  linked: number;
  ambiguous: number;
  unmatched: number;
}

/** Shops that have installed this app at some point, keyed by normalized name. */
function installersByName(db: Db, appId: string): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.id AS id, s.name AS name
         FROM shops s
         JOIN install_intervals i ON i.shop_id = s.id
        WHERE i.app_id = ? AND s.name IS NOT NULL AND s.name <> ''`,
    )
    .all(appId) as Array<{ id: string; name: string }>;

  const byName = new Map<string, string[]>();
  for (const row of rows) {
    const key = normalizeStoreName(row.name);
    if (!key) continue;
    const ids = byName.get(key);
    if (ids) ids.push(row.id);
    else byName.set(key, [row.id]);
  }
  return byName;
}

/**
 * Re-run the automatic match over every review that a human has not settled.
 *
 * Cheap enough to redo wholesale on each sync, and it has to be: a shop that
 * installed the app after its review was posted, or one whose name only reached
 * us on a later transaction, becomes matchable only on a subsequent pass.
 */
export function matchReviewsToShops(db: Db): MatchResult {
  const apps = db
    .prepare('SELECT DISTINCT app_id FROM app_reviews')
    .all() as Array<{ app_id: string }>;

  const result: MatchResult = { linked: 0, ambiguous: 0, unmatched: 0 };

  const update = db.prepare(
    `UPDATE app_reviews SET shop_id = ?, match_method = ?
      WHERE review_id = ? AND match_method <> 'manual'`,
  );

  for (const { app_id: appId } of apps) {
    const byName = installersByName(db, appId);

    const reviews = db
      .prepare(
        `SELECT review_id, store_name FROM app_reviews
          WHERE app_id = ? AND match_method <> 'manual'`,
      )
      .all(appId) as Array<{ review_id: string; store_name: string }>;

    const apply = db.transaction(() => {
      for (const review of reviews) {
        const candidates = byName.get(normalizeStoreName(review.store_name)) ?? [];

        if (candidates.length === 1) {
          update.run(candidates[0], 'auto', review.review_id);
          result.linked += 1;
        } else if (candidates.length > 1) {
          update.run('', 'ambiguous', review.review_id);
          result.ambiguous += 1;
        } else {
          update.run('', 'none', review.review_id);
          result.unmatched += 1;
        }
      }
    });
    apply();
  }

  return result;
}

/**
 * A human's answer, which outranks the matcher permanently.
 *
 * Passing a null shop clears the link and returns the review to the matcher —
 * the way to undo a mistaken manual link rather than being stuck with it.
 */
export function setReviewShop(db: Db, reviewId: string, shopId: string | null): boolean {
  const info = db
    .prepare('UPDATE app_reviews SET shop_id = ?, match_method = ? WHERE review_id = ?')
    .run(shopId ?? '', shopId ? 'manual' : 'none', reviewId);
  return info.changes > 0;
}
