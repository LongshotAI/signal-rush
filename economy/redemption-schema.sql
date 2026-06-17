-- economy/redemption-schema.sql
-- Signal Rush — Token Redemption Schema (Phase 2)
--
-- Extends the economy database with tables for redeeming credits
-- as API tokens from external providers (OpenRouter, Nous, etc.)
--
-- Design decisions:
-- - Redemptions are atomic: credits deducted + token record created in one tx
-- - Each redemption has a unique idempotency key (provider + external_id)
-- - Provider responses stored for audit/debugging
-- - Token balances tracked per-provider (a player can have tokens from multiple providers)
-- - All amounts in smallest unit (micros for credits, tokens for provider units)

-- Token redemption requests
CREATE TABLE IF NOT EXISTS redemptions (
  id              TEXT PRIMARY KEY,           -- UUID
  player_id       TEXT NOT NULL REFERENCES players(id),
  provider        TEXT NOT NULL,              -- 'openrouter', 'nous', 'custom'
  amount_micros   INTEGER NOT NULL CHECK(amount_micros > 0),  -- credits spent
  token_amount    INTEGER NOT NULL CHECK(token_amount > 0),   -- tokens received
  status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed', 'refunded')),
  idempotency_key TEXT UNIQUE NOT NULL,       -- prevents duplicate redemptions
  provider_ref    TEXT,                       -- external reference from provider
  provider_response TEXT,                     -- JSON response from provider (for audit)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_redemptions_player ON redemptions(player_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_status ON redemptions(status);
CREATE INDEX IF NOT EXISTS idx_redemptions_idempotency ON redemptions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_redemptions_created ON redemptions(created_at DESC);

-- Per-provider token balances (denormalized for fast reads)
CREATE TABLE IF NOT EXISTS token_balances (
  player_id       TEXT NOT NULL REFERENCES players(id),
  provider        TEXT NOT NULL,
  balance         INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
  total_redeemed  INTEGER NOT NULL DEFAULT 0,
  total_spent     INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_token_balances_player ON token_balances(player_id);

-- Provider configuration (API keys stored in environment, not here)
-- This table stores non-secret provider config only
CREATE TABLE IF NOT EXISTS providers (
  id              TEXT PRIMARY KEY,           -- 'openrouter', 'nous', etc.
  display_name    TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  credit_rate     INTEGER NOT NULL DEFAULT 1000,  -- credits per 1000 tokens
  min_redemption  INTEGER NOT NULL DEFAULT 100,   -- minimum credits to redeem
  max_redemption  INTEGER NOT NULL DEFAULT 100000, -- maximum credits per redemption
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Redemption audit log (append-only)
CREATE TABLE IF NOT EXISTS redemption_audit (
  id              TEXT PRIMARY KEY,
  redemption_id   TEXT NOT NULL REFERENCES redemptions(id),
  player_id       TEXT NOT NULL,
  action          TEXT NOT NULL CHECK(action IN ('created', 'completed', 'failed', 'refunded')),
  detail          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_redemption_audit_redemption ON redemption_audit(redemption_id);
CREATE INDEX IF NOT EXISTS idx_redemption_audit_player ON redemption_audit(player_id);
