import { test } from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./db.js";
import { APPS, type Env } from "../src/config.js";
import { getJob, publicStatus } from "../src/store.js";
import { start, consume, windowCount } from "../src/sync.js";
import { login, authorized } from "../src/auth.js";
const app = APPS[0];
function environment() {
  const a = testDb(),
    b = testDb();
  const messages: any[] = [];
  return {
    env: {
      BIG_DOWNLOAD_DB: a.db,
      COWLENDAR_DB: b.db,
      PARTNER_TOKEN_BIG_DOWNLOAD: "test-token",
      PARTNER_TOKEN_COWLENDAR: "test-token",
      PARTNER_API_VERSION: "2026-07",
      DASHBOARD_PASSWORD: "a-long-local-password",
      SESSION_SECRET: "a-secret-with-at-least-32-characters",
      SYNC_QUEUE: {
        send: async (x: any) => {
          messages.push(x);
        },
      },
    } as unknown as Env,
    a,
    b,
    messages,
  };
}
test("calendar work is finite and includes the app launch month", () => {
  assert.equal(
    windowCount("2022-11-17T00:00:00.000Z", "2023-01-03T00:00:00.000Z"),
    6,
  );
});
test("full pipeline, replay safety, pause, lock, and failure recovery", async () => {
  const { env, a } = environment();
  await start(env, app);
  // A small historical window exercises the same bounded job as multi-year imports.
  await a.db
    .prepare(
      "UPDATE job SET since='2026-01-01T00:00:00.000Z',window_start='2026-01-01T00:00:00.000Z',window_end='2026-01-31T00:00:00.000Z',until_at='2026-01-31T00:00:00.000Z',windows_total=2",
    )
    .run();
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    const tx = body.query.includes("PartnerdexTransactions");
    const v = body.variables;
    assert.ok(String(_url).includes("/655806/"));
    assert.equal(v.appId, "gid://partners/App/6922231");
    if (tx) {
      return Response.json({
        data: {
          transactions: {
            pageInfo: { hasNextPage: !v.after },
            edges: [
              {
                cursor: v.after ? "page-2" : "page-1",
                node: {
                  id: v.after ? "t2" : "t1",
                  createdAt: "2026-01-01T00:00:00Z",
                  __typename: "AppSubscriptionSale",
                  app: {
                    id: "gid://partners/App/6922231",
                    name: "Big Download",
                  },
                  shop: { id: "gid://partners/Shop/1" },
                  chargeId: "1",
                  billingInterval: "EVERY_30_DAYS",
                  grossAmount: { amount: "10", currencyCode: "USD" },
                  netAmount: { amount: "8", currencyCode: "USD" },
                },
              },
            ],
          },
        },
      });
    }
    return Response.json({
      data: {
        app: {
          events: {
            pageInfo: { hasNextPage: false },
            edges: [
              {
                cursor: "e1",
                node: {
                  type: "RELATIONSHIP_INSTALLED",
                  occurredAt: "2026-01-01T00:00:00Z",
                  shop: { id: "gid://partners/Shop/1" },
                },
              },
              {
                cursor: "e2",
                node: {
                  type: "SUBSCRIPTION_CHARGE_ACTIVATED",
                  occurredAt: "2026-01-01T00:00:00Z",
                  shop: { id: "gid://partners/Shop/1" },
                  charge: {
                    id: "gid://partners/Charge/1",
                    name: "Basic",
                    test: false,
                    billingOn: "2026-02-01",
                    amount: { amount: "10", currencyCode: "USD" },
                  },
                },
              },
            ],
          },
        },
      },
    });
  };
  try {
    await a.db.prepare("UPDATE job SET paused=1").run();
    await consume(env, app);
    assert.equal(calls, 0);
    await a.db
      .prepare("UPDATE job SET paused=0,lease_until=?")
      .bind(Date.now() + 60_000)
      .run();
    await consume(env, app);
    assert.equal(calls, 0);
    await a.db.prepare("UPDATE job SET lease_until=0").run();
    await consume(env, app);
    assert.equal((await getJob(a.db)).status, "complete");
    assert.equal((await getJob(a.db)).pages, 3);
    assert.equal(
      await a.db.prepare("SELECT SUM(gross) n FROM daily").first("n"),
      20,
    );
    assert.equal(
      await a.db.prepare("SELECT SUM(mrr_delta) n FROM daily").first("n"),
      10,
    );
    assert.equal(
      await a.db.prepare("SELECT SUM(installs) n FROM daily").first("n"),
      1,
    );
    // Replay the same page after a new run: raw primary keys and delta replacement prevent inflation.
    await a.db
      .prepare(
        "UPDATE job SET status='running',phase='transactions',cursor=NULL,windows_done=0,phase_cursor='',units_done=0",
      )
      .run();
    await consume(env, app);
    assert.equal(
      await a.db.prepare("SELECT SUM(gross) n FROM daily").first("n"),
      20,
    );
    assert.equal(
      await a.db.prepare("SELECT SUM(mrr_delta) n FROM daily").first("n"),
      10,
    );
    await a.db
      .prepare(
        "UPDATE job SET status='running',phase='transactions',cursor='known-checkpoint'",
      )
      .run();
    globalThis.fetch = async () => new Response("Forbidden", { status: 403 });
    await consume(env, app);
    const failed = await getJob(a.db);
    assert.equal(failed.status, "error");
    assert.equal(failed.cursor, "known-checkpoint");
    const status = await publicStatus(env, app);
    assert.equal(status.eta, null);
    assert.ok(!("lease" in status));
  } finally {
    globalThis.fetch = previous;
  }
});
test("auth requires configuration, validates signed cookie and password rotation", async () => {
  const { env } = environment();
  const response = await login(
    new Request("https://test/api/login", {
      method: "POST",
      body: JSON.stringify({ password: env.DASHBOARD_PASSWORD }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.equal(
    await authorized(
      new Request("https://test/api/status", { headers: { cookie } }),
      env,
    ),
    true,
  );
  assert.equal(
    await authorized(
      new Request("https://test/api/status", {
        headers: { cookie: cookie.replace("pd_session=", "pd_session=0") },
      }),
      env,
    ),
    false,
  );
  assert.equal(
    await authorized(
      new Request("https://test/api/status", { headers: { cookie } }),
      { ...env, DASHBOARD_PASSWORD: "changed-password" },
    ),
    false,
  );
});
