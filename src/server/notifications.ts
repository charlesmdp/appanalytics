import express from 'express';
import { getDb } from '../db/index.js';
import { dispatchPending } from '../notifications/dispatch.js';
import { buildTestMessage, postToSlack } from '../notifications/slack.js';
import {
  createChannel,
  deleteChannel,
  getChannel,
  listChannels,
  NotificationError,
  setTopic,
  updateChannel,
  webhookUrlFor,
} from '../notifications/store.js';
import { TOPICS } from '../notifications/topics.js';
import { sendError } from './errors.js';

/**
 * The notifications API.
 *
 * Webhook URLs go in and never come back out: every response describes a
 * channel by name and by a masked hint, so a dashboard left open on a shared
 * screen cannot be read for a credential that posts into the team's Slack.
 */

function stringField(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new NotificationError(`"${name}" must be a string.`);
  return value;
}

export function notificationsRouter(): express.Router {
  const router = express.Router();

  /** Everything the page renders: the toggles that exist, and who has them on. */
  router.get('/', (_request, response) => {
    try {
      response.json({ topics: TOPICS, channels: listChannels(getDb()) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/channels', (request, response) => {
    try {
      const name = stringField(request.body, 'name') ?? '';
      const webhookUrl = stringField(request.body, 'webhookUrl') ?? '';
      response.status(201).json(createChannel({ name, webhookUrl }, getDb()));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.patch('/channels/:id', (request, response) => {
    try {
      response.json(
        updateChannel(
          request.params.id,
          {
            name: stringField(request.body, 'name'),
            webhookUrl: stringField(request.body, 'webhookUrl'),
          },
          getDb(),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.delete('/channels/:id', (request, response) => {
    try {
      deleteChannel(request.params.id, getDb());
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  router.put('/channels/:id/topics/:topic', (request, response) => {
    try {
      const body = request.body as { enabled?: unknown } | undefined;
      if (typeof body?.enabled !== 'boolean') {
        throw new NotificationError('"enabled" must be true or false.');
      }
      response.json(setTopic(request.params.id, request.params.topic, body.enabled, getDb()));
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Prove the webhook works before trusting it with something that matters.
   *
   * A webhook is pasted, not typed, and the usual failures — a revoked URL, a
   * channel that was archived — are invisible until the first real event is
   * lost. This turns that into an answer on the spot.
   */
  router.post('/channels/:id/test', async (request, response) => {
    try {
      const db = getDb();
      const channel = getChannel(request.params.id, db);
      if (!channel) throw new NotificationError(`No channel with id ${request.params.id}.`, 404);

      const url = webhookUrlFor(channel.id, db)!;
      const result = await postToSlack(url, buildTestMessage(channel.name));

      // Recorded like any other delivery, so a failing webhook says so on the
      // page rather than only in this one response.
      db.prepare(
        `UPDATE notification_channels
            SET last_error = @error,
                last_error_at = CASE WHEN @error IS NULL THEN NULL ELSE @at END
          WHERE id = @id`,
      ).run({ id: channel.id, error: result.error, at: new Date().toISOString() });

      response.json({ ok: result.ok, error: result.error, channel: getChannel(channel.id, db) });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Send whatever is owing right now instead of waiting for the next sync.
   * Same code path the sync loop uses, ledger and all, so it cannot duplicate.
   */
  router.post('/dispatch', async (_request, response) => {
    try {
      response.json(await dispatchPending(getDb()));
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
