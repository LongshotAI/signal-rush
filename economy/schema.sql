-- ─── Signal Rush Economy Service — Database Schema ────────────────────────────
-- SQLite with WAL mode for concurrent read safety
-- All monetary values stored in integer micros/credits (never floats)
-- Every row has created_at for audit trail
-- CHECK constraints prevent negative balances at DB level (defense in depth)

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Migration tracking table — records which schema versions have been applied.
-- New migrations should add a new row here after applying the DDL.
-- This replaces the previous "edit schema.sql and hope existing DBs re-run" pattern.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,        -- e.g. '001', '002-rename-telegram-id'
    description TEXT NOT NULL,       -- human-readable summary
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Player accounts
-- balance is the source of truth; total_earned/total_spent are cached aggregates
-- balance CHECK constraint prevents negative balances even if application logic fails
CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    telegram_id TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now')),
    total_earned INTEGER DEFAULT 0 CHECK(total_earned >= 0),
    total_spent INTEGER DEFAULT 0 CHECK(total_spent >= 0),
    balance INTEGER DEFAULT 0 CHECK(balance >= 0)
);

-- Transaction ledger — append-only, never update or delete
-- event_id is the idempotency key from the event bridge
-- source_event_types stores the JSON array of engine event types that triggered this
-- This table IS the audit trail. Every credit mutation is recorded here.
CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    type TEXT NOT NULL CHECK(type IN ('award', 'spend')),
    amount INTEGER NOT NULL CHECK(amount > 0),
    reason TEXT NOT NULL,
    event_id TEXT UNIQUE,
    source_event_types TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Raw game events from the engine — stored for analytics and fraud analysis
-- credits_delta is the authoritative credit change for this step (from bridge diffing)
-- metadata is a JSON blob with event-specific fields
-- This table enables replay analysis: given a session_id, reconstruct exactly what happened
CREATE TABLE IF NOT EXISTS game_events (
    id TEXT PRIMARY KEY,
    player_id TEXT REFERENCES players(id),
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    credits_delta INTEGER DEFAULT 0,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Ad impressions — each row is one impression served
-- campaign_id is NULL for "house" impressions (no advertiser, no charge)
-- cost_micros is the amount deducted from the campaign budget for this impression
-- Enables: impression counting, spend pacing, CTR calculation, fraud detection
CREATE TABLE IF NOT EXISTS ad_impressions (
    id TEXT PRIMARY KEY,
    campaign_id TEXT,
    player_id TEXT REFERENCES players(id),
    placement_type TEXT DEFAULT 'hud_frame' CHECK(placement_type IN ('hud_frame', 'interstitial', 'menu_banner', 'game_over')),
    cost_micros INTEGER DEFAULT 0 CHECK(cost_micros >= 0),
    created_at TEXT DEFAULT (datetime('now'))
);

-- Session tracking — one row per game session
-- Enables: session-level analysis, detecting abnormal play patterns
-- ended_at is NULL until the session actually ends
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    mode TEXT CHECK(mode IN ('aiHunt', 'frogger')),
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT,
    credits_earned INTEGER DEFAULT 0,
    credits_spent INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    tick_count INTEGER DEFAULT 0
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_transactions_player ON transactions(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_event ON transactions(event_id);
CREATE INDEX IF NOT EXISTS idx_game_events_session ON game_events(session_id);
CREATE INDEX IF NOT EXISTS idx_game_events_player ON game_events(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_game_events_type ON game_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_ad_impressions_campaign ON ad_impressions(campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id, started_at);
CREATE INDEX IF NOT EXISTS idx_players_telegram_id ON players(telegram_id);

-- ─── Advertiser Portal Tables ─────────────────────────────────────

-- Advertiser accounts — each row is one advertising partner
-- password_hash: PBKDF2-HMAC-SHA512, stored as "salt:iterations:hash" hex string
-- api_key: random hex token, unique, used for Bearer auth to portal endpoints
-- status: 'active' | 'suspended' — suspended accounts cannot create campaigns or spend
-- balance_micros: advertiser's deposited funds (1 credit = 1,000,000 micros)
CREATE TABLE IF NOT EXISTS advertiser_accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    company_name TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    api_key_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended')),
    balance_micros INTEGER DEFAULT 0 CHECK(balance_micros >= 0),
    created_at TEXT DEFAULT (datetime('now'))
);

-- Campaigns — each row is one advertising campaign
-- status state machine: draft → pending_review → active | rejected
--   active can be paused → reactivated; active/paused → completed when budget exhausted
-- daily_budget_micros: max spend per calendar day (0 = unlimited)
-- total_budget_micros: max spend over campaign lifetime (0 = unlimited)
-- spent_micros: running total deducted (never goes negative)
-- start_date / end_date: ISO date strings (YYYY-MM-DD); NULL = no date bound
-- advertiser_id CASCADE delete: removing account removes all their campaigns
CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    brand_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'pending_review', 'active', 'paused', 'completed', 'rejected')),
    placement_type TEXT NOT NULL DEFAULT 'hud_frame' CHECK(placement_type IN ('hud_frame', 'interstitial', 'menu_banner', 'game_over')),
    daily_budget_micros INTEGER DEFAULT 0 CHECK(daily_budget_micros >= 0),
    total_budget_micros INTEGER DEFAULT 0 CHECK(total_budget_micros >= 0),
    spent_micros INTEGER DEFAULT 0 CHECK(spent_micros >= 0),
    daily_spent_micros INTEGER DEFAULT 0 CHECK(daily_spent_micros >= 0),
    daily_spent_date TEXT,
    start_date TEXT,
    end_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Creatives — ad content assets for a campaign
