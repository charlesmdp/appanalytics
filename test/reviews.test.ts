import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getDb } from '../src/db/index.js';
import { parseReviewsPage } from '../src/appstore/parse.js';
import { syncReviews } from '../src/appstore/ingest.js';
import { matchReviewsToShops, setReviewShop } from '../src/appstore/match.js';
import {
  getListing,
  ListingError,
  parseListingUrl,
  removeListing,
  seedListingsFromConfig,
  setListing,
} from '../src/appstore/listings.js';
import { rebuildDerivedTables } from '../src/sync/derive.js';
import { getCustomer } from '../src/customers/index.js';
import { insertAppEvents } from '../src/sync/ingest.js';
import { dispatchPending } from '../src/notifications/dispatch.js';
import { createChannel, setTopic } from '../src/notifications/store.js';
import { APP_REVIEW_EVENTS } from '../src/notifications/topics.js';
import { runMetric } from '../src/metrics/registry.js';
import { MetricRequestError } from '../src/metrics/context.js';
import { APP_ID, resetEnvironment, seed } from './helpers.js';

/**
 * Reviews come from a page nobody promised us, so the tests split along that
 * seam: the parser is pinned against a real listing page captured verbatim, and
 * everything downstream runs on synthetic pages built from the same hooks.
 *
 * The cases that matter most are the ones where being wrong is expensive and
 * quiet — a sweep that half-failed marking live reviews as removed, a re-crawl
 * announcing reviews that were already announced, an automatic match walking
 * over a link a human made on purpose.
 */

const FIXTURE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/app-store-reviews-page.html'),
  'utf8',
);

const HANDLE = 'test-app';

interface FakeReview {
  id: string;
  rating: number;
  date: string;
  body: string;
  store: string;
  country?: string;
}

/**
 * A reviews page carrying only the hooks the parser reads.
 *
 * Deliberately not a copy of Shopify's markup: the fixture above is what pins
 * that, and duplicating its Tailwind here would just mean two places to update
 * for a redesign that this test has no opinion about.
 */
function fakePage(
  reviews: FakeReview[],
  options: { ratingCount?: number; hasNext?: boolean; page?: number } = {},
): string {
  const blocks = reviews
    .map(
      (review) => `
<div id="review-${review.id}">
  <div data-merchant-review data-review-content-id="${review.id}">
    <div aria-label="${review.rating} out of 5 stars" role="img"></div>
    <div>${review.date}</div>
    <div data-truncate-review><div data-truncate-content-copy><p>${review.body}</p></div></div>
    <span title="${review.store}">${review.store}</span>
    <button data-review-share-link="/reviews/${review.id}"></button>
    <div>${review.country ?? 'United States'}</div>
    <div>3 months using the app</div>
  </div>
</div>`,
    )
    .join('\n');

  const aggregate = JSON.stringify({
    '@type': 'SoftwareApplication',
    aggregateRating: { ratingValue: 4.5, ratingCount: options.ratingCount ?? reviews.length },
  });

  const pager = options.hasNext
    ? `<a rel="next" href="/${HANDLE}/reviews?sort_by=newest&page=${(options.page ?? 1) + 1}">Next</a>`
    : '';

  return `<html><head><script type="application/ld+json">${aggregate}</script></head>
<body>${blocks}${pager}</body></html>`;
}

/** A fetcher over a fixed set of pages, recording which were asked for. */
function pagesOf(pages: string[]): {
  fetchPage: (handle: string, page: number) => Promise<string>;
  requested: number[];
} {
  const requested: number[] = [];
  return {
    requested,
    fetchPage: async (_handle, page) => {
      requested.push(page);
      const html = pages[page - 1];
      if (html === undefined) throw new Error(`no page ${page}`);
      return html;
    },
  };
}

const review = (id: string, over: Partial<FakeReview> = {}): FakeReview => ({
  id,
  rating: 5,
  date: 'March 3, 2024',
  body: `Review ${id}`,
  store: `Store ${id}`,
  ...over,
});

