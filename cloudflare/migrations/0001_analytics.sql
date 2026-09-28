-- Each app has its own D1 database; identifiers cannot collide across partners.
CREATE TABLE job (
 id INTEGER PRIMARY KEY CHECK(id=1), status TEXT NOT NULL DEFAULT 'idle', phase TEXT NOT NULL DEFAULT 'transactions',
 run_id TEXT NOT NULL DEFAULT '', since TEXT NOT NULL DEFAULT '', until_at TEXT NOT NULL DEFAULT '', window_start TEXT NOT NULL DEFAULT '', window_end TEXT NOT NULL DEFAULT '',
 cursor TEXT, windows_done INTEGER NOT NULL DEFAULT 0, windows_total INTEGER NOT NULL DEFAULT 0,
 pages INTEGER NOT NULL DEFAULT 0, records INTEGER NOT NULL DEFAULT 0, units_done INTEGER NOT NULL DEFAULT 0, units_total INTEGER NOT NULL DEFAULT 0,
 phase_cursor TEXT NOT NULL DEFAULT '', started_at TEXT, updated_at TEXT, phase_started_at TEXT, last_success TEXT,
 lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
 failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, error TEXT,
 window_started_at TEXT, samples TEXT NOT NULL DEFAULT '[]', price_signature TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO job(id) VALUES(1);
CREATE TABLE transactions (
 id TEXT PRIMARY KEY, type TEXT NOT NULL, app_id TEXT NOT NULL, shop_id TEXT NOT NULL, charge_ref TEXT NOT NULL,
 created_at TEXT NOT NULL, billing_interval TEXT, gross_amount REAL NOT NULL, net_amount REAL NOT NULL,
 currency TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX tx_shop ON transactions(shop_id,charge_ref,type,created_at);
CREATE INDEX tx_charge ON transactions(charge_ref,type,billing_interval);
CREATE INDEX tx_time ON transactions(created_at);
CREATE TABLE app_events (
 event_key TEXT PRIMARY KEY, app_id TEXT NOT NULL, shop_id TEXT NOT NULL, type TEXT NOT NULL, occurred_at TEXT NOT NULL,
 charge_id TEXT NOT NULL, charge_name TEXT, charge_amount REAL, charge_currency TEXT, charge_test INTEGER NOT NULL, billing_on TEXT
) WITHOUT ROWID;
CREATE INDEX events_shop ON app_events(shop_id,charge_id,occurred_at);
CREATE INDEX events_time ON app_events(occurred_at);
CREATE TABLE shops(shop_id TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE dirty_shops(shop_id TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE due_shops(shop_id TEXT PRIMARY KEY, due_at TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX due_time ON due_shops(due_at);
CREATE TABLE price_hints(charge_id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, plan_name TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL, interval TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX price_shop ON price_hints(shop_id);
CREATE INDEX price_group ON price_hints(plan_name,amount,currency,interval);
CREATE TABLE shop_deltas(shop_id TEXT NOT NULL, date TEXT NOT NULL, currency TEXT NOT NULL, mrr_delta REAL NOT NULL, paying_delta INTEGER NOT NULL,
 PRIMARY KEY(shop_id,date,currency)) WITHOUT ROWID;
CREATE TABLE daily(date TEXT NOT NULL, currency TEXT NOT NULL, mrr_delta REAL NOT NULL DEFAULT 0, paying_delta INTEGER NOT NULL DEFAULT 0,
 installs INTEGER NOT NULL DEFAULT 0, uninstalls INTEGER NOT NULL DEFAULT 0, reactivations INTEGER NOT NULL DEFAULT 0, deactivations INTEGER NOT NULL DEFAULT 0,
 gross REAL NOT NULL DEFAULT 0, net REAL NOT NULL DEFAULT 0, PRIMARY KEY(date,currency)) WITHOUT ROWID;
CREATE TRIGGER tx_insert AFTER INSERT ON transactions BEGIN
 INSERT INTO daily(date,currency,gross,net) VALUES(substr(NEW.created_at,1,10),NEW.currency,NEW.gross_amount,NEW.net_amount)
 ON CONFLICT(date,currency) DO UPDATE SET gross=gross+excluded.gross,net=net+excluded.net;
END;
CREATE TRIGGER tx_update AFTER UPDATE ON transactions BEGIN
 UPDATE daily SET gross=gross-OLD.gross_amount,net=net-OLD.net_amount WHERE date=substr(OLD.created_at,1,10) AND currency=OLD.currency;
 INSERT INTO daily(date,currency,gross,net) VALUES(substr(NEW.created_at,1,10),NEW.currency,NEW.gross_amount,NEW.net_amount)
 ON CONFLICT(date,currency) DO UPDATE SET gross=gross+excluded.gross,net=net+excluded.net;
END;
CREATE TRIGGER event_insert AFTER INSERT ON app_events WHEN NEW.charge_test=0 BEGIN
 INSERT INTO daily(date,currency,installs,uninstalls,reactivations,deactivations)
 VALUES(substr(NEW.occurred_at,1,10),'',NEW.type='RELATIONSHIP_INSTALLED',NEW.type='RELATIONSHIP_UNINSTALLED',NEW.type='RELATIONSHIP_REACTIVATED',NEW.type='RELATIONSHIP_DEACTIVATED')
 ON CONFLICT(date,currency) DO UPDATE SET installs=installs+excluded.installs,uninstalls=uninstalls+excluded.uninstalls,reactivations=reactivations+excluded.reactivations,deactivations=deactivations+excluded.deactivations;
END;
CREATE TRIGGER delta_insert AFTER INSERT ON shop_deltas BEGIN
 INSERT INTO daily(date,currency,mrr_delta,paying_delta) VALUES(NEW.date,NEW.currency,NEW.mrr_delta,NEW.paying_delta)
 ON CONFLICT(date,currency) DO UPDATE SET mrr_delta=mrr_delta+excluded.mrr_delta,paying_delta=paying_delta+excluded.paying_delta;
END;
CREATE TRIGGER delta_delete AFTER DELETE ON shop_deltas BEGIN
 UPDATE daily SET mrr_delta=mrr_delta-OLD.mrr_delta,paying_delta=paying_delta-OLD.paying_delta WHERE date=OLD.date AND currency=OLD.currency;
END;
CREATE TABLE auth_limits(key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE ai_cache(key TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
