import { getConfig } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { fetchReviewsPage } from './client.js';
import { parseReviewsPage } from './parse.js';

/**
 * Which listing belongs to which app.
 *
 * An organization has many apps, and nothing in the Partner API connects any of
 * them to the page merchants actually see — so this mapping cannot be derived,
 * only supplied. It used to live in an environment variable, which made it a
 * deployment concern for something that is really just a fact the partner knows
 * and might change on a Tuesday. It lives in the database now, and the
 * dashboard is where it is entered.
 *
 * Everything the listing page can eventually tell us hangs off these rows, not
 * only the reviews that read from them today.
 */

export class ListingError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ListingError';
    this.status = status;
  }
}

const HOST = 'apps.shopify.com';

/**
 * Paths on the App Store that are not an app.
 *
 * A partner browsing the store and copying whatever is in the address bar can
 * easily land on one of these, and `apps.shopify.com/categories/...` looks
 * exactly like a listing URL to a naive first-segment parse.
 */
const RESERVED = new Set([
  'categories',
  'collections',
  'search',
  'stories',
  'partners',
  'browse',
  'account',
  'login',
]);

/**
 * The listing slug out of whatever the partner pasted.
 *
 * Accepts the full URL, the URL with a path or query hanging off it, the bare
 * host and slug, or the slug on its own — because all four are things people
 * genuinely paste, and refusing three of them teaches nothing.
 */
export function parseListingUrl(input: string): { handle: string; url: string } {
  const raw = input.trim();
  if (!raw) throw new ListingError('Enter the App Store listing URL for this app.');

  let path = raw;

  if (/^https?:\/\//i.test(raw) || raw.toLowerCase().startsWith(`${HOST}/`) || raw.toLowerCase() === HOST) {
    let parsed: URL;
    try {
      parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      throw new ListingError(`"${raw}" is not a URL.`);
    }
    if (parsed.hostname.toLowerCase().replace(/^www\./, '') !== HOST) {
      throw new ListingError(
        `App Store listings live on ${HOST}; that URL points at ${parsed.hostname}.`,
      );
    }
    path = parsed.pathname;
  }

  const handle = path.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';

  if (!handle) {
    throw new ListingError(
      `That URL has no app in it. A listing looks like https://${HOST}/your-app-handle.`,
    );
  }
  if (RESERVED.has(handle)) {
    throw new ListingError(
      `"${handle}" is a section of the App Store, not an app. Open your app's own page and copy that URL.`,
    );
  }
  // Slugs are lowercase letters, digits and hyphens. Anything else means a
  // fragment of a URL we did not understand, and guessing would produce a
  // crawler that 404s on every run without saying why.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) {
    throw new ListingError(
      `"${handle}" is not an App Store handle. It is the slug in https://${HOST}/<handle>.`,
    );
  }

  return { handle, url: `https://${HOST}/${handle}` };
}

export interface AppListing {
  appId: string;
  /** The app's name from the Partner API, when it has been synced. */
  appName: string | null;
  handle: string;
  url: string;
  source: 'manual' | 'config';
  /** The listing's own title, from the last check. */
  listingName: string | null;
  checkedAt: string | null;
  lastError: string | null;
  /** Reviews held locally for this app, so the page can show it is working. */
  reviewCount: number;
}

interface ListingRow {
  appId: string;
  appName: string | null;
  handle: string;
  url: string;
  source: string;
  listingName: string | null;
  checkedAt: string | null;
  lastError: string | null;
  reviewCount: number;
}

const SELECT = `
  SELECT l.app_id       AS appId,
         a.name         AS appName,
         l.handle       AS handle,
         l.url          AS url,
         l.source       AS source,
         l.listing_name AS listingName,
         l.checked_at   AS checkedAt,
         l.last_error   AS lastError,
         (SELECT COUNT(*) FROM app_reviews r WHERE r.app_id = l.app_id) AS reviewCount
    FROM app_listings l
    LEFT JOIN apps a ON a.id = l.app_id`;

function toListing(row: ListingRow): AppListing {
  return { ...row, source: row.source === 'config' ? 'config' : 'manual' };
}

export function listListings(db: Db = getDb()): AppListing[] {
  const rows = db.prepare(`${SELECT} ORDER BY COALESCE(a.name, l.app_id)`).all() as ListingRow[];
  return rows.map(toListing);
}

export function getListing(appId: string, db: Db = getDb()): AppListing | null {
  const row = db.prepare(`${SELECT} WHERE l.app_id = ?`).get(appId) as ListingRow | undefined;
  return row ? toListing(row) : null;
}