beforeEach(() => {
  resetEnvironment({ APP_STORE_HANDLES: `${APP_ID}:${HANDLE}` });
  getDb();
});

const liveIds = () =>
  (
    getDb()
      .prepare('SELECT review_id FROM app_reviews WHERE removed_at IS NULL ORDER BY review_id')
      .all() as Array<{ review_id: string }>
  ).map((row) => row.review_id);

describe('mapping an app to its listing', () => {
  it('takes the handle out of whatever shape the URL was pasted in', () => {
    for (const input of [
      'https://apps.shopify.com/my-app',
      'https://apps.shopify.com/my-app/',
      'https://www.apps.shopify.com/my-app',
      'http://apps.shopify.com/my-app/reviews?sort_by=newest&page=3',
      'apps.shopify.com/my-app',
      'my-app',
    ]) {
      assert.equal(parseListingUrl(input).handle, 'my-app', `failed on ${input}`);
    }
  });

  it('normalizes to the canonical listing URL', () => {
    assert.equal(
      parseListingUrl('https://apps.shopify.com/My-App/reviews').url,
      'https://apps.shopify.com/my-app',
    );
  });

  it('refuses a URL on somebody else’s host', () => {
    assert.throws(
      () => parseListingUrl('https://example.com/my-app'),
      (error: unknown) => error instanceof ListingError && /apps\.shopify\.com/.test((error as Error).message),
    );
  });

  it('refuses a section of the store that is not an app', () => {
    // The easiest wrong thing to copy out of the address bar.
    assert.throws(() => parseListingUrl('https://apps.shopify.com/categories/finding-products'), ListingError);
  });

  it('refuses an empty or unparseable entry', () => {
    assert.throws(() => parseListingUrl('   '), ListingError);
    assert.throws(() => parseListingUrl('https://apps.shopify.com/'), ListingError);
  });

  it('will not map one listing to two apps', () => {
    setListing('111', 'https://apps.shopify.com/shared', { db: getDb() });
    assert.throws(
      () => setListing('222', 'https://apps.shopify.com/shared', { db: getDb() }),
      (error: unknown) => error instanceof ListingError && /already mapped/.test((error as Error).message),
    );
  });

  it('crawls the app a listing is mapped to', async () => {
    setListing(APP_ID, 'https://apps.shopify.com/demo', { db: getDb() });
    const { fetchPage } = pagesOf([fakePage([review('1')])]);
    const result = await syncReviews(getDb(), { fetchPage });

    assert.deepEqual(result.apps, [APP_ID]);
    const row = getDb().prepare('SELECT app_id FROM app_reviews WHERE review_id = ?').get('1') as {
      app_id: string;
    };
    assert.equal(row.app_id, APP_ID);
  });

  it('crawls nothing when no listing is mapped', async () => {
    getDb().prepare('DELETE FROM app_listings').run();
    const result = await syncReviews(getDb(), {
      fetchPage: async () => {
        throw new Error('should not have fetched anything');
      },
    });
    assert.deepEqual(result.apps, []);
  });

  it('seeds from APP_STORE_HANDLES, and then never overrides the dashboard', () => {
    seedListingsFromConfig(getDb());
    const seeded = getListing(APP_ID, getDb());
    assert.equal(seeded?.handle, HANDLE);
    assert.equal(seeded?.source, 'config');

    // Somebody corrects it in the UI. The environment still says otherwise, and
    // must not win it back on the next boot.
    setListing(APP_ID, 'https://apps.shopify.com/the-right-one', { db: getDb() });
    seedListingsFromConfig(getDb());

    const owned = getListing(APP_ID, getDb());
    assert.equal(owned?.handle, 'the-right-one');
    assert.equal(owned?.source, 'manual');
  });

  it('keeps the reviews when a listing is unmapped', async () => {
    setListing(APP_ID, 'https://apps.shopify.com/demo', { db: getDb() });
    await syncReviews(getDb(), { fetchPage: pagesOf([fakePage([review('1')])]).fetchPage });

    assert.equal(removeListing(APP_ID, getDb()), true);
    // Unmapping is not a statement about history — and for a removed review
    // this row is the only copy left anywhere.
    assert.deepEqual(liveIds(), ['1']);
  });
});

