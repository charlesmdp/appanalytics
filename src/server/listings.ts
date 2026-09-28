import express from 'express';
import { getDb } from '../db/index.js';
import {
  checkListing,
  listListings,
  ListingError,
  removeListing,
  seedListingsFromConfig,
  setListing,
} from '../appstore/listings.js';
import { resolveScopedAppIds } from '../sync/index.js';
import { sendError } from './errors.js';

/**
 * The App Store listings API.
 *
 * Small on purpose. The whole feature is "which page belongs to which app",
 * and the only part that is not CRUD is the check — one request that proves a
 * pasted URL resolves to the app the partner meant, before a sync spends a
 * hundred requests finding out that it does not.
 */
export function listingsRouter(): express.Router {
  const router = express.Router();

  /**
   * Everything the page renders: the listings that exist, and the apps that
   * could have one. Apps come from whatever the sync has discovered, so the
   * dropdown offers real ids rather than asking anyone to find them.
   */
  router.get('/', (_request, response) => {
    try {
      const db = getDb();
      seedListingsFromConfig(db);

      const apps = db
        .prepare('SELECT id, name FROM apps ORDER BY name')
        .all() as Array<{ id: string; name: string }>;
      const scoped = new Set(resolveScopedAppIds(db));

      response.json({
        listings: listListings(db),
        // Only apps this install reports on: mapping a listing to an app that
        // every report filters out would produce reviews nothing ever shows.
        apps: apps.filter((app) => scoped.size === 0 || scoped.has(app.id)),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /** Map a listing to an app, or move it to a different URL. */
  router.put('/:appId', (request, response) => {
    try {
      const body = request.body as { url?: unknown };
      if (typeof body?.url !== 'string') {
        throw new ListingError('Send the listing URL as a string in "url".');
      }
      response.json(setListing(request.params.appId, body.url, { db: getDb() }));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.delete('/:appId', (request, response) => {
    try {
      if (!removeListing(request.params.appId, getDb())) {
        response.status(404).json({ error: `No listing mapped for app ${request.params.appId}.` });
        return;
      }
      // 204 rather than the row: there is nothing left to describe.
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Fetch the listing and report what is there.
   *
   * Answers with the listing either way — a failed check is recorded on the row
   * as `lastError` rather than thrown, because "this URL does not resolve" is
   * the answer the reader asked for, not an error in asking.
   */
  router.post('/:appId/check', (request, response) => {
    checkListing(request.params.appId, getDb())
      .then((listing) => response.json(listing))
      .catch((error: unknown) => sendError(response, error));
  });

  return router;
}
