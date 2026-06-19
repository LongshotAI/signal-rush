-- economy/migrations/001-add-telegram-id.sql
-- Signal Rush — Add Telegram ID to players table
--
-- Links Telegram users to player accounts via their Telegram user ID.
-- The telegram_id is unique to prevent one Telegram account from being
-- linked to multiple players.

ALTER TABLE players ADD COLUMN telegram_id TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_players_telegram_id ON players(telegram_id);