describe('parsing a real listing page', () => {
  const page = parseReviewsPage(FIXTURE);

  it('reads every review on the page', () => {
    assert.equal(page.reviews.length, 10);
  });

  it('reads the listing aggregate that decides when a sweep is due', () => {
    assert.equal(page.ratingValue, 4.7);
    assert.equal(page.ratingCount, 2919);
    assert.equal(page.hasNextPage, true);
    assert.equal(page.lastPage, 292);
  });

  it('reads every field of a review', () => {
    const first = page.reviews[0]!;
    assert.equal(first.reviewId, '2300030');
    assert.equal(first.rating, 1);
    assert.equal(first.postedOn, '2026-07-27');
    assert.equal(first.storeName, 'House of Dasein');
    assert.equal(first.country, 'Australia');
    assert.equal(first.usageDuration, 'About 7 years using the app');
    assert.match(first.body, /impossible to clear all inactive profiles/);
  });

  it('keeps a developer reply out of the review it answers', () => {
    const replied = page.reviews.find((entry) => entry.reviewId === '2297186')!;
    assert.equal(replied.body, 'works well but some time required to set up');
    assert.match(replied.replyBody!, /glad the platform works well/);
    assert.equal(replied.replyOn, '2026-07-28');
    // The reply's date must not be mistaken for the review's.
    assert.equal(replied.postedOn, '2026-07-24');
  });

  it('takes the untruncated store name, not the ellipsised one', () => {
    const long = page.reviews.find((entry) => entry.reviewId === '2298314')!;
    assert.equal(long.storeName, 'Art by Seepengoose: The Plug Clothing Company');
  });
});

describe('crawling a listing', () => {
  it('records every review and the listing aggregate', async () => {
    const { fetchPage } = pagesOf([fakePage([review('1'), review('2')])]);
    const result = await syncReviews(getDb(), { fetchPage });

    assert.equal(result.added, 2);
    assert.deepEqual(liveIds(), ['1', '2']);

    const snapshot = getDb()
      .prepare('SELECT rating_value, rating_count FROM app_review_snapshots')
      .get() as { rating_value: number; rating_count: number };
    assert.equal(snapshot.rating_count, 2);
  });

  it('is idempotent — a second crawl of the same page adds nothing', async () => {
    const pages = [fakePage([review('1'), review('2')])];
    await syncReviews(getDb(), { fetchPage: pagesOf(pages).fetchPage });
    const second = await syncReviews(getDb(), { fetchPage: pagesOf(pages).fetchPage });

    assert.equal(second.added, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.removed, 0);
    assert.deepEqual(liveIds(), ['1', '2']);
  });

  it('walks past the newest page when every review on it is new', async () => {
    const { fetchPage, requested } = pagesOf([
      fakePage([review('3'), review('4')], { hasNext: true, ratingCount: 4 }),
      fakePage([review('1'), review('2')], { ratingCount: 4, page: 2 }),
    ]);
    await syncReviews(getDb(), { fetchPage });

    assert.deepEqual(requested, [1, 2]);
    assert.deepEqual(liveIds(), ['1', '2', '3', '4']);
  });

  it('notices a rewritten review, and what the rating was before', async () => {
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1', { rating: 5, body: 'Great' })])]).fetchPage,
    });

    const result = await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1', { rating: 1, body: 'Terrible now' })])]).fetchPage,
    });

    assert.equal(result.updated, 1);
    assert.equal(result.added, 0);

    const row = getDb()
      .prepare('SELECT rating, prior_rating, edited_at FROM app_reviews WHERE review_id = ?')
      .get('1') as { rating: number; prior_rating: number; edited_at: string };
    assert.equal(row.rating, 1);
    assert.equal(row.prior_rating, 5);
    assert.ok(row.edited_at);
  });

  it('does not report an edit when only the usage duration moved on', async () => {
    const before = fakePage([review('1')]).replace('3 months using the app', '3 months using the app');
    const after = fakePage([review('1')]).replace('3 months using the app', '4 months using the app');

    await syncReviews(getDb(), { fetchPage: pagesOf([before]).fetchPage });
    const result = await syncReviews(getDb(), { fetchPage: pagesOf([after]).fetchPage });

    assert.equal(result.updated, 0);
  });
});

