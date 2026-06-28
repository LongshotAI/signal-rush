-- Migration: Add idempotency_key to reward_claims
-- Prevents duplicate claim submissions from replay attacks

ALTER TABLE reward_claims ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_claims_idempotency ON reward_claims(idempotency_key, player_id) WHERE idempotency_key IS NOT NULL;
