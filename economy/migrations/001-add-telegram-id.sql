-- economy/migrations/001-add-telegram-id.sql
-- Signal Rush — Add Telegram ID to players table
--
-- Links Telegram users to player accounts via their Telegram user ID.
-- SQLite doesn't support ALTER TABLE ADD COLUMN with UNIQUE, so we
-- recreate the table with the new column.

BEGIN TRANSACTION;

-- Create new table with telegram_id column
CREATE TABLE IF NOT EXISTS players_new (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Anonymous',
  telegram_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  total_earned INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  balance INTEGER NOT NULL DEFAULT 0
);

-- Copy existing data
INSERT OR IGNORE INTO players_new (id, display_name, created_at, total_earned, total_spent, balance)
SELECT id, display_name, created_at, total_earned, total_spent, balance FROM players;

-- Drop old table and rename
DROP TABLE players;
ALTER TABLE players_new RENAME TO players;

-- Create index for fast telegram_id lookups
CREATE INDEX IF NOT EXISTS idx_players_telegram_id ON players(telegram_id);

COMMIT;