describe('deciding a review is gone', () => {
  /** Two reviews on record, then a crawl that no longer shows one of them. */
  async function seedTwoThenLose(second: string[], options: { full?: boolean } = {}) {
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1'), review('2')])]).fetchPage,
    });
    return syncReviews(getDb(), {
      full: true,
      ...options,
      fetchPage: pagesOf(second).fetchPage,
    });
  }

  it('marks a review removed when a complete sweep no longer sees it', async () => {
    const result = await seedTwoThenLose([fakePage([review('1')], { ratingCount: 1 })]);

    assert.equal(result.removed, 1);
    assert.deepEqual(liveIds(), ['1']);

    const gone = getDb()
      .prepare('SELECT rating, body, removed_at FROM app_reviews WHERE review_id = ?')
      .get('2') as { rating: number; body: string; removed_at: string };
    // Preserved in full — the whole reason this table is not rebuilt.
    assert.equal(gone.body, 'Review 2');
    assert.equal(gone.rating, 5);
    assert.ok(gone.removed_at);
  });

  it('marks nothing when a page of the sweep failed', async () => {
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1'), review('2')])]).fetchPage,
    });

    // Page 1 says there is more to come, and page 2 never arrives.
    const result = await syncReviews(getDb(), {
      full: true,
      fetchPage: async (_handle, page) => {
        if (page === 1) return fakePage([review('1')], { hasNext: true, ratingCount: 2 });
        throw new Error('network blew up');
      },
    });

    assert.equal(result.removed, 0);
    assert.deepEqual(liveIds(), ['1', '2']);
  });

  it('marks nothing when the sweep came back short of the listing count', async () => {
    // Every fetch succeeds and the walk reaches the end, but the listing says it
    // holds 20 reviews and only one came back.
    const result = await seedTwoThenLose([fakePage([review('1')], { ratingCount: 20 })]);

    assert.equal(result.removed, 0);
    assert.deepEqual(liveIds(), ['1', '2']);
  });

  it('un-removes a review that comes back', async () => {
    await seedTwoThenLose([fakePage([review('1')], { ratingCount: 1 })]);
    assert.deepEqual(liveIds(), ['1']);

    await syncReviews(getDb(), {
      full: true,
      fetchPage: pagesOf([fakePage([review('1'), review('2')])]).fetchPage,
    });

    assert.deepEqual(liveIds(), ['1', '2']);
    const row = getDb()
      .prepare('SELECT removed_at FROM app_reviews WHERE review_id = ?')
      .get('2') as { removed_at: string | null };
    assert.equal(row.removed_at, null);
  });
});