/** App id → handle, which is all the crawler needs. */
export function listingHandles(db: Db = getDb()): Record<string, string> {
  const rows = db.prepare('SELECT app_id, handle FROM app_listings').all() as Array<{
    app_id: string;
    handle: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.app_id, row.handle]));
}

export function setListing(
  appId: string,
  input: string,
  options: { source?: 'manual' | 'config'; db?: Db } = {},
): AppListing {
  const db = options.db ?? getDb();
  const id = appId.trim().split('/').pop() ?? '';
  if (!id) throw new ListingError('Choose which app this listing belongs to.');

  const { handle, url } = parseListingUrl(input);

  // Two apps cannot share a listing. Left unchecked this is a quiet disaster:
  // the same reviews would be ingested under both app ids and every review
  // count would read double.
  const clash = db
    .prepare('SELECT app_id FROM app_listings WHERE handle = ? AND app_id <> ?')
    .get(handle, id) as { app_id: string } | undefined;
  if (clash) {
    throw new ListingError(`That listing is already mapped to app ${clash.app_id}.`);
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO app_listings (app_id, handle, url, source, created_at, updated_at)
     VALUES (@id, @handle, @url, @source, @now, @now)
     ON CONFLICT(app_id) DO UPDATE SET
       handle     = excluded.handle,
       url        = excluded.url,
       source     = excluded.source,
       updated_at = excluded.updated_at,
       -- A new URL invalidates what the old one told us.
       listing_name = CASE WHEN app_listings.handle = excluded.handle
                           THEN app_listings.listing_name END,
       checked_at   = CASE WHEN app_listings.handle = excluded.handle
                           THEN app_listings.checked_at END,
       last_error   = CASE WHEN app_listings.handle = excluded.handle
                           THEN app_listings.last_error END`,
  ).run({ id, handle, url, source: options.source ?? 'manual', now });

  return getListing(id, db)!;
}

/**
 * Forget a listing.
 *
 * The reviews already collected under it are deliberately left alone. They are
 * the only surviving copy of anything the App Store has since taken down, and
 * unmapping an app is not a statement about its history.
 */
export function removeListing(appId: string, db: Db = getDb()): boolean {
  return db.prepare('DELETE FROM app_listings WHERE app_id = ?').run(appId).changes > 0;
}

/**
 * Fetch the listing and report what is actually there.
 *
 * The equivalent of the notification channels' "send a test": a handle typo
 * costs nothing at save time and everything at sync time, when it surfaces as
 * an app that quietly has no reviews. One request answers it immediately, and
 * the listing's own title is the confirmation that this is the right app.
 */
export async function checkListing(appId: string, db: Db = getDb()): Promise<AppListing> {
  const listing = getListing(appId, db);
  if (!listing) throw new ListingError(`No listing mapped for app ${appId}.`, 404);

  const now = new Date().toISOString();
  try {
    const page = parseReviewsPage(await fetchReviewsPage(listing.handle, 1));
    db.prepare(
      'UPDATE app_listings SET listing_name = ?, checked_at = ?, last_error = NULL WHERE app_id = ?',
    ).run(page.listingName, now, appId);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    db.prepare('UPDATE app_listings SET checked_at = ?, last_error = ? WHERE app_id = ?').run(
      now,
      message.slice(0, 300),
      appId,
    );
  }

  return getListing(appId, db)!;
}

/**
 * Carry `APP_STORE_HANDLES` into the table, for apps that have no row yet.
 *
 * The variable stays supported because a container that comes up with an empty
 * volume should not need someone to open the dashboard before it can sync. It
 * seeds rather than overrides: once a row exists, whoever is looking at the
 * page owns it, and a stale value in the environment cannot silently undo an
 * edit made in the UI.
 */
export function seedListingsFromConfig(db: Db = getDb()): number {
  const { scope } = getConfig();
  let seeded = 0;

  for (const [appId, handle] of Object.entries(scope.appStoreHandles)) {
    const existing = db.prepare('SELECT 1 FROM app_listings WHERE app_id = ?').get(appId);
    if (existing) continue;
    try {
      setListing(appId, handle, { source: 'config', db });
      seeded += 1;
    } catch (cause) {
      // A bad pair in the environment must not stop the process from starting;
      // it shows up on the listings page as the app that is missing from it.
      console.warn(`[partnerdex] Ignoring APP_STORE_HANDLES entry for app ${appId}: ${String(cause)}`);
    }
  }

  return seeded;
}
