-- Admin console (first version). Must be applied BEFORE deploying the code that
-- uses it: redemption checks redeem_codes.voided_at.
--
-- Balances stay authoritative in each account's Durable Object. The tables
-- below are a summary mirror the DO writes on every balance change and session
-- end (with an outbox + alarm retry), so the console can query across users.
-- "day" columns are the Asia/Shanghai (UTC+8) calendar date, YYYY-MM-DD.

-- Redeem codes: batch id and note already exist; add voiding.
ALTER TABLE redeem_codes ADD COLUMN voided_at INTEGER;   -- NULL = not voided
ALTER TABLE redeem_codes ADD COLUMN voided_by TEXT;      -- admin email
CREATE INDEX redeem_codes_hint ON redeem_codes(hint);
CREATE INDEX redeem_codes_redeemed ON redeem_codes(redeemed_at);

-- One row per account, overwritten with the DO's current totals.
CREATE TABLE user_summary (
  account_id TEXT PRIMARY KEY,                 -- same as users.id
  display_id TEXT NOT NULL,                    -- masked name the app shows
  created_at INTEGER NOT NULL,                 -- account creation (DO)
  balance_seconds INTEGER NOT NULL DEFAULT 0,
  recharged_seconds INTEGER NOT NULL DEFAULT 0, -- net of all recharge/redeem/adjust entries
  used_seconds INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,                        -- start of the latest finished session
  banned INTEGER NOT NULL DEFAULT 0,           -- reserved for ban/unban (not built yet)
  version INTEGER NOT NULL DEFAULT 0,          -- DO-side sequence; older writes never overwrite newer
  updated_at INTEGER NOT NULL
);
CREATE INDEX user_summary_balance ON user_summary(balance_seconds);
CREATE INDEX user_summary_used ON user_summary(used_seconds);

-- Every change to a balance: trial, redeem, admin adjustment (+/-), usage charge (-).
CREATE TABLE balance_ledger (
  id TEXT PRIMARY KEY,                         -- DO purchase id, or 'charge:<session id>'
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,                          -- 'trial' | 'redeem' | 'admin' | 'usage'
  seconds INTEGER NOT NULL,                    -- signed
  code_hash TEXT,                              -- redeem only
  code_hint TEXT,
  batch TEXT,
  note TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',             -- admin adjustments
  actor TEXT,                                  -- admin email for adjustments
  created_at INTEGER NOT NULL,
  day TEXT NOT NULL
);
CREATE INDEX balance_ledger_account ON balance_ledger(account_id, created_at);
CREATE INDEX balance_ledger_day ON balance_ledger(kind, day);

-- Finished sessions. A session belongs entirely to the Beijing date it STARTED
-- (created_at), both for the count and the duration.
CREATE TABLE session_records (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,                 -- start (user pressed start)
  first_frame_at INTEGER,                      -- NULL = no frame, never billed
  ended_at INTEGER,                            -- end request (what billing uses), else settle time
  billed_seconds INTEGER NOT NULL DEFAULT 0,
  had_frame INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL
);
CREATE INDEX session_records_day ON session_records(day);
CREATE INDEX session_records_account ON session_records(account_id, created_at);

-- Read-only audit log of admin operations (no endpoint updates or deletes it).
CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,                         -- admin email ('命令行' for npm run codes)
  action TEXT NOT NULL,                        -- 'batch_create' | 'code_void' | 'batch_void' | 'adjust' | 'backfill'
  target TEXT NOT NULL DEFAULT '',             -- batch id, code hint, account id
  detail TEXT NOT NULL DEFAULT '{}',           -- JSON
  reason TEXT NOT NULL DEFAULT '',
  ref TEXT                                     -- idempotency key for entries written through a DO outbox
);
CREATE INDEX admin_audit_at ON admin_audit(at);
CREATE UNIQUE INDEX admin_audit_ref ON admin_audit(ref);
