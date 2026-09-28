import { APPS, type App, type Env, database, iso, DAY } from "./config.js";
import { getJob, checkpoint, statement, rows, type Job } from "./store.js";
import { page, PartnerError } from "./partner.js";
import { learnPrices, priceBook, rebuildShop } from "./derive.js";
import {
  gidTail,
  money,
  type AppEventNode,
  type TransactionNode,
} from "../../src/sync/ingest.js";
export function nextWindow(start: string, end: string) {
  const d = new Date(start);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return iso(new Date(Math.min(+next, Date.parse(end))));
}
export function windowCount(start: string, end: string) {
  let n = 0;
  for (let s = start; s < end; s = nextWindow(s, end)) n++;
  return n * 2;
}
export async function start(env: Env, app: App, full = false) {
  const db = database(env, app);
  const old = await getJob(db);
  if (old.status === "running") {
    await checkpoint(db, {
      paused: 0,
      error: null,
      failures: 0,
      retry_at: 0,
    }).run();
    await env.SYNC_QUEUE.send({ app: app.key });
    return;
  }
  if (old.status === "error") {
    await checkpoint(db, {
      status: "running",
      paused: 0,
      error: null,
      failures: 0,
      retry_at: 0,
    }).run();
    await env.SYNC_QUEUE.send({ app: app.key });
    return;
  }
  if (!env[app.secret])
    throw new Error(`Ajoute le secret ${app.secret} dans Cloudflare.`);
  const since =
    full || !old.last_success
      ? iso(app.since)
      : iso(
          new Date(
            Math.max(
              Date.parse(app.since),
              Date.parse(old.last_success) - 3 * DAY,
            ),
          ),
        );
  const now = iso(new Date());
  const signature = JSON.stringify([...(await priceBook(db, app))]);
  const patch: Partial<Job> = {
    status: "running",
    phase: "transactions",
    run_id: crypto.randomUUID(),
    since,
    until_at: now,
    window_start: since,
    window_end: nextWindow(since, now),
    cursor: null,
    windows_done: 0,
    windows_total: windowCount(since, now),
    pages: 0,
    records: 0,
    units_done: 0,
    units_total: 0,
    phase_cursor: "",
    started_at: now,
    phase_started_at: now,
    window_started_at: now,
    samples: "[]",
    lease: null,
    lease_until: 0,
    paused: 0,
    failures: 0,
    retry_at: 0,
    error: null,
    price_signature: signature,
  };
  // Optimistic version guard prevents two start requests resetting one another.
  const entries = Object.entries(patch);
  const changed = await statement(
    db,
    `UPDATE job SET ${entries.map(([k]) => `${k}=?`).join(",")},updated_at=?,version=version+1 WHERE id=1 AND version=?`,
    ...entries.map(([, v]) => v),
    now,
    old.version,
  ).run();
  if (changed.meta.changes) await env.SYNC_QUEUE.send({ app: app.key });
}
function ingest(
  db: D1Database,
  app: App,
  job: Job,
  nodes: (AppEventNode | TransactionNode)[],
) {
  const statements: D1PreparedStatement[] = [];
  const shops = new Set<string>();
  for (const node of nodes) {
    if (job.phase === "transactions") {
      const n = node as TransactionNode;
      if (gidTail(n.app?.id) !== app.appId)
        throw new Error("Shopify a renvoyé une transaction hors de cette app.");
      const shop = gidTail(n.shop?.id);
      const gross = money(n.grossAmount);
      const net = money(n.netAmount);
      statements.push(
        statement(
          db,
          `INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type,shop_id=excluded.shop_id,charge_ref=excluded.charge_ref,created_at=excluded.created_at,billing_interval=excluded.billing_interval,gross_amount=excluded.gross_amount,net_amount=excluded.net_amount,currency=excluded.currency`,
          n.id,
          n.__typename,
          app.appId,
          shop,
          gidTail(n.chargeId),
          iso(n.createdAt),
          n.billingInterval ?? null,
          gross.amount,
          net.amount,
          gross.currency || net.currency || "UNKNOWN",
        ),
      );
      if (shop) shops.add(shop);
    } else {
      const n = node as AppEventNode;
      const shop = gidTail(n.shop?.id);
      const charge = n.charge;
      const amount = money(charge?.amount);
      const at = iso(n.occurredAt);
      const key = JSON.stringify([n.type, at, charge?.id ?? "", shop]);
      statements.push(
        statement(
          db,
          `INSERT INTO app_events VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET charge_name=excluded.charge_name,charge_amount=excluded.charge_amount,charge_currency=excluded.charge_currency,charge_test=excluded.charge_test,billing_on=excluded.billing_on`,
          key,
          app.appId,
          shop,
          n.type,
          at,
          charge?.id ?? "",
          charge?.name ?? null,
          charge ? amount.amount : null,
          charge ? amount.currency : null,
          charge?.test ? 1 : 0,
          charge?.billingOn ? iso(charge.billingOn) : null,
        ),
      );
      if (shop) shops.add(shop);
    }
  }
  for (const shop of shops)
    statements.push(
      statement(db, "INSERT OR IGNORE INTO shops VALUES(?)", shop),
      statement(db, "INSERT OR IGNORE INTO dirty_shops VALUES(?)", shop),
    );
  return statements;
}
async function ingestPage(env: Env, app: App, db: D1Database, job: Job) {
  const result = await page(env, app, job);
  const writes = ingest(db, app, job, result.nodes);
  const now = iso(new Date());
  const patch: Partial<Job> = {
    cursor: result.cursor,
    pages: job.pages + 1,
    records: job.records + result.nodes.length,
    error: null,
    failures: 0,
    retry_at: 0,
  };
  if (!result.more) {
    patch.cursor = null;
    patch.windows_done = job.windows_done + 1;
    const samples = JSON.parse(job.samples) as number[];
    samples.push(
      Math.max(0.1, (Date.now() - Date.parse(job.window_started_at!)) / 1000),
    );
    patch.samples = JSON.stringify(samples.slice(-12));
    patch.window_started_at = now;
    if (job.phase === "transactions") patch.phase = "events";
    else if (job.window_end < job.until_at) {
      patch.phase = "transactions";
      patch.window_start = job.window_end;
      patch.window_end = nextWindow(job.window_end, job.until_at);
    } else {
      writes.push(
        statement(
          db,
          "INSERT OR IGNORE INTO dirty_shops SELECT shop_id FROM due_shops WHERE due_at<=?",
          job.until_at,
        ),
      );
      patch.phase = "pricing";
      patch.phase_started_at = now;
      patch.phase_cursor = "";
      patch.units_done = 0;
    }
  }
  writes.push(checkpoint(db, patch, job.lease!));
  // Cursor and raw rows commit together. Queue redelivery never advances past an unwritten page.
  if (patch.phase === "pricing")
    writes.push(
      statement(
        db,
        "UPDATE job SET units_total=(SELECT COUNT(*) FROM dirty_shops) WHERE id=1 AND lease=?",
        job.lease,
      ),
    );
  await db.batch(writes);
  return writes.length + 4;
}
async function deriveStep(
  db: D1Database,
  app: App,
  job: Job,
  prices: Map<string, string> | null,
  budget: number,
) {
  if (job.phase === "expanding") {
    const chunk = await rows<{ shop_id: string }>(
      db,
      "SELECT shop_id FROM shops WHERE shop_id>? ORDER BY shop_id LIMIT 1000",
      job.phase_cursor,
    );
    if (chunk.length) {
      await db.batch([
        statement(
          db,
          "INSERT OR IGNORE INTO dirty_shops SELECT shop_id FROM shops WHERE shop_id>? AND shop_id<=?",
          job.phase_cursor,
          chunk.at(-1)!.shop_id,
        ),
        checkpoint(
          db,
          {
            phase_cursor: chunk.at(-1)!.shop_id,
            units_done: job.units_done + chunk.length,
          },
          job.lease!,
        ),
      ]);
    } else {
      const total = await db
        .prepare("SELECT COUNT(*) n FROM dirty_shops")
        .first<number>("n");
      await checkpoint(
        db,
        {
          phase: "deriving",
          phase_cursor: "",
          units_done: 0,
          units_total: total ?? 0,
          phase_started_at: iso(new Date()),
        },
        job.lease!,
      ).run();
    }
    return 8;
  }

  const next = await statement(
    db,
    "SELECT shop_id FROM dirty_shops WHERE shop_id>? ORDER BY shop_id LIMIT 1",
    job.phase_cursor,
  ).first<{ shop_id: string }>();
  if (next) {
    if (job.phase === "pricing")
      return learnPrices(db, next.shop_id, job, budget);
    return rebuildShop(
      db,
      app,
      next.shop_id,
      job,
      prices ?? (await priceBook(db, app)),
      budget,
    );
  }
  if (job.phase === "pricing") {
    const book = await priceBook(db, app);
    // A price-book change can affect other shops; enqueue them in bounded keyset pages.
    const changed = JSON.stringify([...book]) !== job.price_signature;
    const total = await db
      .prepare(
        changed
          ? "SELECT COUNT(*) n FROM shops"
          : "SELECT COUNT(*) n FROM dirty_shops",
      )
      .first<number>("n");
    await checkpoint(
      db,
      {
        phase: changed ? "expanding" : "deriving",
        phase_cursor: "",
        units_done: 0,
        units_total: total ?? 0,
        phase_started_at: iso(new Date()),
      },
      job.lease!,
    ).run();
  } else
    await checkpoint(
      db,
      {
        status: "complete",
        phase: "complete",
        last_success: job.until_at,
        error: null,
        failures: 0,
        retry_at: 0,
      },
      job.lease!,
    ).run();
  return 8;
}
export async function consume(env: Env, app: App) {
  const db = database(env, app);
  const token = crypto.randomUUID();
  const now = Date.now();
  const acquired = await statement(
    db,
    `UPDATE job SET lease=?,lease_until=? WHERE id=1 AND status='running' AND paused=0 AND retry_at<=? AND lease_until<?`,
    token,
    now + 120_000,
    now,
    now,
  ).run();
  if (!acquired.meta.changes) return;
  let retryDelay = 0;
  const deadline = Date.now() + 15_000;
  let prices: Map<string, string> | null = null;
  let budget = 930;
  try {
    for (let i = 0; i < 12 && budget > 30 && Date.now() < deadline; i++) {
      const job = await getJob(db);
      if (job.status !== "running" || job.paused || job.lease !== token) break;
      if (["transactions", "events"].includes(job.phase)) {
        if (budget < 310) break;
        budget -= await ingestPage(env, app, db, job);
        // Below Shopify's 4 requests/second limit for each separate Partner client.
        await new Promise((resolve) => setTimeout(resolve, 350));
      } else {
        if (job.phase === "deriving" && !prices)
          prices = await priceBook(db, app);
        const cost = await deriveStep(db, app, job, prices, budget - 10);
        if (!cost) break;
        budget -= cost;
      }
      budget -= 3;
      await statement(
        db,
        "UPDATE job SET lease_until=? WHERE id=1 AND lease=?",
        Date.now() + 120_000,
        token,
      ).run();
    }
  } catch (error) {
    const job = await getJob(db);
    const failures = job.failures + 1;
    const retryable =
      error instanceof PartnerError
        ? error.retryable
        : !String(error).includes("nécessaire") &&
          !String(error).includes("trop de");
    retryDelay = Math.min(300, Math.pow(2, failures) * 5);
    const failed = !retryable || failures >= 5;
    await checkpoint(
      db,
      {
        failures,
        error:
          error instanceof Error ? error.message : "Erreur de synchronisation.",
        status: failed ? "error" : "running",
        retry_at: failed ? 0 : Date.now() + retryDelay * 1000,
      },
      token,
    ).run();
  } finally {
    await statement(
      db,
      "UPDATE job SET lease=NULL,lease_until=0 WHERE id=1 AND lease=?",
      token,
    ).run();
  }
  const job = await getJob(db);
  if (job.status === "running" && !job.paused)
    await env.SYNC_QUEUE.send({ app: app.key }, { delaySeconds: retryDelay });
}
export async function schedule(env: Env) {
  for (const app of APPS) {
    if (!env[app.secret]) continue;
    const job = await getJob(database(env, app));
    if (job.paused || job.status === "error") continue;
    if (job.status === "running") await env.SYNC_QUEUE.send({ app: app.key });
    else if (
      !job.last_success ||
      Date.now() - Date.parse(job.last_success) > 15 * 60_000
    )
      await start(env, app);
  }
}