describe('linking a review to a customer', () => {
  /** Shop 10 is called "Shop 10" by the seed helper and installed the app. */
  function seedInstaller() {
    return seed(
      [{ chargeRef: 'c1', shopId: '10', amount: 25, activatedAt: '2024-01-05T00:00:00Z' }],
      { installs: [{ shopId: '10', at: '2024-01-01T00:00:00Z' }] },
    );
  }

  it('links a review whose store name matches exactly one installer', async () => {
    seedInstaller();
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1', { store: 'shop 10' })])]).fetchPage,
    });
    matchReviewsToShops(getDb());

    const row = getDb()
      .prepare('SELECT shop_id, match_method FROM app_reviews WHERE review_id = ?')
      .get('1') as { shop_id: string; match_method: string };
    assert.equal(row.shop_id, '10');
    assert.equal(row.match_method, 'auto');
  });

  it('leaves a review unlinked when no installer answers to that name', async () => {
    seedInstaller();
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1', { store: 'Somebody Else' })])]).fetchPage,
    });
    matchReviewsToShops(getDb());

    const row = getDb()
      .prepare('SELECT shop_id, match_method FROM app_reviews WHERE review_id = ?')
      .get('1') as { shop_id: string; match_method: string };
    assert.equal(row.shop_id, '');
    assert.equal(row.match_method, 'none');
  });

  it('never overwrites a link a human made', async () => {
    seedInstaller();
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1', { store: 'Somebody Else' })])]).fetchPage,
    });

    assert.equal(setReviewShop(getDb(), '1', '10'), true);
    matchReviewsToShops(getDb());

    const row = getDb()
      .prepare('SELECT shop_id, match_method FROM app_reviews WHERE review_id = ?')
      .get('1') as { shop_id: string; match_method: string };
    assert.equal(row.shop_id, '10');
    assert.equal(row.match_method, 'manual');
  });
});

describe('compiling reviews onto the customer timeline', () => {
  it('emits a posted event, dated to the review and not to the crawl', async () => {
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1', { date: 'March 3, 2024' })])]).fetchPage,
    });
    rebuildDerivedTables(getDb());

    const row = getDb()
      .prepare('SELECT event_id, type, occurred_at, detail FROM customer_events WHERE type = ?')
      .get('review_posted') as {
      event_id: string;
      occurred_at: string;
      detail: string;
    };
    assert.equal(row.event_id, 'review:1:posted');
    assert.equal(row.occurred_at, '2024-03-03T00:00:00.000Z');
    assert.equal(JSON.parse(row.detail).rating, 5);
  });

  it('gives an unmatched review an event anyway, with no shop', async () => {
    await syncReviews(getDb(), { fetchPage: pagesOf([fakePage([review('1')])]).fetchPage });
    rebuildDerivedTables(getDb());

    const row = getDb()
      .prepare('SELECT shop_id FROM customer_events WHERE event_id = ?')
      .get('review:1:posted') as { shop_id: string };
    assert.equal(row.shop_id, '');
  });

  it('gives each rewrite its own event id, so a second edit is still news', async () => {
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1', { body: 'First' })])]).fetchPage,
    });
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1', { body: 'Second' })])]).fetchPage,
    });
    rebuildDerivedTables(getDb());
    const firstEdit = getDb()
      .prepare("SELECT event_id FROM customer_events WHERE type = 'review_edited'")
      .get() as { event_id: string };

    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1', { body: 'Third' })])]).fetchPage,
    });
    rebuildDerivedTables(getDb());
    const secondEdit = getDb()
      .prepare("SELECT event_id FROM customer_events WHERE type = 'review_edited'")
      .get() as { event_id: string };

    assert.notEqual(firstEdit.event_id, secondEdit.event_id);
  });

  it('emits a removed event once the review is gone', async () => {
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1'), review('2')])]).fetchPage,
    });
    await syncReviews(getDb(), {
      full: true,
      fetchPage: pagesOf([fakePage([review('1')], { ratingCount: 1 })]).fetchPage,
    });
    rebuildDerivedTables(getDb());

    const row = getDb()
      .prepare('SELECT event_id, type FROM customer_events WHERE event_id = ?')
      .get('review:2:removed') as { type: string } | undefined;
    assert.equal(row?.type, 'review_removed');
  });
});