-- type: 'logo' | 'label' | 'interstitial' — determines where/how it renders
-- content_json: JSON blob with the actual creative content (logo lines, label text, etc.)
-- status: 'pending' | 'approved' | 'rejected' — must be approved before campaign goes active
-- reviewed_at: when an admin approved/rejected (NULL while pending)
CREATE TABLE IF NOT EXISTS creatives (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('logo', 'label', 'interstitial')),
    content_json NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    reviewed_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Campaign placements — which game placements a campaign targets
-- Many-to-one: a campaign can target multiple placement types
-- Enforced at DB level to prevent invalid placement targeting
CREATE TABLE IF NOT EXISTS campaign_placements (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    placement_type TEXT NOT NULL CHECK(placement_type IN ('hud_frame', 'interstitial', 'menu_banner', 'game_over')),
    PRIMARY KEY (campaign_id, placement_type)
);

-- Advertiser portal indexes
CREATE INDEX IF NOT EXISTS idx_advertiser_accounts_api_key ON advertiser_accounts(api_key);
CREATE INDEX IF NOT EXISTS idx_advertiser_accounts_email ON advertiser_accounts(email);
CREATE INDEX IF NOT EXISTS idx_campaigns_advertiser ON campaigns(advertiser_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_creatives_campaign ON creatives(campaign_id);
CREATE INDEX IF NOT EXISTS idx_creatives_status ON creatives(status);

-- ─── Token Redemption Tables (Phase 2) ─────────────────────────────
-- Players redeem earned credits for AI API calls via external providers.
-- All redemption operations are atomic: credits deducted + redemption record
-- created in a single transaction. Idempotency keys prevent double-spend.

-- Token redemption requests
CREATE TABLE IF NOT EXISTS redemptions (
  id              TEXT PRIMARY KEY,
  player_id       TEXT NOT NULL REFERENCES players(id),
  provider        TEXT NOT NULL,
  amount_micros   INTEGER NOT NULL CHECK(amount_micros > 0),
  model           TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  prompt          TEXT NOT NULL,
  response        TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed', 'refunded')),
  idempotency_key TEXT UNIQUE NOT NULL,
  provider_ref    TEXT,
  provider_response TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_redemptions_player ON redemptions(player_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_status ON redemptions(status);
CREATE INDEX IF NOT EXISTS idx_redemptions_idempotency ON redemptions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_redemptions_created ON redemptions(created_at DESC);

-- Per-provider token spend tracking (denormalized for fast reads)
CREATE TABLE IF NOT EXISTS token_balances (
  player_id       TEXT NOT NULL REFERENCES players(id),
  provider        TEXT NOT NULL,
  total_redeemed  INTEGER NOT NULL DEFAULT 0,
  total_spent     INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_token_balances_player ON token_balances(player_id);

-- Provider configuration (non-secret only; API keys in env vars)
CREATE TABLE IF NOT EXISTS providers (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  credit_rate     INTEGER NOT NULL DEFAULT 1000,
  min_redemption  INTEGER NOT NULL DEFAULT 100,
  max_redemption  INTEGER NOT NULL DEFAULT 100000,
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

-- ─── Credit Sinks ───────────────────────────────────────────────────
-- Tracks every in-game credit spend for analytics and anti-inflation tracking.
-- Each row represents one credit sink event (entry fee, purchase, boost, etc.)
CREATE TABLE IF NOT EXISTS credit_sinks (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  sink_type TEXT NOT NULL CHECK(sink_type IN ('daily_challenge_entry', 'cosmetic_purchase', 'score_boost', 'extra_life')),
  amount INTEGER NOT NULL CHECK(amount > 0),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_credit_sinks_player ON credit_sinks(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_sinks_type ON credit_sinks(sink_type, created_at);

-- ─── Player Reward Pool (20% of ad revenue) ──────────────────────────
-- Singleton row: total advertising revenue → player rewards accumulation
-- total_deposited_micros: 20% of every successful chargeCampaign
-- total_claimed_micros: what players have actually claimed (paid out)
CREATE TABLE IF NOT EXISTS rewards_pool (
    id          INTEGER PRIMARY KEY CHECK(id = 1),  -- singleton row
    total_deposited_micros INTEGER NOT NULL DEFAULT 0 CHECK(total_deposited_micros >= 0),
    total_claimed_micros   INTEGER NOT NULL DEFAULT 0 CHECK(total_claimed_micros >= 0),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed the singleton row
INSERT OR IGNORE INTO rewards_pool (id, total_deposited_micros, total_claimed_micros)
VALUES (1, 0, 0);

-- Player reward earnings — each row is one player's accumulated reward share
-- earned_micros: what the player has earned from skill-based gameplay
-- claimed_micros: what the player has successfully claimed (paid out via ppq.ai)
-- last_earned_at: when they last earned (for anti-fraud)
CREATE TABLE IF NOT EXISTS player_rewards (
    player_id       TEXT NOT NULL REFERENCES players(id),
    earned_micros   INTEGER NOT NULL DEFAULT 0 CHECK(earned_micros >= 0),
    claimed_micros  INTEGER NOT NULL DEFAULT 0 CHECK(claimed_micros >= 0),
    last_earned_at  TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (player_id)
);

-- Claim audit trail — every reward claim that was paid out
CREATE TABLE IF NOT EXISTS reward_claims (
    id              TEXT PRIMARY KEY,
    player_id       TEXT NOT NULL REFERENCES players(id),
    amount_micros   INTEGER NOT NULL CHECK(amount_micros > 0),
    ppq_account     TEXT NOT NULL,  -- player's ppq.ai account email/username
    status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed')),
    ppq_tx_id       TEXT,           -- ppq.ai transaction reference
    claimed_at      TEXT DEFAULT (datetime('now')),
    completed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_reward_claims_player ON reward_claims(player_id);
CREATE INDEX IF NOT EXISTS idx_reward_claims_status ON reward_claims(status);
CREATE INDEX IF NOT EXISTS idx_player_rewards_earned ON player_rewards(earned_micros DESC);

-- ─── Persisted Rate Limit Cooldowns ────────────────────────────────
-- Survives server restarts so players can't bypass limits by restarting.
-- key format: "impression:<player_id>" | "claim:<player_id>"
-- last_timestamp: Unix epoch ms of the most recent action
CREATE TABLE IF NOT EXISTS rate_limit_cooldowns (
    key TEXT PRIMARY KEY,
    last_timestamp INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Persisted Admin Daily Awards ─────────────────────────────────
-- Tracks total admin-awarded credits per day, survives restarts.
-- date: YYYY-MM-DD
CREATE TABLE IF NOT EXISTS admin_daily_awards (
    date TEXT PRIMARY KEY,
    total_micros INTEGER NOT NULL DEFAULT 0 CHECK(total_micros >= 0),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ─── Per-Player Daily Award Caps ──────────────────────────────────
-- Tracks how many micros each player has received via /credits/award per day.
-- Prevents a single player from consuming the entire daily budget.
-- date: YYYY-MM-DD
CREATE TABLE IF NOT EXISTS player_daily_awards (
    player_id TEXT NOT NULL,
    date TEXT NOT NULL,
    total_micros INTEGER NOT NULL DEFAULT 0 CHECK(total_micros >= 0),
    PRIMARY KEY (player_id, date)
);

-- ─── Seed: ppq.ai provider ──────────────────────────────────────────
INSERT OR IGNORE INTO providers (id, display_name, enabled, credit_rate, min_redemption, max_redemption)
VALUES ('ppq', 'ppq.ai', 1, 1000, 100, 100000);
