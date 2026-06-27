-- economy/migrations/004-add-vmco-sub-key.sql
-- Signal Rush — Add VMCO sub-key columns to players table + claim_audit log
--
-- Stores the per-player VMCO sub-API-key so Signal Rush can top it up
-- when the player claims more rewards. The sub-key itself is a portable
-- Bearer token the player can paste into their own agent/harness.
--
-- claim_audit tracks every claim attempt (success, failure, rate-limit)
-- for forensic reconciliation — silently no-ops if table is absent.

ALTER TABLE players ADD COLUMN vmco_sub_key TEXT;
ALTER TABLE players ADD COLUMN vmco_sub_key_id TEXT;
ALTER TABLE players ADD COLUMN vmco_sub_key_created_at TEXT;
ALTER TABLE players ADD COLUMN vmco_sub_key_budget_credits INTEGER;

CREATE INDEX IF NOT EXISTS idx_players_vmco_sub_key_id ON players(vmco_sub_key_id);

CREATE TABLE IF NOT EXISTS claim_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id       TEXT,
  provider        TEXT NOT NULL DEFAULT 'vmco',
  amount_micros    INTEGER NOT NULL DEFAULT 0,
  result          TEXT NOT NULL DEFAULT 'unknown',
  reason          TEXT,
  claim_id        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);