describe('announcing a review', () => {
  let sent: Array<{ text: string; blocks: unknown[] }> = [];
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    sent = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response('ok', { status: 200 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** A channel subscribed to reviews, watermarked before the fixture dates. */
  function reviewChannel(): string {
    const db = getDb();
    const channel = createChannel(
      { name: '#reviews', webhookUrl: 'https://hooks.slack.com/services/T1/B1/secret123' },
      db,
    );
    setTopic(channel.id, APP_REVIEW_EVENTS.key, true, db);
    db.prepare(
      'UPDATE notification_subscriptions SET enabled_at = ? WHERE channel_id = ? AND topic = ?',
    ).run('2020-01-01T00:00:00.000Z', channel.id, APP_REVIEW_EVENTS.key);
    return channel.id;
  }

  it('sends a new review once, and never again', async () => {
    reviewChannel();
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1', { rating: 1, body: 'Broke my store' })])]).fetchPage,
    });
    rebuildDerivedTables(getDb());

    const first = await dispatchPending(getDb());
    assert.equal(first.sent, 1);
    assert.match(sent[0]!.text, /New review/);
    assert.match(sent[0]!.text, /1\/5/);
    assert.match(JSON.stringify(sent[0]!.blocks), /Broke my store/);
    // A one-star has to be distinguishable from a five-star at a glance.
    assert.match(JSON.stringify(sent[0]!.blocks), /rotating_light/);

    // The rebuild rewrites every row it just read; the ledger is what stops the
    // same review being announced again on the next pass.
    rebuildDerivedTables(getDb());
    const second = await dispatchPending(getDb());
    assert.equal(second.sent, 0);
  });

  it('says a review is gone without saying who took it down', async () => {
    reviewChannel();
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1'), review('2')])]).fetchPage,
    });
    rebuildDerivedTables(getDb());
    await dispatchPending(getDb());
    sent = [];

    await syncReviews(getDb(), {
      full: true,
      fetchPage: pagesOf([fakePage([review('1')], { ratingCount: 1 })]).fetchPage,
    });
    rebuildDerivedTables(getDb());
    await dispatchPending(getDb());

    const removal = sent.find((message) => /no longer on the listing/i.test(message.text));
    assert.ok(removal, `expected a removal message, got: ${sent.map((m) => m.text).join(' | ')}`);
    const body = JSON.stringify(removal.blocks);
    assert.match(body, /Shopify removing it, the merchant deleting it, and the store closing/);
    // The claim we cannot support must not appear anywhere in the message.
    assert.doesNotMatch(body, /purged/i);
  });

  it('reports an edit as the rating it moved between', async () => {
    reviewChannel();
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1', { rating: 5 })])]).fetchPage,
    });
    rebuildDerivedTables(getDb());
    await dispatchPending(getDb());
    sent = [];

    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1', { rating: 1, body: 'Changed my mind' })])])
        .fetchPage,
    });
    rebuildDerivedTables(getDb());
    await dispatchPending(getDb());

    const edit = sent.find((message) => /Review edited/.test(message.text));
    assert.ok(edit, 'expected an edit message');
    // Stars before and after: an edit with no direction is not news.
    assert.match(JSON.stringify(edit.blocks), /★★★★★.*→/);
  });
});

