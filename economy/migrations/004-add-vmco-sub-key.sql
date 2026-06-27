-- economy/migrations/003-add-vmco-sub-key.sql
-- Signal Rush — Add VMCO sub-key columns to players table
--
-- Stores the per-player VMCO sub-API-key so Signal Rush can top it up
-- when the player claims more rewards. The sub-key itself is a portable
-- Bearer token the player can paste into their own agent/harness.

ALTER TABLE players ADD COLUMN vmco_sub_key TEXT;
ALTER TABLE players ADD COLUMN vmco_sub_key_id TEXT;
ALTER TABLE players ADD COLUMN vmco_sub_key_created_at TEXT;
ALTER TABLE players ADD COLUMN vmco_sub_key_budget_credits INTEGER;

CREATE INDEX IF NOT EXISTS idx_players_vmco_sub_key_id ON players(vmco_sub_key_id);