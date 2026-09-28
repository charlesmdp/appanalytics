import crypto from 'node:crypto';
import { getDb, type Db } from '../db/index.js';
import { topicByKey, TOPICS } from './topics.js';

/**
 * Channels and their subscriptions.
 *
 * The webhook URL is a bearer credential — anyone holding it can post into the
 * channel — so it travels in one direction only. `ChannelSummary` is what the
 * API returns and it carries a hint, never the URL. Reading one back requires
 * `webhookUrlFor`, which only the sender calls.
 */

export class NotificationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ChannelSummary {
  id: string;
  name: string;
  /** Enough of the URL to tell two webhooks apart, and no more. */
  webhookHint: string;
  createdAt: string;
  lastDeliveryAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Topic keys currently switched on. */
  topics: string[];
}

interface ChannelRow {
  id: string;
  name: string;
  webhook_url: string;
  created_at: string;
  last_delivery_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

/**
 * Slack issues incoming webhooks as `https://hooks.slack.com/services/T…/B…/…`,
 * where the last segment is the secret. Anything else that speaks the same
 * payload — Mattermost, a self-hosted relay — is accepted too, because rejecting
 * it would buy no security and cost compatibility. What is *not* accepted is
 * plain HTTP: the secret is in the path, so an unencrypted webhook leaks itself
 * to every hop on the way.
 */
export function normalizeWebhookUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new NotificationError('A webhook URL is required.');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new NotificationError(`"${trimmed}" is not a valid URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new NotificationError(
      'A webhook URL must use https. The secret is part of the URL, so http would send it in the clear.',
    );
  }
  return url.toString();
}

/**
 * The last path segment, mostly masked, prefixed by the host. Slack's own UI
 * identifies a webhook the same way, so this is what a reader recognizes.
 */
export function webhookHint(url: string): string {
  try {
    const parsed = new URL(url);
    const secret = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    const tail = secret.length > 4 ? secret.slice(-4) : '';
    return `${parsed.host}/…${tail ? `${tail}` : ''}`;
  } catch {
    return 'invalid url';
  }
}

function summarize(row: ChannelRow, topics: string[]): ChannelSummary {
  return {
    id: row.id,
    name: row.name,
    webhookHint: webhookHint(row.webhook_url),
    createdAt: row.created_at,
    lastDeliveryAt: row.last_delivery_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    topics,
  };
}

function topicsByChannel(db: Db): Map<string, string[]> {
  const rows = db
    .prepare('SELECT channel_id, topic FROM notification_subscriptions')
    .all() as Array<{ channel_id: string; topic: string }>;
  const map = new Map<string, string[]>();
  for (const row of rows) {
    // A topic removed from the code should not haunt the UI as a toggle that
    // does not exist any more.
    if (!topicByKey(row.topic)) continue;
    const list = map.get(row.channel_id);
    if (list) list.push(row.topic);
    else map.set(row.channel_id, [row.topic]);
  }
  return map;
}

export function listChannels(db: Db = getDb()): ChannelSummary[] {
  const rows = db
    .prepare('SELECT * FROM notification_channels ORDER BY created_at')
    .all() as ChannelRow[];
  const topics = topicsByChannel(db);
  return rows.map((row) => summarize(row, topics.get(row.id) ?? []));
}

export function getChannel(id: string, db: Db = getDb()): ChannelSummary | null {
  const row = db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(id) as
    | ChannelRow
    | undefined;
  if (!row) return null;
  const topics = db
    .prepare('SELECT topic FROM notification_subscriptions WHERE channel_id = ?')
    .all(id) as Array<{ topic: string }>;
  return summarize(
    row,
    topics.map((t) => t.topic).filter((key) => topicByKey(key)),
  );
}

/** Sender-only. Everything user-facing goes through `ChannelSummary`. */
export function webhookUrlFor(id: string, db: Db = getDb()): string | null {
  const row = db.prepare('SELECT webhook_url FROM notification_channels WHERE id = ?').get(id) as
    | { webhook_url: string }
    | undefined;
  return row?.webhook_url ?? null;
}

function requireName(raw: string): string {
  const name = (raw ?? '').trim();
  if (!name) throw new NotificationError('A channel name is required.');
  if (name.length > 80) throw new NotificationError('Channel names are limited to 80 characters.');
  return name;
}

export function createChannel(
  input: { name: string; webhookUrl: string },
  db: Db = getDb(),
): ChannelSummary {
  const name = requireName(input.name);
  const url = normalizeWebhookUrl(input.webhookUrl);

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO notification_channels (id, name, webhook_url, created_at)
     VALUES (@id, @name, @url, @createdAt)`,
  ).run({ id, name, url, createdAt: new Date().toISOString() });