describe('the customer’s apps', () => {
  /**
   * Shop 10 pays for the app under test and has installed a second one it has
   * never paid a penny for — the row the page used to drop entirely.
   */
  function seedTwoApps() {
    // Reporting scope is normally pinned to the one fixture app; this case is
    // about a *second* one, so the scope has to be every app discovered.
    resetEnvironment({ PARTNER_APP_IDS: '', APP_STORE_HANDLES: `${APP_ID}:${HANDLE}` });

    seed([{ chargeRef: 'c1', shopId: '10', amount: 25, activatedAt: '2024-01-05T00:00:00Z', firstSaleAt: '2024-01-05T00:00:00Z' }], {
      installs: [{ shopId: '10', at: '2024-01-01T00:00:00Z' }],
    });

    const db = getDb();
    db.prepare(
      "INSERT OR IGNORE INTO apps (id, name, api_key, discovered_at) VALUES ('999', 'Free App', NULL, '2024-01-01T00:00:00Z')",
    ).run();
    insertAppEvents(db, '999', [
      {
        type: 'RELATIONSHIP_INSTALLED',
        occurredAt: '2024-02-01T00:00:00Z',
        __typename: 'RelationshipInstalled',
        shop: { id: 'gid://partners/Shop/10', name: 'Shop 10', myshopifyDomain: 's10.example' },
        charge: null,
      },
    ]);
    rebuildDerivedTables(db);
  }

  const appsOf = (shopId = '10') => {
    const detail = getCustomer(shopId, { appIds: [] });
    assert.ok(detail, 'expected the merchant to exist');
    return new Map(detail.apps.map((app) => [app.appId, app]));
  };

  it('lists an app the merchant installed and never paid for', () => {
    seedTwoApps();
    const free = appsOf().get('999');

    assert.equal(free?.status, 'installed');
    assert.equal(free?.planName, null);
    assert.equal(free?.mrr, 0);
    assert.equal(free?.paymentCount, 0);
    // The name has to come from the apps table: with no subscription there is
    // nothing else carrying it.
    assert.equal(free?.appName, 'Free App');
    assert.equal(free?.since?.slice(0, 10), '2024-02-01');
  });

  it('shows what a paying app is on, on the same gate MRR uses', () => {
    seedTwoApps();
    const paid = appsOf().get(APP_ID);

    assert.equal(paid?.status, 'paying');
    assert.equal(paid?.amount, 25);
    assert.equal(paid?.mrr, 25);
    assert.equal(paid?.paymentCount, 1);
    // The install predates the subscription, and that is when they arrived.
    assert.equal(paid?.since?.slice(0, 10), '2024-01-01');
  });

  it('hangs the review off the app it is about', async () => {
    seedTwoApps();
    setListing(APP_ID, 'https://apps.shopify.com/paid-app', { db: getDb() });
    await syncReviews(getDb(), {
      fetchPage: pagesOf([fakePage([review('1', { store: 'Shop 10', rating: 4 })])]).fetchPage,
    });
    rebuildDerivedTables(getDb());

    const apps = appsOf();
    assert.equal(apps.get(APP_ID)?.review?.rating, 4);
    // The other app has no review, and the listing it would be written on is
    // what the "ask for one" link is built from.
    assert.equal(apps.get('999')?.review, null);
    assert.equal(apps.get(APP_ID)?.listingUrl, 'https://apps.shopify.com/paid-app');
  });

  it('prefers a review still on the listing over one that is gone', async () => {
    seedTwoApps();
    setListing(APP_ID, 'https://apps.shopify.com/paid-app', { db: getDb() });
    await syncReviews(getDb(), {
      fetchPage: pagesOf([
        fakePage([
          review('2', { store: 'Shop 10', rating: 1, date: 'March 1, 2024' }),
          review('1', { store: 'Shop 10', rating: 5, date: 'February 1, 2024' }),
        ]),
      ]).fetchPage,
    });
    // The newer one-star is taken down; the older five-star still stands.
    await syncReviews(getDb(), {
      full: true,
      fetchPage: pagesOf([
        fakePage([review('1', { store: 'Shop 10', rating: 5, date: 'February 1, 2024' })], {
          ratingCount: 1,
        }),
      ]).fetchPage,
    });
    rebuildDerivedTables(getDb());

    const shown = appsOf().get(APP_ID)?.review;
    // A removal must not hide what the merchant is publicly saying today, even
    // though the removed one is the more recent of the two.
    assert.equal(shown?.reviewId, '1');
    assert.equal(shown?.removedAt, null);
  });
});

