import type { Env } from "./config.js";
import { ensureSchema } from "./bootstrap.js";
const bytes = new TextEncoder();
function encoded(buffer: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function hash(value: string) {
  return encoded(await crypto.subtle.digest("SHA-256", bytes.encode(value)));
}
async function sign(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    bytes.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encoded(await crypto.subtle.sign("HMAC", key, bytes.encode(value)));
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
export function configured(env: Env) {
  return Boolean(
    env.DASHBOARD_PASSWORD?.length >= 12 &&
    (!env.SESSION_SECRET || env.SESSION_SECRET.length >= 32),
  );
}
async function sessionKey(env: Env): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const db = env.BIG_DOWNLOAD_DB;
  await ensureSchema(db);
  const existing = await db
    .prepare("SELECT value FROM auth_settings WHERE key='session_key'")
    .first<string>("value");
  if (existing) return existing;
  const value = encoded(crypto.getRandomValues(new Uint8Array(32)).buffer);
  await db
    .prepare(
      "INSERT OR IGNORE INTO auth_settings(key,value) VALUES('session_key',?)",
    )
    .bind(value)
    .run();
  return (await db
    .prepare("SELECT value FROM auth_settings WHERE key='session_key'")
    .first<string>("value"))!;
}
export async function authorized(request: Request, env: Env) {
  if (!configured(env)) return false;
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("pd_session="))
    ?.slice(11);
  if (!cookie) return false;
  const [expiry, signature] = cookie.split(".");
  if (
    !expiry ||
    !signature ||
    !Number.isFinite(Number(expiry)) ||
    Number(expiry) < Date.now() ||
    Number(expiry) > Date.now() + 8 * DAY
  )
    return false;
  return same(
    signature,
    await sign(
      `${expiry}:${await hash(env.DASHBOARD_PASSWORD)}`,
      await sessionKey(env),
    ),
  );
}
const DAY = 86_400_000;
export async function login(request: Request, env: Env) {
  if (!configured(env))
    return Response.json(
      {
        error:
          "Ajoute DASHBOARD_PASSWORD dans les secrets Cloudflare (12 caractères minimum). Si tu as ajouté un SESSION_SECRET facultatif, il doit faire au moins 32 caractères.",
      },
      { status: 503 },
    );
  if (Number(request.headers.get("content-length") ?? 0) > 4096)
    return new Response("Too large", { status: 413 });
  const raw = await request.text();
  if (raw.length > 4096) return new Response("Too large", { status: 413 });
  let password: string;
  try {
    password = JSON.parse(raw).password;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const db = env.BIG_DOWNLOAD_DB;
  await ensureSchema(db);
  const key = await hash(request.headers.get("cf-connecting-ip") ?? "local");
  await db
    .prepare("DELETE FROM auth_limits WHERE expires<?")
    .bind(Date.now())
    .run();
  const tries = await db
    .prepare(
      "INSERT INTO auth_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts",
    )
    .bind(key, Date.now() + 15 * 60_000)
    .first<number>("attempts");
  if ((tries ?? 0) > 10)
    return Response.json(
      { error: "Trop de tentatives. Réessaie dans 15 minutes." },
      { status: 429 },
    );
  if (
    typeof password !== "string" ||
    !same(await hash(password), await hash(env.DASHBOARD_PASSWORD))
  )
    return Response.json({ error: "Mot de passe incorrect." }, { status: 401 });
  await db.prepare("DELETE FROM auth_limits WHERE key=?").bind(key).run();
  const expiry = Date.now() + 7 * DAY;
  const value = `${expiry}.${await sign(`${expiry}:${await hash(env.DASHBOARD_PASSWORD)}`, await sessionKey(env))}`;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return Response.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": `pd_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`,
      },
    },
  );
}