  return getChannel(id, db)!;
}

export function updateChannel(
  id: string,
  patch: { name?: string; webhookUrl?: string },
  db: Db = getDb(),
): ChannelSummary {
  const existing = getChannel(id, db);
  if (!existing) throw new NotificationError(`No channel with id ${id}.`, 404);

  const name = patch.name === undefined ? existing.name : requireName(patch.name);
  const url =
    patch.webhookUrl === undefined || patch.webhookUrl === ''
      ? webhookUrlFor(id, db)!
      : normalizeWebhookUrl(patch.webhookUrl);

  // A new URL is a new destination, so whatever the old one failed at is no
  // longer true of this channel.
  const clearError = url !== webhookUrlFor(id, db);

  db.prepare(
    `UPDATE notification_channels
        SET name = @name,
            webhook_url = @url,
            last_error = CASE WHEN @clearError THEN NULL ELSE last_error END,
            last_error_at = CASE WHEN @clearError THEN NULL ELSE last_error_at END
      WHERE id = @id`,
  ).run({ id, name, url, clearError: clearError ? 1 : 0 });

  return getChannel(id, db)!;
}

/**
 * Deletes the channel and, by cascade, its subscriptions and delivery ledger.
 *
 * Dropping the ledger with the channel is the right trade: the ids only mean
 * "already told this webhook", and the webhook is going away. Re-adding the
 * same URL later starts from a fresh watermark, so nothing is replayed.
 */
export function deleteChannel(id: string, db: Db = getDb()): void {
  const result = db.prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
  if (result.changes === 0) throw new NotificationError(`No channel with id ${id}.`, 404);
}

/**
 * Turn a topic on or off for one channel.
 *
 * Switching on stamps the watermark at *now*, so a channel is told what happens
 * next rather than everything that ever happened. Switching a topic off and on
 * again deliberately does the same: the quiet stretch stays quiet instead of
 * arriving all at once.
 */
export function setTopic(
  channelId: string,
  topicKey: string,
  enabled: boolean,
  db: Db = getDb(),
): ChannelSummary {
  if (!getChannel(channelId, db)) {
    throw new NotificationError(`No channel with id ${channelId}.`, 404);
  }
  if (!topicByKey(topicKey)) {
    throw new NotificationError(
      `Unknown topic "${topicKey}". Known topics: ${TOPICS.map((t) => t.key).join(', ')}.`,
    );
  }

  if (enabled) {
    db.prepare(
      `INSERT INTO notification_subscriptions (channel_id, topic, enabled_at)
       VALUES (?, ?, ?)
       ON CONFLICT(channel_id, topic) DO NOTHING`,
    ).run(channelId, topicKey, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM notification_subscriptions WHERE channel_id = ? AND topic = ?').run(
      channelId,
      topicKey,
    );
  }

  return getChannel(channelId, db)!;
}

export function recordDeliveryOutcome(
  channelId: string,
  outcome: { at: string; error: string | null },
  db: Db = getDb(),
): void {
  db.prepare(
    `UPDATE notification_channels
        SET last_delivery_at = CASE WHEN @error IS NULL THEN @at ELSE last_delivery_at END,
            last_error = @error,
            last_error_at = CASE WHEN @error IS NULL THEN NULL ELSE @at END
      WHERE id = @id`,
  ).run({ id: channelId, at: outcome.at, error: outcome.error });
}