describe('review metrics', () => {
  /** Reviews spread across three months, one of them later removed. */
  async function seedHistory() {
    await syncReviews(getDb(), {
      fetchPage: pagesOf([
        fakePage([
          review('1', { rating: 5, date: 'January 10, 2024' }),
          review('2', { rating: 1, date: 'February 10, 2024' }),
          review('3', { rating: 5, date: 'March 10, 2024' }),
        ]),
      ]).fetchPage,
    });
    await syncReviews(getDb(), {
      full: true,
      fetchPage: pagesOf([
        fakePage(
          [
            review('1', { rating: 5, date: 'January 10, 2024' }),
            review('3', { rating: 5, date: 'March 10, 2024' }),
          ],
          { ratingCount: 2 },
        ),
      ]).fetchPage,
    });
  }

  const query = {
    period: 'custom',
    start: '2024-01-01T00:00:00Z',
    end: '2024-04-01T00:00:00Z',
    interval: 'month',
  };

  it('counts reviews in the month they were posted, not the month we found them', async () => {
    await seedHistory();
    const response = runMetric('reviews_posted', query);

    assert.equal(response.value, 3);
    const january = response.timeSeries.find((point) => point.periodStart.startsWith('2024-01'));
    assert.equal(january?.value, 1);
  });

  it('reconstructs the live count as of each month', async () => {
    await seedHistory();
    const response = runMetric('reviews_live', query);

    const byMonth = (month: string) =>
      response.timeSeries.find((point) => point.periodStart.startsWith(month))?.value;

    // One in January, two by February, three by March — then the one-star is
    // removed today, which is after every bucket, so history is unaffected.
    assert.equal(byMonth('2024-01'), 1);
    assert.equal(byMonth('2024-02'), 2);
    assert.equal(byMonth('2024-03'), 3);
  });

  it('averages the ratings that were live at the instant', async () => {
    await seedHistory();
    const response = runMetric('reviews_average_rating', query);

    const february = response.timeSeries.find((point) =>
      point.periodStart.startsWith('2024-02'),
    )?.value;
    // 5 and 1 were both live at the end of February.
    assert.equal(february, 3);
  });

  it('narrows every review report to one star rating', async () => {
    await seedHistory();
    const oneStar = { ...query, rating: '1' };

    // Seeded: a 5-star in January, a 1-star in February, a 5-star in March.
    // (The one-star's removal is dated to the crawl, which is outside this
    // window, so `reviews_removed` is a question about the window rather than
    // about the filter and is covered on its own above.)
    assert.equal(runMetric('reviews_posted', oneStar).value, 1);
    assert.equal(runMetric('reviews_live', oneStar).value, 1);
    assert.equal(runMetric('reviews_average_rating', oneStar).value, 1);

    // The parts have to add back up to the whole, or the filter is lying about
    // one of the cards on the page.
    const five = runMetric('reviews_posted', { ...query, rating: '5' }).value;
    assert.equal(runMetric('reviews_posted', query).value, five + 1);
  });

  it('drops the published rating when a star filter is on', async () => {
    await seedHistory();
    // Shopify publishes one figure for the whole listing. Showing it beside a
    // filtered average would read as drift between us and them.
    assert.equal(runMetric('reviews_average_rating', query).meta?.publishedRating, 4.5);
    assert.ok(!('publishedRating' in (runMetric('reviews_average_rating', { ...query, rating: '5' }).meta ?? {})));
  });

  it('refuses a rating that is not a star', () => {
    for (const rating of ['9', '0.5', 'five']) {
      assert.throws(() => runMetric('reviews_posted', { ...query, rating }), MetricRequestError);
    }
  });

  it('records how far back a removal could have been noticed', async () => {
    await seedHistory();
    const response = runMetric('reviews_removed', query);
    assert.ok(
      typeof response.meta?.removalsKnownFrom === 'string',
      'the horizon before which removals are unknowable must be stated',
    );
  });
});
