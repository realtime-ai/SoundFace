-- Global indexes. Per-account balances, purchases and sessions live in the
-- account's Durable Object (serialised per account).
CREATE TABLE users (
  id TEXT PRIMARY KEY,            -- 'email:a@b.com' | 'phone:138...' | 'dev:name'
  name TEXT NOT NULL,             -- masked display name
  created_at INTEGER NOT NULL
);
CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY,    -- SHA-256 of the bearer token; the token itself is never stored
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX tokens_user ON tokens(user_id);
CREATE TABLE login_codes (
  method TEXT NOT NULL,
  identifier TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (method, identifier)
);
CREATE TABLE redeem_codes (
  code_hash TEXT PRIMARY KEY,     -- SHA-256 of the normalised code; codes are shown once at creation
  hint TEXT NOT NULL,             -- last 4 characters, to identify a code in listings
  credits INTEGER NOT NULL CHECK (credits > 0),
  batch TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER,             -- NULL = never
  redeemed_by TEXT,
  redeemed_at INTEGER
);
CREATE INDEX redeem_codes_batch ON redeem_codes(batch);
