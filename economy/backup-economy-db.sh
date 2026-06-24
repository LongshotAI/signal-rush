#!/usr/bin/env bash
# backup-economy-db.sh — Nightly backup of Signal Rush economy database.
#
# Add to crontab:
#   0 3 * * * /home/hive/signal-rush/economy/backup-economy-db.sh >> /home/hive/.signal-rush/backup.log 2>&1
#
# Keeps 14 days of backups (compressed) in ~/.signal-rush/backups/
# Safe to run while the economy service is up (uses SQLite .backup command for hot backup).

set -euo pipefail

DB_PATH="${ECONOMY_DB:-/home/hive/.signal-rush/economy.db}"
BACKUP_DIR="${HOME}/.signal-rush/backups"
DATE="$(date -u +%Y%m%dT%H%M%SZ)"
RETENTION_DAYS=14

if [ ! -f "$DB_PATH" ]; then
  echo "[backup] ERROR: DB not found at $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# Use SQLite's online backup for hot backup (no need to stop service)
# Falls back to file copy if sqlite3 CLI not available.
BACKUP_FILE="$BACKUP_DIR/economy-${DATE}.db"

if command -v sqlite3 >/dev/null 2>&1; then
  # Hot backup — safe while service is running
  sqlite3 "$DB_PATH" ".timeout 5000" ".backup '$BACKUP_FILE'"
  echo "[backup] Hot backup created via sqlite3: $BACKUP_FILE"
else
  # Fallback — copy file (less safe but works)
  cp -p "$DB_PATH" "$BACKUP_FILE"
  echo "[backup] File copy backup: $BACKUP_FILE"
fi

# Verify backup integrity BEFORE compressing (sqlite3 can't read gzipped files).
if command -v sqlite3 >/dev/null 2>&1; then
  INTEGRITY=$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" 2>&1 || echo "CHECK_FAILED")
  if [ "$INTEGRITY" = "ok" ]; then
    echo "[backup] Integrity check: OK"
  else
    echo "[backup] WARNING: Integrity check returned: $INTEGRITY" >&2
  fi
fi

# Compress to save space
gzip -f "$BACKUP_FILE"
BACKUP_FILE="${BACKUP_FILE}.gz"

# Report size
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[backup] Size: $SIZE"

# Prune old backups
PRUNED=$(find "$BACKUP_DIR" -name "economy-*.db.gz" -mtime +$RETENTION_DAYS -delete -print | wc -l)
echo "[backup] Pruned $PRUNED backup(s) older than $RETENTION_DAYS days"

echo "[backup] OK — $BACKUP_FILE"