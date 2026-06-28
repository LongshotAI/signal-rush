#!/usr/bin/env node
// migrate.js — Apply pending SQL migrations to the economy DB.
//
// Usage:
//   node economy/migrate.js                    # uses default DB path
//   ECONOMY_DB=path/to.db node economy/migrate.js
//
// Reads .sql files from economy/migrations/ in lexicographic order, applies
// each one inside a transaction, and records it in schema_migrations.
// Safe to run repeatedly — already-applied versions are skipped.
//
// IMPORTANT: Migration files must use BEGIN TRANSACTION / COMMIT (or just
// individual statements; this runner wraps them in a transaction).
//
// To author a new migration:
//   1. Create economy/migrations/NNN-short-name.sql with your DDL
//   2. Run this script. The new row appears in schema_migrations.
//   3. ALSO update schema.sql for fresh databases (the "if not exists" pattern).

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DEFAULT_DB = path.join(process.env.HOME || '/root', '.signal-rush', 'economy.db');
const DB_PATH = process.env.ECONOMY_DB || DEFAULT_DB;

console.log(`[migrate] Database: ${DB_PATH}`);

// 1. Ensure schema_migrations table exists
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 2. Get applied versions
const applied = new Set(
  db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
);
console.log(`[migrate] Already applied: ${[...applied].join(', ') || '(none)'}`);

// 3. Discover migration files
const files = fs.readdirSync(MIGRATIONS_DIR)
  .filter(f => f.endsWith('.sql'))
  .sort();
console.log(`[migrate] Found ${files.length} migration file(s)`);

// 4. Apply pending migrations in order
let appliedCount = 0;
for (const file of files) {
  // Version = filename prefix before first '-': '001-add-telegram-id.sql' → '001'
  const version = file.split('-')[0];
  if (applied.has(version)) {
    console.log(`[migrate]   [skip] ${file} (already applied)`);
    continue;
  }
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  const description = file.replace(/^\d+-/, '').replace(/\.sql$/, '').replace(/-/g, ' ');
  console.log(`[migrate]   [apply] ${file} — ${description}`);
  try {
    db.transaction(() => {
      // Remove transaction wrappers from the SQL since we're already in one
      const cleanSql = sql.replace(/^\s*BEGIN TRANSACTION;\s*$/gim, '').replace(/^\s*COMMIT;\s*$/gim, '');
      db.exec(cleanSql);
      db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(version, description);
    })();
    appliedCount++;
  } catch (err) {
    console.error(`[migrate]   [FAIL] ${file}: ${err.message}`);
    console.error(`[migrate] Aborting — fix the migration and re-run. Already-applied migrations were committed atomically.`);
    db.close();
    process.exit(1);
  }
}

console.log(`[migrate] Done — ${appliedCount} migration(s) applied`);
db.close();
process.exit(0);