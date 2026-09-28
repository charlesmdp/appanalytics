import { type App, type Env, database } from "./config.js";
export interface Job {
  id: number;
  status: string;
  phase: string;
  run_id: string;
  since: string;
  until_at: string;
  window_start: string;
  window_end: string;
  cursor: string | null;
  windows_done: number;
  windows_total: number;
  pages: number;
  records: number;
  units_done: number;
  units_total: number;
  phase_cursor: string;
  started_at: string | null;
  updated_at: string | null;
  phase_started_at: string | null;
  last_success: string | null;
  lease: string | null;
  lease_until: number;
  paused: number;
  failures: number;
  retry_at: number;
  error: string | null;
  window_started_at: string | null;
  samples: string;
  price_signature: string;
  version: number;
}
export async function getJob(db: D1Database) {
  return (await db.prepare("SELECT * FROM job WHERE id=1").first<Job>())!;
}
export function statement(db: D1Database, sql: string, ...values: unknown[]) {
  return db.prepare(sql).bind(...values);
}
export async function rows<T>(
  db: D1Database,
  sql: string,
  ...values: unknown[]
): Promise<T[]> {
  return (await statement(db, sql, ...values).all<T>()).results;
}
export function checkpoint(
  db: D1Database,
  patch: Partial<Job>,
  lease?: string,
) {
  const entries = Object.entries(patch);
  return statement(
    db,
    `UPDATE job SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=?,version=version+1 WHERE id=1${lease ? " AND lease=?" : ""}`,
    ...entries.map(([, value]) => value),
    new Date().toISOString(),
    ...(lease ? [lease] : []),
  );
}
export async function publicStatus(env: Env, app: App) {
  const job = await getJob(database(env, app));
  const samples = JSON.parse(job.samples) as number[];
  const importing = ["transactions", "events"].includes(job.phase);
  const elapsed = job.phase_started_at
    ? (Date.now() - Date.parse(job.phase_started_at)) / 1000
    : 0;
  const remaining = importing
    ? job.windows_total - job.windows_done
    : job.units_total - job.units_done;
  let eta: { low: number; high: number; scope: string } | null = null;
  if (importing && samples.length >= 3 && remaining > 0) {
    const avg = samples.reduce((s, x) => s + x, 0) / samples.length;
    eta = {
      low: Math.round(remaining * avg * 0.5),
      high: Math.round(remaining * avg * 2.5),
      scope: "Import uniquement, calculs ensuite",
    };
  } else if (!importing && job.units_done >= 5 && remaining > 0) {
    const rate = elapsed / job.units_done;
    eta = {
      low: Math.round(remaining * rate * 0.7),
      high: Math.round(remaining * rate * 1.6),
      scope: "Étape en cours",
    };
  }
  if (job.paused || job.status !== "running" || job.retry_at > Date.now())
    eta = null;
  const {
    lease,
    lease_until,
    price_signature,
    samples: hiddenSamples,
    ...visible
  } = job;
  return {
    app: app.key,
    name: app.name,
    configured: Boolean(env[app.secret]),
    ...visible,
    eta,
    calendarPercent:
      importing && job.windows_total
        ? Math.floor((job.windows_done / job.windows_total) * 100)
        : null,
    phasePercent:
      !importing && job.units_total
        ? Math.floor((job.units_done / job.units_total) * 100)
        : null,
    recordsPerSecond:
      job.started_at && job.records
        ? job.records /
          Math.max(1, (Date.now() - Date.parse(job.started_at)) / 1000)
        : null,
    stale:
      job.status === "running" &&
      !job.paused &&
      Boolean(job.updated_at) &&
      Date.now() - Date.parse(job.updated_at!) > 180_000,
  };
}
