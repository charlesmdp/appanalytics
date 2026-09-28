export const APPS = [
  {
    key: "big-download",
    name: "Big Download",
    organizationId: "655806",
    appId: "6922231",
    since: "2022-11-17",
    binding: "BIG_DOWNLOAD_DB",
    secret: "PARTNER_TOKEN_BIG_DOWNLOAD",
    color: "#6258e8",
  },
  {
    key: "cowlendar",
    name: "Cowlendar",
    organizationId: "4386727",
    appId: "5822535",
    since: "2022-01-21",
    binding: "COWLENDAR_DB",
    secret: "PARTNER_TOKEN_COWLENDAR",
    color: "#17a58b",
  },
] as const;
export type App = (typeof APPS)[number];
export type AppKey = App["key"];
export interface Env {
  BIG_DOWNLOAD_DB: D1Database;
  COWLENDAR_DB: D1Database;
  SYNC_QUEUE: Queue<{ app: AppKey }>;
  ASSETS: Fetcher;
  AI?: Ai;
  AI_ENABLED?: string;
  DEMO_MODE?: string;
  PARTNER_TOKEN_BIG_DOWNLOAD?: string;
  PARTNER_TOKEN_COWLENDAR?: string;
  DASHBOARD_PASSWORD: string;
  SESSION_SECRET?: string;
  PARTNER_API_VERSION: string;
}
export function appFor(key: string): App {
  const app = APPS.find((a) => a.key === key);
  if (!app) throw new Error("Application inconnue.");
  return app;
}
export function database(env: Env, app: App) {
  return env[app.binding];
}
export const DAY = 86_400_000;
export const iso = (value: string | Date) => new Date(value).toISOString();
export const day = (value: string | Date) => iso(value).slice(0, 10);
