-- economy/migrations/002-add-player-session-token.sql
-- Signal Rush — Add session token columns to players table
--
-- Persists Telegram auth session tokens so they survive server restarts.
-- Also adds last_login_at for tracking active players.

BEGIN TRANSACTION;

ALTER TABLE players ADD COLUMN session_token TEXT;
ALTER TABLE players ADD COLUMN session_created_at TEXT;
ALTER TABLE players ADD COLUMN last_login_at TEXT;

CREATE INDEX IF NOT EXISTS idx_players_session_token ON players(session_token);

COMMIT;
